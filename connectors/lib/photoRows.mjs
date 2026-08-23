// A Photos asset → a hermes context row. Pure: no I/O, no clock.
//
// PER-ASSET, NOT PER-DAY, and that is a decision the goal forces. Daily
// aggregates are cheaper and safer, but they cannot answer "find the photos
// from San Francisco" — the stated use. Once the unit is the photo, location
// and content have to travel with it.
//
// CORE DATA TIMESTAMPS ARE SECONDS since 2001-01-01, not the nanoseconds
// chat.db uses. Applying the iMessage conversion here would put every photo
// roughly 31,000 years in the future, so the two must never share a helper.

export const APPLE_EPOCH_MS = 978307200000;

export function appleSecondsToMs(raw) {
  const v = Number(raw);
  if (!Number.isFinite(v) || v === 0) return NaN;
  return v * 1000 + APPLE_EPOCH_MS;
}

// ZKIND: 0 photo, 1 video. Screenshots are a SUBTYPE of photo, and they are
// the highest-signal category for a work context, so they get their own kind
// rather than hiding inside "photo".
const KIND_PHOTO = 0;
const KIND_VIDEO = 1;
const SUBTYPE_SCREENSHOT = 1;

export function assetKind(row) {
  if (Number(row?.ZKIND) === KIND_VIDEO) return 'video';
  if (Number(row?.ZKINDSUBTYPE) === SUBTYPE_SCREENSHOT) return 'screenshot';
  if (Number(row?.ZKIND) === KIND_PHOTO) return 'photo';
  return 'unknown';
}

// Photos stores 0/-180 sentinels for "no location" rather than NULL, and a
// (0,0) pair is Null Island rather than a place anyone photographed. Treating
// either as real would put a cluster of the owner's life in the Gulf of
// Guinea, which is exactly the kind of wrong that looks plausible on a map.
export function coordinates(row) {
  const lat = Number(row?.ZLATITUDE);
  const lng = Number(row?.ZLONGITUDE);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat === -180 || lng === -180) return null;
  if (lat === 0 && lng === 0) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

// The text field is what a later search actually matches against, so it
// carries the OCR when there is any and a stable descriptor otherwise. A row
// whose text is empty is invisible to every text query, which for a photo
// library would mean most of it.
export function assetText({ kind, ocr, title, description, filename }) {
  const parts = [];
  const label = [title, description].filter((s) => typeof s === 'string' && s.trim()).join(' — ');
  if (label) parts.push(label);
  if (typeof ocr === 'string' && ocr.trim()) parts.push(ocr.trim());
  if (parts.length === 0) {
    // No caption and no readable text: name the thing so the row is still
    // findable by kind and date rather than being a blank.
    return `(${kind}${filename ? ` ${filename}` : ''})`;
  }
  return parts.join('\n\n');
}

export function assetToRow(row, { ocr = null, maxTextBytes = 8 * 1024 } = {}) {
  const uuid = typeof row?.ZUUID === 'string' ? row.ZUUID.trim() : '';
  if (!uuid) return null;

  const ts = appleSecondsToMs(row?.ZDATECREATED);
  if (!Number.isFinite(ts)) return null;

  // Trashed assets are the owner having decided they did not want this. A
  // corpus that resurrects deleted photos is worse than one that misses them.
  if (Number(row?.ZTRASHEDSTATE ?? 0) !== 0) return null;

  const kind = assetKind(row);
  const coords = coordinates(row);
  const text = assetText({
    kind,
    ocr,
    title: row?.ZTITLE,
    description: row?.ZASSETDESCRIPTION,
    filename: row?.ZFILENAME,
  });
  const clamped = Buffer.byteLength(text, 'utf8') > maxTextBytes
    ? Buffer.from(text, 'utf8').subarray(0, maxTextBytes).toString('utf8').replace(/�$/u, '')
    : text;

  return {
    ts,
    source: 'photos',
    entity_id: `photos:${uuid}`,
    // A photo has no speaker. It is the owner's library, not an utterance.
    speaker: null,
    text: clamped,
    meta: {
      uuid,
      kind,
      ...(coords ? { lat: coords.lat, lng: coords.lng } : {}),
      ...(row?.ZFAVORITE ? { favorite: true } : {}),
      ...(Number.isFinite(Number(row?.ZWIDTH)) && Number(row.ZWIDTH) > 0
        ? { width: Number(row.ZWIDTH), height: Number(row.ZHEIGHT) }
        : {}),
      ...(kind === 'video' && Number(row?.ZDURATION) > 0
        ? { duration_s: Math.round(Number(row.ZDURATION)) }
        : {}),
      ...(typeof row?.ZFILENAME === 'string' && row.ZFILENAME ? { filename: row.ZFILENAME } : {}),
      ...(ocr ? { has_text: true } : {}),
    },
  };
}
