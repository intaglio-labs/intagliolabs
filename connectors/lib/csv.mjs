// A small RFC-4180 CSV reader, because LinkedIn's export is real CSV: quoted
// fields, doubled-quote escapes, and commas AND newlines inside quotes (the
// message CONTENT column is full prose). Node has no builtin and the
// no-dependencies rule holds, so this is the whole parser — a character walk,
// no regex, ~40 lines, and it either parses or throws.

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const src = String(text ?? '');
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (inQuotes) throw new Error('unterminated quoted field');
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Trailing fully-empty lines are file formatting, not records.
  while (rows.length > 0 && rows[rows.length - 1].every((f) => f === '')) rows.pop();
  return rows;
}

// Rows as objects keyed by a header row. `findHeader` deals with LinkedIn's
// preamble: Connections.csv opens with a "Notes:" paragraph before the real
// header, so the header is FOUND (first row containing the given anchor
// column) rather than assumed to be row zero.
export function csvObjects(text, { anchor }) {
  const rows = parseCsv(text);
  const headerIdx = rows.findIndex((r) => r.some((f) => f.trim() === anchor));
  if (headerIdx === -1) throw new Error(`no header row containing ${JSON.stringify(anchor)}`);
  const header = rows[headerIdx].map((h) => h.trim());
  return rows.slice(headerIdx + 1).map((r) => {
    const o = {};
    header.forEach((h, i) => {
      o[h] = (r[i] ?? '').trim();
    });
    return o;
  });
}
