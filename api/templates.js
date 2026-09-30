/**
 * Email templates for the FAQ / Payment Code sidebar app — the Payment Code &
 * FAQ Chrome extension, moved server-side.
 *
 * The extension carried an Airtable token in every BM's copy of popup.js, and
 * each fix meant every BM reloading an unpacked folder by hand (the cause of
 * the "returned" Philippines bug and the September outage). Here the token
 * stays in Vercel and there is one deployed version.
 *
 *   GET /api/templates?q=LOULAU2531.CONF   run a command, same syntax as before
 *   GET /api/templates?q=...&trip=DREVUX   ...with the trip the BM picked
 *   GET /api/templates?email=a@b.com       this guest's live payment codes
 *
 * Read-only. Nothing here writes to Airtable.
 */

import Airtable from 'airtable';
import {
  FAQ_TEMPLATES,
  cellText,
  fillPlaceholders,
  formatForPaste,
  formulaString,
  listTemplateFields,
  parseCommand,
  resolveTrip,
} from '../lib/templateRender.js';

/**
 * Only the token is required. Base and table IDs are not secret, so they
 * default to the ones the extension used; Airtable also accepts a table's
 * name in place of its ID, which is how Customers is found.
 */
const {
  AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID = 'appnRSV0g89whVidp',
  TABLE_BOOKINGS = 'tblntsVYlf0hfuWnI',
  TABLE_BOOKING_CRM = 'tblu9Oa6PaPvj2eVJ',
  TABLE_FAQ = 'tblkB560BHZShTJkh',
  TABLE_CUSTOMERS = 'Customers',
  AIRTABLE_CUSTOMERS_EMAIL_FIELD = 'Client Email',
} = process.env;

/** Every Airtable field name this route reads, in one place. */
const FIELDS = {
  booking: {
    paymentCode: 'Payment Code',
    crmLink: 'Booking CRM',
    tripCode: 'Trip Code (from Trip)',
    cancelled: 'Cancelled',
    startDate: 'Trip Start Date',
    endDate: 'AUT: Trip End Date',
  },
  lead: {
    paymentCode: 'Payment Code',
    tripCodes: 'Trip Code (from Trips)',
    status: 'Status',
    startDate: 'Trip Start Date',
  },
  faq: {
    code: 'FAQCode',
    trips: 'Trips',
    tripCode: 'COD',
    tripName: 'STA',
  },
  customer: {
    bookings: 'Bookings',
    leads: 'Booking CRM',
  },
};

/** Matches api/airtable.js — closed leads are not offered as codes. */
const CLOSED_LEAD_STATUSES = ['Closed Come Back', 'Closed Lost'];
/** Converted leads are skipped too: their booking carries the same code. */
const CONVERTED_LEAD_STATUSES = ['Done'];

const MAX_SUGGESTIONS = 8;

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'Method Not Allowed' });
  }

  if (!AIRTABLE_API_KEY) {
    return sendJson(res, 500, { error: 'AIRTABLE_API_KEY is not set in Vercel' });
  }

  const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);

  try {
    if (req.query.email) {
      const codes = await suggestCodes(base, String(req.query.email));
      return sendJson(res, 200, { codes });
    }

    const command = parseCommand(req.query.q);
    if (!command) {
      return sendJson(res, 400, { error: 'Missing q or email query parameter' });
    }

    const result = await runCommand(base, command, req.query.trip ? String(req.query.trip) : '');
    return sendJson(res, 200, result);
  } catch (error) {
    console.error('Template lookup failed', getErrorMessage(error));
    return sendJson(res, 500, { error: 'Template lookup failed', details: getErrorMessage(error) });
  }
}

// ------------------------------------------------------------------ commands

async function runCommand(base, command, chosenTrip) {
  if (command.type === 'help') return helpResult();
  if (command.type === 'trip-search') return searchTrips(base, command.text);

  const { code, field } = command;

  // FAQ.<FIELD> reads the shared FAQ record. Falls through if that record
  // lacks the field, exactly as the extension did.
  if (code === 'FAQ' && field) {
    const shared = await faqFieldResult(base, 'FAQ', field);
    if (shared) return shared;
  }

  const booking = await findBooking(base, code);

  if (field && FAQ_TEMPLATES.includes(field)) {
    return faqTemplate(base, { code, field, booking, chosenTrip });
  }

  if (booking) {
    return field ? bookingTemplate(base, { code, field, booking }) : bookingOptions(code, booking);
  }

  if (!field) {
    // A lead can hold a payment code before any booking exists — the
    // reservation emails are sent at that stage.
    const lead = await findLead(base, code, null);
    if (lead) return leadOptions(code, lead);
    return notFound(code, `No booking or lead found for ${code}.`);
  }

  // Not a payment code: try it as a trip code, e.g. DREVUX.STA.
  const tripField = await faqFieldResult(base, code, field);
  return tripField || notFound(`${code}.${field}`, `No records found for code: ${code}.`);
}

