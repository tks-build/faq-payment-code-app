import HelpScout from '@helpscout/javascript-sdk';
import { DefaultStyle, Spinner, useSetAppHeight } from '@helpscout/ui-kit';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * FAQ / Payment Code — the Payment Code & FAQ Chrome extension as its own
 * Help Scout sidebar app.
 *
 * Same commands BMs already type (LOULAU2531.CONF, FAQ.RESTS, CODE.morocco,
 * HELP), plus the guest's own live payment codes as buttons, read from the
 * conversation's email address.
 *
 * Separate from the guest panel by design: its own repo, deploy and Airtable
 * token. Airtable is only ever reached through /api/templates; no credential
 * reaches the browser.
 */

/**
 * The guest panel fires its own burst of Airtable requests when a
 * conversation opens, against the same base, which is capped at 5 requests
 * per second across every app using it. Waiting a moment before fetching this
 * guest's codes keeps the two apps from colliding; the buttons still arrive
 * before anyone reaches for them.
 */
const SUGGESTION_DELAY_MS = 1500;
const TYPING_DEBOUNCE_MS = 600;

function App() {
  const appRef = useSetAppHeight();
  const [emailQuery, setEmailQuery] = useState('');
  const [codes, setCodes] = useState(null);
  const [input, setInput] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestSeq = useRef(0);
  const lastQuery = useRef('');

  useEffect(() => {
    // Local testing without Help Scout: /?email=guest@example.com
    const localEmail = new URLSearchParams(window.location.search).get('email');
    if (localEmail) {
      setEmailQuery(localEmail.trim().toLowerCase());
      return undefined;
    }

    let active = true;
    const apply = (context) => {
      if (active) setEmailQuery(getCustomerEmails(context?.customer).join(','));
    };

    HelpScout.getApplicationContext().then(apply).catch(() => apply(null));
    const unsubscribe = HelpScout.watchApplicationContext?.(apply);

    return () => {
      active = false;
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, []);

  // A new guest clears everything. The extension restored the last template
  // for an hour, so a BM could paste the previous guest's email by mistake.
  useEffect(() => {
    requestSeq.current += 1;
    lastQuery.current = '';
    setInput('');
    setResult(null);
    setError('');
    setLoading(false);
    setCodes(null);

    if (!emailQuery) return undefined;

    let active = true;
    const timer = setTimeout(() => {
      fetchJson(`/api/templates?${new URLSearchParams({ email: emailQuery })}`)
        .then((body) => active && setCodes(body.codes || []))
        // Suggestions are a convenience. If they fail, typing still works.
        .catch(() => active && setCodes([]));
    }, SUGGESTION_DELAY_MS);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [emailQuery]);

  const run = useCallback((query, trip = '') => {
    const q = String(query || '').trim();
    if (!q) return;

    const seq = ++requestSeq.current;
    // The trip is deliberately left out: after a BM picks one, the input
    // still holds the same command, and that must not trigger a re-run
    // without the trip.
    lastQuery.current = q.toUpperCase();
    setLoading(true);
    setError('');

    const params = new URLSearchParams({ q });
    if (trip) params.set('trip', trip);

    fetchJson(`/api/templates?${params}`)
      .then((body) => {
        if (seq !== requestSeq.current) return;
        setResult(body);
      })
      .catch((lookupError) => {
        if (seq !== requestSeq.current) return;
        setResult(null);
        setError(lookupError.message);
      })
      .finally(() => {
        if (seq === requestSeq.current) setLoading(false);
      });
  }, []);

  // Runs by itself once the input looks like a whole command — a code plus a
  // template, or HELP. A bare code waits for Enter, so typing a code does not
  // fire a lookup at every pause.
  useEffect(() => {
    const q = input.trim();
    const complete = /^[^.]+\.[^.\s]{2,}/.test(q) || q.toUpperCase() === 'HELP';
    if (!complete || lastQuery.current === q.toUpperCase()) return undefined;

    const timer = setTimeout(() => run(q), TYPING_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [input, run]);

  const choose = (query, trip = '') => {
    setInput(query);
    run(query, trip);
  };

  const clear = () => {
    requestSeq.current += 1;
    lastQuery.current = '';
    setInput('');
    setResult(null);
    setError('');
    setLoading(false);
  };

  return (
    <main className="app" ref={appRef}>
      <DefaultStyle />

      <GuestCodes codes={codes} hasEmail={Boolean(emailQuery)} onPick={(code) => choose(code)} />

      <form
        className="tplSearch"
        onSubmit={(event) => {
          event.preventDefault();
          run(input);
        }}
      >
        <input
          aria-label="Template code"
          autoComplete="off"
          className="tplInput"
          onChange={(event) => setInput(event.target.value)}
          placeholder="e.g. LOULAU2531.CONF"
          spellCheck={false}
          type="text"
          value={input}
        />
        {input ? (
          <button aria-label="Clear" className="tplClear" onClick={clear} title="Clear" type="button">
            ✕
          </button>
        ) : null}
      </form>

      {loading ? (
        <div className="tplStatus">
          <Spinner /> Looking up…
        </div>
      ) : error ? (
        <div className="tplStatus tplStatusError">{error}</div>
      ) : result ? (
        <Result result={result} onRun={choose} />
      ) : (
        <p className="tplHint">
          {codes?.length ? 'Pick a code above, or type one.' : 'Type a payment code, then Enter.'}{' '}
          <button className="tplLinkButton" onClick={() => choose('HELP')} type="button">All commands</button>
        </p>
      )}
    </main>
  );
}

function GuestCodes({ codes, hasEmail, onPick }) {
  if (!hasEmail) return null;
  if (codes === null) return <div className="tplGuestCodes tplMuted">Finding this guest’s codes…</div>;
  if (!codes.length) return <div className="tplGuestCodes tplMuted">No open bookings or leads for this guest.</div>;

  return (
    <div className="tplGuestCodes">
      <span className="label">This guest</span>
      <div className="tplCodeList">
        {codes.map((item) => (
          <button className="tplCode" key={item.code} onClick={() => onPick(item.code)} type="button">
            <span className="tplCodeValue">{item.code}</span>
            <span className="tplCodeMeta">
              {[item.trip, item.kind === 'lead' ? 'Lead' : item.start].filter(Boolean).join(' · ')}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Result({ result, onRun }) {
  const { kind, title, subtitle, message } = result;

  return (
    <section className="tplResult">
      <header className="tplResultHead">
        <span className="tplResultTitle">{title}</span>
        {subtitle ? <span className="tplResultSub">{subtitle}</span> : null}
      </header>

      {message ? <p className={kind === 'not-found' ? 'tplMessage tplMessageMiss' : 'tplMessage'}>{message}</p> : null}

      {kind === 'choose-trip' ? (
        <ChipRow items={result.choices} onPick={(trip) => onRun(title, trip)} />
      ) : null}

      {result.templates?.length ? (
        <ChipGroup label="Booking" items={result.templates} onPick={(name) => onRun(`${result.code}.${name}`)} />
      ) : null}
      {result.faqTemplates?.length ? (
        <ChipGroup label="Trip FAQ" items={result.faqTemplates} onPick={(name) => onRun(`${result.code}.${name}`)} />
      ) : null}

      {kind === 'template' || kind === 'help' ? <Template result={result} copyable={kind === 'template'} /> : null}
    </section>
  );
}

function ChipGroup({ label, items, onPick }) {
  return (
    <div className="tplChipGroup">
      <span className="label">{label}</span>
      <ChipRow items={items} onPick={onPick} />
    </div>
  );
}

function ChipRow({ items, onPick }) {
  return (
    <div className="tplChipRow">
      {items.map((item) => (
        <button className="tplChip" key={item} onClick={() => onPick(item)} type="button">
          {item}
        </button>
      ))}
    </div>
  );
}

function Template({ result, copyable }) {
  const previewRef = useRef(null);
  const [copyState, setCopyState] = useState('');
  const html = sanitizeHtml(result.html || '');
  const unresolved = result.unresolved || [];

  useEffect(() => setCopyState(''), [result]);

  const copy = async () => {
    const outcome = await copyRich(html, htmlToText(html), previewRef.current);
    setCopyState(outcome);
    if (outcome === 'rich') notify('SUCCESS', 'Template copied');
    if (outcome !== 'failed') setTimeout(() => setCopyState(''), 2500);
  };

  return (
    <>
      {unresolved.length ? (
        <div className="tplWarning">
          <strong>Not filled in — fix or delete before sending:</strong>{' '}
          {unresolved.map((name) => `{{${name}}}`).join(', ')}
          {result.fieldListAvailable === false ? (
            <span className="tplWarningNote">
              The field list couldn’t be loaded, so some of these may just be empty fields.
            </span>
          ) : null}
        </div>
      ) : null}

      {copyable ? (
        <button className="primaryButton tplCopy" onClick={copy} type="button">
          {copyState === 'rich' ? '✓ Copied' : copyState === 'plain' ? '✓ Copied (plain text)' : 'Copy template'}
        </button>
      ) : null}
      {copyState === 'plain' ? (
        <p className="tplMessage tplMessageMiss">Formatting couldn’t be copied in this browser, so bold and headings are lost. Tell Kat.</p>
      ) : null}
      {copyState === 'failed' ? (
        <p className="tplMessage tplMessageMiss">Couldn’t copy. Select the text below and copy it by hand.</p>
      ) : null}

      <div
        className="tplPreview"
        dangerouslySetInnerHTML={{ __html: html }}
        onClick={openLinksOutside}
        ref={previewRef}
      />
    </>
  );
}

// ------------------------------------------------------------------ helpers

async function fetchJson(url) {
  const response = await fetch(url);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error([body.error, body.details].filter(Boolean).join(': ') || 'Template lookup failed.');
  }
  return body;
}

/**
 * Copy with formatting intact, trying three routes in order.
 *
 * 1. execCommand('copy') with our own copy handler. Synchronous inside the
 *    click, and works in a cross-origin iframe without any permission.
 * 2. The async Clipboard API — only works if Help Scout's iframe grants
 *    clipboard-write, which it may not.
 * 3. Help Scout's own clipboard bridge. Plain text only, so it is the last
 *    resort and the button says so.
 *
 * The extension's fallback put the HTML into a textarea, which pasted raw
 * <p> tags into the email.
 */
async function copyRich(html, text, node) {
  let handled = false;
  const onCopy = (event) => {
    event.clipboardData.setData('text/html', html);
    event.clipboardData.setData('text/plain', text);
    event.preventDefault();
    handled = true;
  };

  const selection = window.getSelection();
  document.addEventListener('copy', onCopy);
  try {
    // Some browsers only fire the copy event when something is selected.
    if (node && selection) {
      const range = document.createRange();
      range.selectNodeContents(node);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    document.execCommand('copy');
  } catch {
    // Fall through to the next route.
  } finally {
    document.removeEventListener('copy', onCopy);
    selection?.removeAllRanges();
  }
  if (handled) return 'rich';

  try {
    if (navigator.clipboard && window.ClipboardItem) {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' }),
        }),
      ]);
      return 'rich';
    }
  } catch {
    // Fall through.
  }

  if (HelpScout.setClipboardText) {
    HelpScout.setClipboardText(text, 'Copied as plain text');
    return 'plain';
  }

  return 'failed';
}

function notify(type, text) {
  try {
    HelpScout.showNotification?.(type, text);
  } catch {
    // Outside Help Scout there is no host to notify.
  }
}

/**
 * Templates are written in Airtable by staff, but they are still rendered
 * into this page, so anything executable is stripped first.
 */
const BLOCKED_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'BASE', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT']);

function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  for (const element of [...doc.body.querySelectorAll('*')]) {
    if (BLOCKED_TAGS.has(element.tagName)) {
      element.remove();
      continue;
    }
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const unsafeUrl = ['href', 'src', 'xlink:href', 'action', 'formaction'].includes(name)
        && /^\s*(javascript|vbscript):/i.test(attribute.value);
      if (name.startsWith('on') || unsafeUrl) element.removeAttribute(attribute.name);
    }
  }
  return doc.body.innerHTML;
}

/** Plain-text flavour for the clipboard, keeping paragraphs and lists readable. */
function htmlToText(html) {
  const marked = html
    .replace(/<hr[^>]*>/gi, '\n─────────────────────────────────\n')
    .replace(/<h[1-6][^>]*>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<\/li>/gi, '\n');
  const doc = new DOMParser().parseFromString(`<body>${marked}</body>`, 'text/html');
  return (doc.body.textContent || '').replace(/\n\s*\n\s*\n/g, '\n\n').trim();
}

/** A link clicked in the preview would otherwise navigate the sidebar iframe away. */
function openLinksOutside(event) {
  const link = event.target.closest?.('a[href]');
  if (!link) return;
  event.preventDefault();
  window.open(link.href, '_blank', 'noopener');
}

function getCustomerEmails(customer) {
  if (!customer) return [];
  const emails = [];
  if (typeof customer.email === 'string') emails.push(customer.email);
  for (const item of customer.emails || []) {
    if (typeof item === 'string') emails.push(item);
    if (typeof item?.value === 'string') emails.push(item.value);
    if (typeof item?.email === 'string') emails.push(item.email);
  }
  return [...new Set(emails.map((email) => email.trim().toLowerCase()).filter(Boolean))];
}

export default App;
