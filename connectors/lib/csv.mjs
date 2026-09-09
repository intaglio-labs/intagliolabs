// Small RFC-4180 CSV reader. LinkedIn message bodies can contain quoted
// commas and newlines, so splitting on commas would corrupt the archive.
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
  while (rows.length > 0 && rows.at(-1).every((value) => value === '')) rows.pop();
  return rows;
}

export function csvObjects(text, { anchor }) {
  const rows = parseCsv(text);
  const headerIdx = rows.findIndex((row) => row.some((field) => field.trim() === anchor));
  if (headerIdx === -1) throw new Error(`no header row containing ${JSON.stringify(anchor)}`);
  const header = rows[headerIdx].map((field) => field.trim());
  return rows.slice(headerIdx + 1).map((row) => {
    const object = {};
    header.forEach((key, index) => {
      object[key] = (row[index] ?? '').trim();
    });
    return object;
  });
}