async function faqTemplate(base, { code, field, booking, chosenTrip }) {
  const lead = await findLead(base, code, booking);
  if (!lead && !booking) {
    return notFound(`${code}.${field}`, `No booking or lead found for ${code}.`);
  }

  const { trip, choices } = resolveTrip({
    leadTrips: lead?.fields[FIELDS.lead.tripCodes],
    bookingTrips: booking?.fields[FIELDS.booking.tripCode],
    chosen: chosenTrip,
  });

  if (choices) {
    return {
      kind: 'choose-trip',
      title: `${code}.${field}`,
      message: 'This code is linked to more than one trip. Which one is this email for?',
      choices,
    };
  }

  if (!trip) {
    return notFound(`${code}.${field}`, `Could not work out which trip ${code} is for.`);
  }

  const faq = await findFaqRecord(base, trip);
  const content = faq?.fields[field];
  if (!content) {
    return notFound(`${code}.${field}`, `No ${field} content found for trip ${trip}.`);
  }

  // Later sources win: FAQ, then lead, then booking — the extension's order.
  const merged = { ...faq.fields, ...(lead?.fields || {}), ...(booking?.fields || {}) };
  return templateResult({ title: `${code}.${field}`, subtitle: `Trip ${trip}`, content, merged, trip });
}

async function bookingTemplate(base, { code, field, booking }) {
  const content = booking.fields[field];
  if (!content) {
    return {
      ...notFound(`${code}.${field}`, `Template "${field}" not found for this booking.`),
      templates: listTemplateFields(booking.fields),
      faqTemplates: FAQ_TEMPLATES,
      code,
    };
  }

  // Booking templates are assembled by Airtable, so they rarely contain
  // {{placeholders}}. Only fetch the lead when one is actually present — every
  // request counts against the base's 5-per-second cap.
  const needsLead = String(content).includes('{{');
  const lead = needsLead ? await findLead(base, code, booking) : null;
  const merged = { ...(lead?.fields || {}), ...booking.fields };

  return templateResult({
    title: `${code}.${field}`,
    subtitle: tripLabel(booking.fields[FIELDS.booking.tripCode]),
    content,
    merged,
  });
}

async function templateResult({ title, subtitle, content, merged, trip }) {
  const { names, available } = String(content).includes('{{')
    ? await knownFieldNames()
    : { names: new Set(), available: true };
  const { html, unresolved } = fillPlaceholders(content, merged, names);

  return {
    kind: 'template',
    title,
    subtitle,
    trip: trip || null,
    html: formatForPaste(html),
    unresolved,
    // Without the field list, an intentionally empty field is
    // indistinguishable from a misspelt one. The panel says so.
    fieldListAvailable: available,
  };
}

function bookingOptions(code, booking) {
  return {
    kind: 'options',
    title: code,
    subtitle: tripLabel(booking.fields[FIELDS.booking.tripCode]),
    message: 'Booking found. Pick a template.',
    code,
    templates: listTemplateFields(booking.fields),
    faqTemplates: FAQ_TEMPLATES,
  };
}

function leadOptions(code, lead) {
  return {
    kind: 'options',
    title: code,
    subtitle: tripLabel(lead.fields[FIELDS.lead.tripCodes]),
    message: 'Lead found, no booking yet. Trip FAQ templates are available.',
    code,
    templates: [],
    faqTemplates: FAQ_TEMPLATES,
  };
}

async function faqFieldResult(base, faqCode, field) {
  const record = await findFaqRecord(base, faqCode);
  if (!record) return null;

  const content = record.fields[field] || record.fields[field.toUpperCase()] || record.fields[field.toLowerCase()];
  if (!content) return null;

  return {
    kind: 'template',
    title: `${faqCode}.${field}`,
    subtitle: 'FAQ',
    html: formatForPaste(cellText(content)),
    unresolved: [],
    fieldListAvailable: true,
  };
}

async function searchTrips(base, text) {
  const F = FIELDS.faq;
  const records = await base(TABLE_FAQ)
    .select({
      maxRecords: 25,
      filterByFormula: `FIND(LOWER(${formulaString(text)}), LOWER({${F.trips}}))`,
    })
    .firstPage();

  if (!records.length) return notFound(`CODE.${text}`, `No trips found for: ${text}.`);

  const trips = records.map((record) => ({
    code: cellText(record.fields[F.tripCode]),
    name: cellText(record.fields[F.tripName]),
  }));

  return {
    kind: 'template',
    title: `CODE.${text}`,
    subtitle: `${trips.length} trip${trips.length === 1 ? '' : 's'}`,
    html: trips.map((trip) => `<p>${escapeHtml(trip.code)} - ${escapeHtml(trip.name)}</p>`).join(''),
    unresolved: [],
    fieldListAvailable: true,
  };
}

