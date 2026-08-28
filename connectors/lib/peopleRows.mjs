// Who appears in a photo.
//
// IDENTITY ONLY, and the boundary is deliberate. Apple's ZDETECTEDFACE also
// carries the model's guesses about each person's body — age, gender,
// ethnicity, hair colour, facial hair, eye makeup, expression, gaze. None of
// that is read here. It answers none of the questions this corpus exists to
// answer ("who was I with in San Francisco" needs a name, not a guess at
// someone's ethnicity), it is frequently wrong, and nobody depicted can see or
// correct it. ZETHNICITYTYPE additionally has no published code mapping, so
// storing it would mean either meaningless integers or an invented label —
// and an invented label about a real person is precisely what this repo's
// never-fabricate rule forbids.
//
// Read under the owner's consent decision of 2026-08-20: identity only, never
// Apple's inferred attributes. That decision was recorded in the private
// repo's CLAUDE.md, which did not cross into this one — restated here so the
// rule travels with the code that obeys it.
//
// What IS read: the cluster a face belongs to, and the owner's own name for
// that cluster where they typed one. A private library confirmed that most
// detections can be cluster-linked even when relatively few clusters are
// named — an unnamed cluster still links the same person across photos.

function pk(raw) {
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? v : null;
}

// Names the owner actually typed. An unnamed cluster is kept as an id, never
// invented into a name: "person 4021" is honest, "Unknown 4021" reads like a
// label Apple assigned and "Person A" implies an ordering that means nothing.
export function personNames(personRows) {
  const names = new Map();
  for (const row of personRows ?? []) {
    const id = pk(row?.Z_PK);
    const full = typeof row?.ZFULLNAME === 'string' ? row.ZFULLNAME.trim() : '';
    if (id !== null && full) names.set(id, full);
  }
  return names;
}

// asset primary key → the people detected in it, de-duplicated. Photos of one
// person often carry several detections of them (burst frames, a mirror, a
// photo-of-a-photo), and counting those separately would make a portrait look
// like a group shot.
export function groupPeopleByAsset(faceRows, { names = new Map() } = {}) {
  const byAsset = new Map();
  for (const row of faceRows ?? []) {
    const asset = pk(row?.ZASSETFORFACE);
    const person = pk(row?.ZPERSONFORFACE);
    if (asset === null) continue;

    const bucket = byAsset.get(asset) ?? { people: new Map(), unlinked: 0 };
    if (person === null) {
      // A face Apple detected but never clustered. Worth counting — "three
      // people in this photo, one I can't identify" is true and useful — but
      // it is not an identity and gets no id.
      bucket.unlinked += 1;
    } else if (!bucket.people.has(person)) {
      bucket.people.set(person, names.get(person) ?? null);
    }
    byAsset.set(asset, bucket);
  }
  return byAsset;
}

// The meta fragment attached to a photo row. Absent entirely when no face was
// detected, so `people` in meta always means "Apple found someone here".
export function peopleMeta(bucket) {
  if (!bucket) return {};
  const named = [];
  const ids = [];
  for (const [id, name] of bucket.people) {
    ids.push(id);
    if (name) named.push(name);
  }
  if (ids.length === 0 && bucket.unlinked === 0) return {};
  return {
    people: ids.sort((a, b) => a - b),
    // Sorted so the same group of people always renders the same string, and
    // a re-scan does not look like an edit to hermes' content hash.
    ...(named.length > 0 ? { people_named: named.sort() } : {}),
    ...(bucket.unlinked > 0 ? { faces_unidentified: bucket.unlinked } : {}),
  };
}

// Names go in the row's TEXT, not only its meta: text is what a later search
// matches against, so "who was I with in San Francisco" needs the name to be
// searchable rather than buried in a JSON column.
export function peopleText(bucket) {
  if (!bucket) return '';
  const named = [...bucket.people.values()].filter(Boolean).sort();
  if (named.length === 0) return '';
  return `with ${named.join(', ')}`;
}
