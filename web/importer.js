// Spreadsheet import/export. Parsing is done by SheetJS (vendor/xlsx.full.min.js),
// loaded on first use so it doesn't slow down the login page.

export const FIELDS = [
  { key: 'company',         label: 'Company *',      words: ['company', 'employer', 'organisation', 'organization', 'entreprise', 'societe', 'firm', 'business'] },
  { key: 'position',        label: 'Position',       words: ['position', 'job title', 'title', 'role', 'job', 'poste', 'job name'] },
  { key: 'status',          label: 'Status',         words: ['status', 'stage', 'state', 'statut', 'result', 'outcome'] },
  { key: 'applied_on',      label: 'Applied on',     words: ['date applied', 'applied on', 'applied', 'application date', 'applied date', 'date'] },
  { key: 'last_contact_on', label: 'Last contact',   words: ['last contact', 'last contacted', 'last contact date', 'last follow up', 'last update'] },
  { key: 'location',        label: 'Location',       words: ['location', 'city', 'place', 'lieu', 'ville', 'country', 'remote'] },
  { key: 'url',             label: 'Link',           words: ['url', 'link', 'job link', 'posting', 'job url', 'lien', 'website'] },
  { key: 'contact_name',    label: 'Contact name',   words: ['contact name', 'contact', 'recruiter', 'hiring manager', 'recruiter name'] },
  { key: 'contact_email',   label: 'Contact email',  words: ['contact email', 'email', 'e mail', 'mail', 'recruiter email'] },
  { key: 'follow_up_days',  label: 'Follow-up days', words: ['follow up days', 'follow up every', 'reminder days'] },
  { key: 'notes',           label: 'Notes',          words: ['notes', 'note', 'comments', 'comment', 'remarks', 'description', 'commentaire'] },
];

const STATUSES = ['wishlist', 'applied', 'followed_up', 'interviewing', 'offer', 'accepted',
                  'rejected', 'ghosted', 'withdrawn'];

// First match wins, so more specific phrases come first.
const STATUS_RULES = [
  [/(withdr|cancel|retir|declined offer|offer declined)/, 'withdrawn'],
  [/(accept|hired|signed)/, 'accepted'],
  [/offer/, 'offer'],
  [/(reject|declin|refus|not selected|unsuccessful|no go)/, 'rejected'],
  [/(ghost|no (response|reply|answer)|silence|sans reponse)/, 'ghosted'],
  [/(interview|screen|phone call|onsite|on site|technical|assessment|entretien)/, 'interviewing'],
  [/follow/, 'followed_up'],
  [/(wish|saved|to apply|interested|bookmark|planned)/, 'wishlist'],
  [/(appl|sent|submitted|pending|waiting|postul|in progress)/, 'applied'],
];

let xlsxPromise;
export function loadXLSX() {
  xlsxPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/xlsx.full.min.js';
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => { xlsxPromise = null; reject(new Error('Could not load the spreadsheet library.')); };
    document.head.append(s);
  });
  return xlsxPromise;
}

const TEXT_FORMATS = /\.(csv|tsv|txt|tab)$/i;

// Returns { sheetName: rows[][] } with the header row first and blank rows removed.
export async function parseFile(file) {
  const XLSX = await loadXLSX();
  const data = new Uint8Array(await file.arrayBuffer());
  // For text files keep every value as typed: SheetJS would otherwise guess
  // US-style dates in a CSV like 07/10/2026.
  const wb = XLSX.read(data, TEXT_FORMATS.test(file.name)
    ? { type: 'array', raw: true, codepage: 65001 }
    : { type: 'array', cellDates: true });
  const sheets = {};
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '', blankrows: false })
      .filter(r => r.some(v => String(v).trim() !== ''));
    if (rows.length) sheets[name] = rows;
  }
  if (!Object.keys(sheets).length) throw new Error('The file has no data.');
  return sheets;
}

const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Best header index for each field (exact synonym first, then "contains"), or -1.
export function guessMapping(headers) {
  const h = headers.map(norm);
  const used = new Set();
  const mapping = {};
  for (const pass of ['exact', 'contains']) {
    for (const f of FIELDS) {
      if (mapping[f.key] >= 0) continue;
      mapping[f.key] = -1;
      for (const w of f.words) {
        // Short words ("job", "date", "mail") only match exactly, or "Job link" would become a position.
        if (pass === 'contains' && w.length < 5) continue;
        const i = h.findIndex((x, idx) => !used.has(idx) && (pass === 'exact' ? x === w : x.includes(w)));
        if (i >= 0) { mapping[f.key] = i; used.add(i); break; }
      }
    }
  }
  return mapping;
}

export function normalizeStatus(v) {
  const s = norm(v);
  if (!s) return { status: 'applied', known: true };
  const exact = STATUSES.find(x => x.replace('_', ' ') === s);
  if (exact) return { status: exact, known: true };
  for (const [re, status] of STATUS_RULES) if (re.test(s)) return { status, known: true };
  return { status: 'applied', known: false };
}