function helpResult() {
  return {
    kind: 'help',
    title: 'HELP',
    html: [
      '<p><strong>PAYMENTCODE</strong> — list the templates for a booking or lead</p>',
      '<p><strong>PAYMENTCODE.CONF</strong> — a booking template (CONF, PRIDEP, FINAL…)</p>',
      '<p><strong>PAYMENTCODE.RESTS</strong> — trip FAQ template (RESTS, RESPS, HARTS, HARPS)</p>',
      '<p><strong>TRIPCODE.FIELD</strong> — a field from a trip\'s FAQ record</p>',
      '<p><strong>FAQ.FIELD</strong> — a field from the shared FAQ record</p>',
      '<p><strong>CODE.text</strong> — search trips by name</p>',
    ].join(''),
  };
}

function notFound(title, message) {
  return { kind: 'not-found', title, message };
}

// ------------------------------------------------------------------ lookups

async function findBooking(base, code) {
  return findOne(base, TABLE_BOOKINGS, `UPPER(TRIM({${FIELDS.booking.paymentCode}})) = ${formulaString(code)}`);
}

/**
 * The lead behind a payment code. Follows the booking's link when there is
 * one — the two tables' Payment Code text fields are typed separately and can
 * drift — and matches on the code otherwise.
 */
async function findLead(base, code, booking) {
  const linkedId = asArray(booking?.fields[FIELDS.booking.crmLink]).find(isRecordId);
  if (linkedId) {
    try {
      return await base(TABLE_BOOKING_CRM).find(linkedId);
    } catch (error) {
      console.warn(`Linked lead ${linkedId} could not be read`, getErrorMessage(error));
    }
  }

  return findOne(base, TABLE_BOOKING_CRM, `UPPER(TRIM({${FIELDS.lead.paymentCode}})) = ${formulaString(code)}`);
}

/**
 * TRIM guards against invisible trailing spaces from copy-paste — the same
 * fault that hid 47 guests from the panel's email lookup, and the leading
 * suspect for DREVUX not being found.
 */
async function findFaqRecord(base, faqCode) {
  return findOne(base, TABLE_FAQ, `UPPER(TRIM({${FIELDS.faq.code}})) = ${formulaString(faqCode)}`);
}

async function findOne(base, table, filterByFormula) {
  const records = await base(table).select({ maxRecords: 1, filterByFormula }).firstPage();
  return records[0] || null;
}

/**
 * Field names across the three template tables, so an intentionally empty
 * field can be told apart from a misspelt placeholder.
 *
 * The extension loaded this without waiting for it, so a fast typist got raw
 * {{placeholders}} back intermittently. Here it is awaited, and cached so a
 * warm function fetches it once every ten minutes rather than per request.
 * Needs the schema.bases:read scope on the token; without it, templates still
 * render and the panel flags every blank placeholder instead.
 */
let fieldNameCache = null;
let fieldNameCacheExpiry = 0;

