/**
 * Pure logic for the FAQ / Payment Code app — no Airtable calls, so it can be
 * tested on its own. Ported from the Payment Code & FAQ Chrome extension (v2.3),
 * keeping its command syntax and output so BMs' habits carry over, with the
 * bugs found in the September audit fixed. Each fix is noted where it lives.
 */

/** FAQ-driven templates: content comes from the trip's FAQ record, not the booking. */
export const FAQ_TEMPLATES = ['RESTS', 'RESPS', 'HARTS', 'HARPS'];

/**
 * Turn what the BM typed into a command.
 *
 *   HELP                 -> help
 *   CODE.<text>          -> search trips by name
 *   FAQ.<FIELD>          -> the shared FAQ record's field
 *   <PAYCODE>            -> list templates for that booking
 *   <PAYCODE>.<TEMPLATE> -> a booking template, or a FAQ template for its trip
 *   <TRIPCODE>.<FIELD>   -> a trip's FAQ field (tried when no booking matches)
 */
export function parseCommand(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  if (raw.toUpperCase() === 'HELP') return { type: 'help' };

  const dot = raw.indexOf('.');
  const code = (dot === -1 ? raw : raw.slice(0, dot)).trim().toUpperCase();
  // Everything after the first dot. The extension split on every dot, so a
  // trip search like "CODE.St. Petersburg" lost everything after "St".
  const rest = dot === -1 ? '' : raw.slice(dot + 1).trim();

  if (!code) return null;
  if (code === 'CODE') return rest ? { type: 'trip-search', text: rest } : null;

  return { type: 'code', code, field: rest ? rest.toUpperCase() : null };
}

/**
 * Airtable formula string literal. The extension interpolated codes straight
 * into formulas, so a stray quote broke the query and failed as "not found".
 */
export function formulaString(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** Plain display value for any Airtable cell shape. Never raw JSON. */
export function cellText(value) {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.map(cellText).filter(Boolean).join(', ');
  if (typeof value === 'object') {
    // AI fields arrive as { state, value, isStale }.
    if ('state' in value || 'isStale' in value) return typeof value.value === 'string' ? value.value : '';
    return value.name || value.email || value.url || '';
  }
  return String(value);
}

/**
 * Fill {{Field}} and {{Field - Other}} placeholders from the merged records.
 *
 * `knownFields` is every field name in the three tables. Airtable leaves empty
 * fields out of API responses entirely, so a field that exists but is absent
 * from the record is an intentional blank (e.g. Discount Text for a guest with
 * no discount), not a typo.
 *
 * Returns the filled HTML and the placeholders that could not be filled, so
 * the panel can warn before anyone sends "{{Display Name}}" to a guest.
 */
export function fillPlaceholders(content, mergedFields, knownFields = new Set()) {
  const unresolved = new Set();

  const has = (name) => mergedFields[name] !== undefined || knownFields.has(name);
  const valueOf = (name) => (mergedFields[name] !== undefined ? cellText(mergedFields[name]) : '');

  const html = String(content || '').replace(/\{\{([^}]+)\}\}/g, (match, expression) => {
    const name = expression.trim();

    // A real field name wins before any arithmetic is attempted. The extension
    // tried arithmetic first, so {{D-Future-Trip-Tags}} was read as a
    // subtraction and any field with a hyphen or slash was unusable.
    if (has(name)) return valueOf(name);

    const calc = name.match(/^(.+?)\s*([+\-*/])\s*(.+)$/);
    if (calc) {
      const [, leftName, operator, rightName] = calc;
      const left = operand(leftName.trim());
      // A missing right-hand side counts as 0 — documented behaviour, so an
      // empty Discount leaves the deposit total unchanged.
      const right = operand(rightName.trim()) ?? 0;

      if (left !== null) return formatNumber(calculate(left, operator, right));
    }

    unresolved.add(name);
    return match;
  });

  function operand(token) {
    if (/^-?\d+(\.\d+)?$/.test(token)) return Number(token);
    if (!has(token)) return null;
    const number = parseFloat(String(valueOf(token)).replace(/[$,\s]/g, ''));
    return Number.isNaN(number) ? null : number;
  }

  return { html, unresolved: [...unresolved] };
}