const pad = n => String(n).padStart(2, '0');
const ymd = (y, m, d) => {
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d
    ? `${y}-${pad(m)}-${pad(d)}` : null;
};

// "dmy" or "mdy", decided from values where one side is > 12.
export function guessDateOrder(values) {
  for (const v of values) {
    const m = typeof v === 'string' && v.trim().match(/^(\d{1,2})[/.-](\d{1,2})[/.-]\d{2,4}$/);
    if (m && +m[1] > 12) return 'dmy';
    if (m && +m[2] > 12) return 'mdy';
  }
  return navigator.language === 'en-US' ? 'mdy' : 'dmy';
}

// Returns YYYY-MM-DD, '' for empty, or null when it can't be understood.
export function normalizeDate(v, order, XLSX) {
  if (v === '' || v == null) return '';
  if (v instanceof Date) {
    if (isNaN(v)) return null;
    const r = new Date(v.getTime() + 12 * 3600e3);   // round to the nearest local midnight
    return ymd(r.getFullYear(), r.getMonth() + 1, r.getDate());
  }
  if (typeof v === 'number') {
    if (v < 20000 || v > 80000) return null;          // not a plausible spreadsheet date serial
    const d = XLSX.SSF.parse_date_code(v);
    return ymd(d.y, d.m, d.d);
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return ymd(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return order === 'mdy' ? ymd(y, +m[1], +m[2]) : ymd(y, +m[2], +m[1]);
  }
  if (/[a-z]/i.test(s)) {                              // "Oct 7, 2026", "7 October 2026"
    const t = Date.parse(s);
    if (!isNaN(t)) { const d = new Date(t); return ymd(d.getFullYear(), d.getMonth() + 1, d.getDate()); }
  }
  return null;
}

const text = v => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '').trim());

/**
 * Turn sheet rows into application records.
 *   opts: { order, defaultFollowUp, existing: Set("company\u0000position"), skipDuplicates, extraToNotes }
 * Returns { records, skipped, duplicates, unknownStatus, badDates }.
 */
export function buildRecords(rows, mapping, opts, XLSX) {
  const [headers, ...body] = rows;
  const mapped = new Set(Object.values(mapping).filter(i => i >= 0));
  const seen = new Set(opts.existing);
  const out = { records: [], skipped: 0, duplicates: 0, unknownStatus: 0, badDates: 0 };
  const get = (row, key) => (mapping[key] >= 0 ? row[mapping[key]] : '');

  for (const row of body) {
    const company = text(get(row, 'company'));
    if (!company) { out.skipped++; continue; }
    const position = text(get(row, 'position'));
    const dupKey = `${company.toLowerCase()}\u0000${position.toLowerCase()}`;
    if (opts.skipDuplicates && seen.has(dupKey)) { out.duplicates++; continue; }
    seen.add(dupKey);

    const notes = [];
    const rawNotes = text(get(row, 'notes'));
    if (rawNotes) notes.push(rawNotes);

    const st = normalizeStatus(get(row, 'status'));
    if (!st.known) { out.unknownStatus++; notes.push(`Status: ${text(get(row, 'status'))}`); }

    const date = key => {
      const raw = get(row, key);
      const d = normalizeDate(raw, opts.order, XLSX);
      if (d === null) { out.badDates++; notes.push(`${key === 'applied_on' ? 'Applied' : 'Last contact'}: ${text(raw)}`); }
      return d || null;
    };
    const applied_on = date('applied_on');
    const last_contact_on = date('last_contact_on');

    const days = parseInt(get(row, 'follow_up_days'), 10);
    if (opts.extraToNotes) {
      headers.forEach((h, i) => {
        const v = text(row[i]);
        if (!mapped.has(i) && v) notes.push(`${text(h) || `Column ${i + 1}`}: ${v}`);
      });
    }

    out.records.push({
      company, position, status: st.status, applied_on, last_contact_on,
      location: text(get(row, 'location')) || null,
      url: text(get(row, 'url')) || null,
      contact_name: text(get(row, 'contact_name')) || null,
      contact_email: text(get(row, 'contact_email')) || null,
      follow_up_days: Number.isFinite(days) && days >= 0 ? days : opts.defaultFollowUp,
      notes: notes.join('\n') || null,
    });
  }
  return out;
}

// rows: array of objects (same keys). bookType: 'xlsx' | 'csv' | 'ods'. Returns bytes.
export async function writeSpreadsheet(sheets, bookType) {
  const XLSX = await loadXLSX();
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets))
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), name);
  if (bookType === 'csv') {
    // BOM so Excel opens UTF-8 (accents etc.) correctly.
    const csv = '﻿' + XLSX.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]]);
    return new TextEncoder().encode(csv);
  }
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType }));
}