async function knownFieldNames() {
  const now = Date.now();
  if (fieldNameCache && now < fieldNameCacheExpiry) return fieldNameCache;

  try {
    const response = await fetch(`https://api.airtable.com/v0/meta/bases/${AIRTABLE_BASE_ID}/tables`, {
      headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` },
    });
    if (!response.ok) throw new Error(`Airtable schema request returned ${response.status}`);

    const { tables = [] } = await response.json();
    const wanted = new Set([TABLE_BOOKINGS, TABLE_BOOKING_CRM, TABLE_FAQ]);
    const names = new Set(
      tables.filter((table) => wanted.has(table.id) || wanted.has(table.name)).flatMap((table) => table.fields.map((field) => field.name)),
    );

    fieldNameCache = { names, available: true };
    fieldNameCacheExpiry = now + 10 * 60 * 1000;
  } catch (error) {
    console.warn('Field list unavailable; blank placeholders will be flagged', getErrorMessage(error));
    // Retry soon rather than holding a failure for ten minutes.
    fieldNameCache = { names: new Set(), available: false };
    fieldNameCacheExpiry = now + 60 * 1000;
  }

  return fieldNameCache;
}

// -------------------------------------------------------------- suggestions

/**
 * The guest's live payment codes, so a BM clicks rather than types. Upcoming
 * and active bookings first (soonest trip first), then open leads. Cancelled
 * and finished bookings, and closed or converted leads, are left out.
 *
 * Three requests: the customer, their bookings, their leads.
 */
async function suggestCodes(base, emailParam) {
  const emails = [...new Set(emailParam.split(',').map((email) => email.trim().toLowerCase()).filter(Boolean))];
  if (!emails.length || !TABLE_CUSTOMERS) return [];

  const emailFields = [AIRTABLE_CUSTOMERS_EMAIL_FIELD, 'Alt Email', 'Alt Email 2'];
  const byEmail = (fieldNames) => `OR(${emails
    .flatMap((email) => fieldNames.map((name) => `LOWER(TRIM({${name}})) = ${formulaString(email)}`))
    .join(', ')})`;

  let customers;
  try {
    customers = await base(TABLE_CUSTOMERS).select({ maxRecords: 3, filterByFormula: byEmail(emailFields) }).firstPage();
  } catch (error) {
    // An alternate email field that does not exist fails the whole formula.
    // Same fallback as the guest panel.
    console.warn('Multi-field email lookup failed, falling back to primary field', getErrorMessage(error));
    customers = await base(TABLE_CUSTOMERS)
      .select({ maxRecords: 3, filterByFormula: byEmail([AIRTABLE_CUSTOMERS_EMAIL_FIELD]) })
      .firstPage();
  }

  const bookingIds = customers.flatMap((customer) => asArray(customer.fields[FIELDS.customer.bookings]));
  const leadIds = customers.flatMap((customer) => asArray(customer.fields[FIELDS.customer.leads]));

  const [bookings, leads] = await Promise.all([
    fetchByIds(base, TABLE_BOOKINGS, bookingIds),
    fetchByIds(base, TABLE_BOOKING_CRM, leadIds),
  ]);

  const today = startOfToday();
  const B = FIELDS.booking;
  const L = FIELDS.lead;

  const bookingCodes = bookings
    .filter((record) => !record.fields[B.cancelled])
    .map((record) => {
      const start = parseDate(record.fields[B.startDate]);
      const end = parseDate(record.fields[B.endDate]) || start;
      return {
        code: cellText(record.fields[B.paymentCode]).trim().toUpperCase(),
        trip: tripLabel(record.fields[B.tripCode]),
        kind: 'booking',
        start: start ? formatShortDate(start) : '',
        sortKey: start ? start.getTime() : Number.MAX_SAFE_INTEGER,
        finished: Boolean(end && end < today),
      };
    })
    .filter((item) => item.code && !item.finished)
    .sort((a, b) => a.sortKey - b.sortKey);

  const leadCodes = leads
    .filter((record) => {
      const status = cellText(record.fields[L.status]);
      return !CLOSED_LEAD_STATUSES.includes(status) && !CONVERTED_LEAD_STATUSES.includes(status);
    })
    .map((record) => {
      const start = parseDate(record.fields[L.startDate]);
      return {
        code: cellText(record.fields[L.paymentCode]).trim().toUpperCase(),
        trip: tripLabel(record.fields[L.tripCodes]),
        kind: 'lead',
        start: start ? formatShortDate(start) : '',
      };
    })
    .filter((item) => item.code);

  const seen = new Set();
  return [...bookingCodes, ...leadCodes]
    .filter((item) => (seen.has(item.code) ? false : seen.add(item.code)))
    .slice(0, MAX_SUGGESTIONS)
    .map(({ code, trip, kind, start }) => ({ code, trip, kind, start }));
}

/** One request for many records, rather than one find() each. */
async function fetchByIds(base, table, ids) {
  // The newest links sit at the end; sixty keeps the formula a sane length.
  const wanted = [...new Set(ids.filter(isRecordId))].slice(-60);
  if (!table || !wanted.length) return [];

  try {
    return await base(table)
      .select({ filterByFormula: `OR(${wanted.map((id) => `RECORD_ID() = '${id}'`).join(', ')})` })
      .all();
  } catch (error) {
    console.warn(`Could not fetch records from ${table}`, getErrorMessage(error));
    return [];
  }
}

// ------------------------------------------------------------------ helpers

function tripLabel(value) {
  const codes = asArray(value).map(cellText).filter(Boolean);
  return codes.join(', ');
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function isRecordId(value) {
  return typeof value === 'string' && /^rec[a-zA-Z0-9]+$/.test(value);
}

/** Same parsing as api/airtable.js, including "friendly" dates with the ISO date in brackets. */
function parseDate(value) {
  const raw = cellText(value);
  if (!raw) return null;
  const friendlyMatch = raw.match(/\(([^)]+)\)/);
  const date = new Date(friendlyMatch?.[1] || raw);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function startOfToday() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function formatShortDate(date) {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(date);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sendJson(res, statusCode, body) {
  if (typeof res.status === 'function') {
    return res.status(statusCode).json(body);
  }

  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function getErrorMessage(error) {
  if (!error) return 'Unknown error';
  if (typeof error.message === 'string') return error.message;
  if (typeof error.error === 'string') return error.error;
  return 'Unknown error';
}