function calculate(left, operator, right) {
  switch (operator) {
    case '+': return left + right;
    case '-': return left - right;
    case '*': return left * right;
    // Division by zero keeps the left side, matching the extension's
    // missing-field behaviour rather than printing Infinity to a guest.
    case '/': return right !== 0 ? left / right : left;
    default: return left;
  }
}

/** Rounds away float noise (0.1 + 0.2) without padding whole amounts. */
function formatNumber(value) {
  return String(Number(value.toFixed(2)));
}

/**
 * Transformations the extension applied at copy time, reproduced exactly so
 * pasted emails look the same as before the move. Applied before preview now,
 * so what the BM reads is what they paste.
 */
const EMOJI = {
  ':world_map:': '🗺️',
  ':calendar:': '📅',
  ':point_right:': '👉',
  ':muscle:': '💪',
  ':question:': '❓',
  ':handbag:': '👜',
  ':sunny:': '☀️',
  ':mag:': '🔍',
  ':bulb:': '💡',
  ':airplane:': '✈️',
  ':star:': '⭐',
};

export function formatForPaste(content) {
  let html = String(content || '');

  for (const [code, emoji] of Object.entries(EMOJI)) {
    html = html.split(code).join(emoji);
  }

  return html
    .replace(/\{AUT:\s*([^}]+)\}/g, '<strong>$1</strong>')
    .replace(/(<div style="[^"]*background-color:[^"]*">)/g, '<br>$1')
    .replace(/(🗺️|📅|👉|💪|❓|👜|☀️|🔍|💡)/g, '<br><br>$1')
    .replace(/(<strong>[^<]*[🗺️📅👉💪❓👜☀️🔍💡][^<]*<\/strong>)/g, '<br><h3 style="font-size: 18px; font-weight: bold; margin: 15px 0 10px 0;">$1</h3>')
    .replace(/(<\/div>\s*<br>\s*<div style="[^"]*background-color:#f8f9fa[^"]*">)/g, '</div><hr style="border: none; border-top: 1px solid #e0e0e0; margin: 20px 0;">$1')
    .replace(/(<\/div>\s*<br>\s*<div style="[^"]*background-color:#fff3cd[^"]*">)/g, '</div><hr style="border: none; border-top: 1px solid #e0e0e0; margin: 20px 0;">$1')
    .replace(/☑/g, '☑ ')
    .replace(/(<br>\s*){4,}/g, '<br><br><br>');
}

/**
 * Which fields on a booking are email templates, for the chips shown when a
 * BM enters a bare payment code. Template fields are short uppercase codes
 * (CONF, PRIDEP, FINAL) holding HTML; nothing else on the table looks like
 * that. Replaces the extension's hard-coded example list, which offered
 * templates a booking might not have.
 */
export function listTemplateFields(fields) {
  return Object.entries(fields || {})
    .filter(([name, value]) => /^[A-Z][A-Z0-9]{2,11}$/.test(name)
      && typeof value === 'string'
      && /<(p|br|strong|b|h\d|ul|div)\b/i.test(value))
    .map(([name]) => name)
    .sort();
}

/** Distinct trip codes, preserving order. Lookups arrive as arrays. */
export function tripCodes(value) {
  const list = Array.isArray(value) ? value : [value];
  return [...new Set(list.map((item) => cellText(item).trim().toUpperCase()).filter(Boolean))];
}

/**
 * Which trip's FAQ content applies to a payment code.
 *
 * The extension took the first trip on the lead. Leads with several future
 * interests link several trips, and Airtable's order is arbitrary — the
 * likely cause of a Morocco reservation email arriving with Philippines
 * content. Now it only picks when the answer is unambiguous: one trip across
 * lead and booking, or a booking whose trip is one of the lead's. Anything
 * else — including a lead and booking that disagree — goes to the BM.
 */
export function resolveTrip({ leadTrips, bookingTrips, chosen }) {
  const lead = tripCodes(leadTrips);
  const booking = tripCodes(bookingTrips);
  const candidates = [...new Set([...lead, ...booking])];

  if (chosen) {
    const pick = String(chosen).trim().toUpperCase();
    return candidates.includes(pick) ? { trip: pick } : { choices: candidates };
  }

  if (candidates.length === 0) return { trip: null };
  if (candidates.length === 1) return { trip: candidates[0] };
  if (booking.length === 1 && lead.includes(booking[0])) return { trip: booking[0] };
  return { choices: candidates };
}
