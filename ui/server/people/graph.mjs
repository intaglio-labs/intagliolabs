// The people graph: every person the owner knows, resolved across channels,
// with a dormancy clock and the evidence behind them.
//
// This is the payoff of the connections build (deep message windows, calendar
// attendee emails, the LinkedIn export, the contacts spine, WhatsApp). Raw,
// it is six sources that each name people differently — a phone here, an email
// there, a LinkedIn slug, a display name in a meeting. This module collapses
// them into ONE person per human and attaches what the corpus knows.
//
// THE RULES ARE THE SAME AS THE EPISODIC SHELF, and for the same reason this
// feeds an experiment: CODE resolves people and CODE does the arithmetic
// (counts, dormancy, co-attendance). No model decides who is whom — identity
// is too consequential to hand a language model, exactly like a query.
//
// RESOLUTION, deliberately conservative (the spine must not become the
// project): two identifiers are the same person when the contacts spine maps
// them to the same display name, OR when they are literally the same string.
// A LinkedIn connection merges into that person only on an EXACT normalized
// name match or a shared email — never on fuzzy name similarity, because a
// wrong merge invents a relationship that is not there, which is worse than a
// split one the owner can eyeball.
//
// Reads two databases (context + the spine's state.db) and writes nothing.

const DAY = 86_400_000;

function normName(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

// identifier (phone/email) -> canonical display name, from the spine.
// Is this string a NAME, or an identifier wearing one? `speaker` falls back to
// the handle when the store knows no name, so a WhatsApp LID
// ("11107305521405@lid") and a bare phone number both arrive looking like
// labels. Neither is one.
// What to show when nobody, anywhere, knows this person's name.
//
// A raw WhatsApp LID is seventeen digits and an @lid suffix. It is not a
// name, it is not recognisable, and it is not even a number the owner could
// look up -- WhatsApp mints it precisely so it cannot be traced back to one.
// Rendering it verbatim asks somebody to recognise an opaque token.
//
// A phone number is different: it is unrecognisable too, but it is REAL, and
// an owner can often place it. So numbers stay, formatted; only the LID gets
// replaced by an honest description of what it is.
export function readableId(identifier) {
  if (typeof identifier !== 'string' || identifier.length === 0) return null;
  if (identifier.endsWith('@lid')) return 'WhatsApp contact';
  return identifier;
}

export function namelike(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (v.length === 0 || v.length > 80) return false;
  if (v.includes('@')) return false; // an address or a LID, never a name
  if (/^\+?[0-9()\s.-]+$/u.test(v)) return false; // a phone number
  return /\p{L}/u.test(v); // has an actual letter in it
}

export function loadSpine(stateDb) {
  const map = new Map();
  const nameToIds = new Map();
  try {
    for (const r of stateDb.prepare('SELECT identifier, display_name FROM contact_ids').all()) {
      map.set(r.identifier, r.display_name);
      const key = normName(r.display_name);
      if (!nameToIds.has(key)) nameToIds.set(key, { name: r.display_name, ids: [] });
      nameToIds.get(key).ids.push(r.identifier);
    }
  } catch {
    // No spine yet is a valid state — people just key by raw identifier.
  }
  return { idToName: map, nameToIds };
}

// The identifier a row is "about" — the counterparty, never the owner. Returns
// { id, channel, ts, fromMe, name? } or null for rows with no person.
function personSignalsForRow(row, meta, owner) {
  const ts = Number(row.ts);
  switch (row.source) {
    case 'imessage':
    case 'whatsapp': {
      const fromMe = meta.is_from_me === true || meta.is_from_me === 1;
      // GROUPS ARE NO LONGER DROPPED (owner, 2026-08-21). A group message is
      // credited to the person who SENT it, not the room — so an investor you
      // only ever talked to in a group thread is now visible. The owner's own
      // group messages have no single counterparty and are still skipped; a
      // one-to-one message is credited to the chat handle as before.
      // THE SPEAKER IS A NAME WHEN WHATSAPP KNOWS ONE, and for most of these
      // people it is the only name there is. A group sender arrives as a privacy
      // LID -- an opaque id WhatsApp uses instead of a phone number -- which the
      // spine can never resolve, so the timeline rendered seventeen digits. The
      // connector already joins ZWAGROUPMEMBER for a contact name and puts it in
      // `speaker`; this is where it was being thrown away.
      //
      // Guarded, because `speaker` falls back to the handle itself when the
      // store knows no name: a LID or a bare number is an identifier, and
      // passing one through here would make it somebody's display name, which
      // is the bug this whole pass exists to fix.
      const speakerName = namelike(row.speaker) ? row.speaker : undefined;
      if (meta.is_group) {
        if (fromMe) return [];
        const sender = meta.sender_handle ?? meta.handle ?? null;
        return sender
          ? [{ id: sender, channel: row.source, ts, fromMe: false, name: speakerName }]
          : [];
      }
      const id = meta.chat_handle ?? meta.handle ?? null;
      if (!id) return [];
      return [{ id, channel: row.source, ts, fromMe, name: speakerName }];
    }
    case 'mail': {
      // EVERY non-owner address on the email is counted, not just the first
      // (owner, 2026-08-21). A VC cc'd on an intro thread is exactly the
      // person the old first-address-only shortcut dropped. fromMe is whether
      // the owner sent it. Capped at 12 addresses so a mass blast does not
      // mint 200 people; the automated senders are filtered by the ranker.
      const from = Array.isArray(meta.from) ? meta.from[0] : null;
      const ownerSent = Boolean(from && isOwnerAddress(from, owner));
      const everyone = [
        ...(Array.isArray(meta.from) ? meta.from : []),
        ...(Array.isArray(meta.to) ? meta.to : []),
        ...(Array.isArray(meta.cc) ? meta.cc : []),
      ];
      const seen = new Set();
      const out = [];
      for (const addr of everyone) {
        if (typeof addr !== 'string') continue;
        const id = addr.toLowerCase();
        if (isOwnerAddress(id, owner) || seen.has(id)) continue;
        seen.add(id);
        out.push({ id, channel: 'mail', ts, fromMe: ownerSent });
        if (out.length >= 12) break;
      }
      return out;
    }
    case 'calendar': {
      const out = [];
      for (const a of meta.attendees ?? []) {
        if (a?.email) out.push({ id: a.email.toLowerCase(), channel: 'calendar', ts, fromMe: false, name: a.name });
      }
      return out;
    }
    case 'linkedin': {
      if (meta.kind === 'connection') {
        return [{ id: `linkedin:${row.entity_id.split(':').pop()}`, channel: 'linkedin', ts, fromMe: false,
                  name: meta.name, linkedin: { position: meta.position, company: meta.company, connected_on: meta.connected_on, email: meta.email } }];
      }
      if (meta.kind === 'message') {
        const id = meta.from && !isOwnerName(meta.from, owner) ? `liname:${normName(meta.from)}` : null;
        return id ? [{ id, channel: 'linkedin', ts, fromMe: false, name: meta.from }] : [];
      }
      return [];
    }
    default:
      return [];
  }
}

// Owner-address / owner-name checks. Identity is INJECTED (see owner.mjs,
// loaded from the local config) so no personal data lives in this tracked
// file. `owner` is { addresses: Set<string>, names: string[] }.
function isOwnerAddress(a, owner) {
  return owner.addresses.has(String(a).toLowerCase());
}
function isOwnerName(n, owner) {
  const nk = normName(n);
  return owner.names.some((name) => normName(name) === nk);
}

// Content-signal vocabularies: code SCANS the corpus text for topic evidence
// and counts hits per person. The count is a number; the text never leaves
// this function and never reaches a model. This is how "did we talk about
// raising" becomes a rankable fact without breaking the rule that message
// content stays off the model — the same discipline the episodic shelf uses,
// applied to a graph query.
// HIGH-SPECIFICITY ONLY. The first cut included "deck", "round", "angel",
// "raise", "portfolio" — and family members lit up, because those words live
// in ordinary conversation ("raise the bar", "slide deck", "next round" of
// drinks). Measured on the live corpus: Mother scored 35 "investor" threads.
// So the vocabulary is now terms that essentially ONLY occur when actually
// discussing a fundraise — multiword and jargon that casual talk does not use.
// This trades recall (a real investor thread that never said "term sheet" is
// missed) for precision (the list is investors, not everyone chatty), which is
// the right trade for a shortlist the owner will eyeball. The exact vocabulary
// is a knob the sealed-list experiment is meant to calibrate.
// DIRECTIONAL. The owner's definition of an investor is "someone I talked to
// about investing IN ME" — not generic fundraising chatter (that lit up
// founder friends commiserating about their own raises). So the vocabulary is
// phrases where the COUNTERPARTY is positioning to back the owner: "invest in
// you", "back your round", "send me your deck", "your traction/metrics/cap
// table" (an investor asking about the owner's numbers). Two founders trading
// "how's your raise going" does not match this.
// UNAMBIGUOUS AND DIRECTIONAL ONLY. The looser cut ("your metrics", "your
// revenue", "your runway") caught a business newsletter (Morning Brew scored
// 8) and founder peer-talk, because those phrases are everywhere. What
// remains is language that essentially only occurs when a COUNTERPARTY is
// moving to back the owner specifically — a sentence a friend or a newsletter
// does not write. Precision hard over recall; the sealed-list experiment
// calibrates the exact set.
export const CONTENT_SIGNALS = Object.freeze({
  investor:
    /\b(invest in (you|your company|your startup)|investing in (you|your company)|back your (round|raise|company)|write (you|your team) a check|put (money|capital) into your (round|company)|lead your (round|seed|raise)|join your round|come into your round|allocation in your round|send (me|us) your deck (to review|for)|term sheet for|our fund (would|is) invest|from our fund into|we want to invest in|interested in investing in you|wire (you the|the) (funds|money) for your)\b/giu,
});

// Attach per-person content-signal counts, from the message text of the
// sources whose text is real prose (imessage, whatsapp, mail, linkedin
// messages). Calendar titles and LinkedIn connection rows are not prose.
function addContentSignals(contextDb, people, keyResolver, signals) {
  const names = Object.keys(signals);
  if (names.length === 0) return;
  const rows = contextDb
    .prepare(
      "SELECT source, text, meta FROM context " +
        "WHERE source IN ('imessage','whatsapp','mail','linkedin') AND text IS NOT NULL"
    )
    .all();
  for (const row of rows) {
    let meta = {};
    try {
      meta = JSON.parse(row.meta ?? '{}') ?? {};
    } catch {
      meta = {};
    }
    if (row.source === 'linkedin' && meta.kind !== 'message') continue;
    // Which person is this row's counterparty? Reuse the same id derivation,
    // but we only need the key, not a full signal.
    const id =
      row.source === 'mail'
        ? (Array.isArray(meta.from) ? meta.from[0]?.toLowerCase() : null)
        : (meta.chat_handle ?? meta.handle ?? null);
    if (!id || meta.is_group) continue;
    const key = keyResolver(id);
    const person = people.get(key);
    if (!person) continue;
    // Channel weight: a real investor emails or LinkedIn-DMs — term sheets,
    // intros, diligence live there, not in iMessage. So a directional hit in
    // mail or a LinkedIn message counts double, which is the owner's "email is
    // a good source, add LinkedIn messages" made concrete in the score.
    const weight = row.source === 'mail' || row.source === 'linkedin' ? 2 : 1;
    for (const name of names) {
      const m = row.text.match(signals[name]);
      if (m) person.content[name] = (person.content[name] ?? 0) + weight;
    }
  }
}

// Build the graph. Returns an array of person objects, each merging every
// channel that names them.
//
// `contentSignals` (default none) attaches code-counted topic evidence per
// person — pass CONTENT_SIGNALS or a subset to enable "did we talk about X".
//
// `sinceTs` (default null = all time) restricts the graph to rows at or after a
// timestamp — the People popup's timeframe selector (1 week … max) made
// concrete, so "initialize search" over the last year does not also mint a
// person from a single email eight years ago.
//
// `aliases` (default null) is the owner's VERIFIED merges: a Map from a resolved
// key to the canonical key it should collapse into. Applied AFTER the code's own
// conservative resolution, it is how a human answer ("yes, Mike and Michael are
// the same") folds back into the graph — the one place a merge the code refused
// to guess is allowed, because a person confirmed it. It never SPLITS (the code
// already errs toward splitting); it only unions keys the owner said are one.
export function buildGraph(
  contextDb,
  stateDb,
  { now = Date.now(), owner = { addresses: new Set(), names: [] }, contentSignals = null,
    sinceTs = null, aliases = null } = {}
) {
  const spine = loadSpine(stateDb);

  // canonical key -> person accumulator
  const people = new Map();
  const rawKeyForId = (id, name) => {
    // Spine name wins; then an exact-name LinkedIn/calendar match to a spine
    // person; then the raw id.
    if (spine.idToName.has(id)) return `name:${normName(spine.idToName.get(id))}`;
    if (name) {
      const nk = normName(name);
      if (spine.nameToIds.has(nk)) return `name:${nk}`;
    }
    return `id:${id}`;
  };
  // The owner's confirmed merges fold in here: the code resolves a key, then an
  // alias (if any) redirects it to the canonical person. Chase one level of
  // indirection so an alias pointing at another aliased key still lands.
  const keyForId = (id, name) => {
    const raw = rawKeyForId(id, name);
    if (!aliases) return raw;
    let k = raw;
    for (let i = 0; i < 8 && aliases.has(k); i++) k = aliases.get(k);
    return k;
  };
  // A one-arg resolver for the content scan, which knows only the identifier.
  const keyForId2 = (id) => keyForId(id, null);

  const rows = contextDb
    .prepare(
      "SELECT ts, source, entity_id, meta FROM context " +
        "WHERE source IN ('imessage','whatsapp','mail','calendar','linkedin')" +
        (sinceTs != null ? " AND ts >= ?" : "")
    )
    .all(...(sinceTs != null ? [sinceTs] : []));

  for (const row of rows) {
    let meta = {};
    try {
      meta = JSON.parse(row.meta ?? '{}') ?? {};
    } catch {
      meta = {};
    }
    for (const sig of personSignalsForRow(row, meta, owner)) {
      const key = keyForId(sig.id, sig.name);
      if (!people.has(key)) {
        people.set(key, {
          key,
          names: new Set(),
          identifiers: new Set(),
          channels: new Set(),
          firstSeen: sig.ts,
          lastSeen: null,
          lastFromThem: null,
          sent: 0,
          received: 0,
          metInPerson: 0,
          linkedin: null,
          content: {},
          timeline: new Map(),
          lastFromOwner: null,
        });
      }
      const p = people.get(key);
      p.identifiers.add(sig.id);
      p.channels.add(sig.channel);
      if (sig.name) p.names.add(sig.name);
      if (spine.idToName.has(sig.id)) p.names.add(spine.idToName.get(sig.id));
      // A calendar event is co-attendance, not contact — and it can be in the
      // FUTURE, which produced negative dormancy on the first live run. So
      // firstSeen spans everything, but lastSeen and the DORMANCY clock only
      // tick on signals that have actually happened (ts <= now). lastSeen is
      // seeded null above for the same reason: the SELECT has no ORDER BY, so
      // an unguarded seed let a future event stick as lastSeen whenever it
      // happened to be the person's first row scanned. A meeting on the
      // calendar is not them reaching out.
      const isMessage = sig.channel !== 'calendar' && !sig.linkedin;
      if (Number.isFinite(sig.ts)) {
        if (sig.ts < p.firstSeen) p.firstSeen = sig.ts;
        if (sig.ts <= now && (p.lastSeen === null || sig.ts > p.lastSeen)) p.lastSeen = sig.ts;
        if (isMessage && !sig.fromMe && sig.ts <= now && (p.lastFromThem === null || sig.ts > p.lastFromThem)) {
          p.lastFromThem = sig.ts;
        }
        // The owner's side of the same clock, for open-loop detection ("they
        // wrote last and I never answered"). Message channels only, like
        // lastFromThem -- a calendar invite neither opens nor closes a loop.
        if (isMessage && sig.fromMe && sig.ts <= now && (p.lastFromOwner === null || sig.ts > p.lastFromOwner)) {
          p.lastFromOwner = sig.ts;
        }
      }
      if (sig.channel === 'calendar') p.metInPerson += 1;
      else if (sig.fromMe) p.sent += 1;
      else p.received += 1;
      // The activity TIMELINE: the same counts, bucketed by calendar month, so
      // downstream code (people/profile.mjs) can see WHEN a relationship lived
      // -- peak era, cadence, "active in 2020-2022" -- not just its lifetime
      // totals. Only signals that have already happened tick a bucket, the
      // same rule as the dormancy clock: a future meeting is not history yet.
      if (Number.isFinite(sig.ts) && sig.ts <= now) {
        const d = new Date(sig.ts);
        const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        let bucket = p.timeline.get(ym);
        if (bucket === undefined) {
          bucket = { sent: 0, received: 0, met: 0 };
          p.timeline.set(ym, bucket);
        }
        if (sig.channel === 'calendar') bucket.met += 1;
        else if (sig.fromMe) bucket.sent += 1;
        else bucket.received += 1;
      }
      if (sig.linkedin) p.linkedin = sig.linkedin;
    }
  }

  // Content signals: code-counted topic evidence per person (never model-read).
  if (contentSignals) {
    addContentSignals(contextDb, people, keyForId2, contentSignals);
  }

  // Finalize: pick a display name, compute dormancy and a depth score.
  return [...people.values()]
    .map((p) => {
      const messages = p.sent + p.received;
      // THE SPINE FIRST, because it is the only source that knows a name for
      // somebody who has never been named IN the data.
      //
      // p.names holds names carried by the events themselves -- a calendar
      // attendee, a LinkedIn profile. A message carries a HANDLE and never a
      // name, so for anyone known only through the address book that set is
      // empty and this fell through to the raw identifier. That is why the
      // timeline showed "ay@austinyoshino.com" for a person whose own key was
      // already `name:austin yoshino`: the key had resolved him through the
      // spine, and the label never asked.
      //
      // nameToIds keeps the ORIGINAL casing against the normalised key, so this
      // renders "Austin Yoshino" rather than the flattened form the key carries.
      const fromSpine = p.key.startsWith('name:')
        ? spine.nameToIds.get(p.key.slice('name:'.length))?.name
        : null;
      const display =
        fromSpine ??
        [...p.names].sort((a, b) => b.length - a.length)[0] ??
        readableId([...p.identifiers][0]) ??
        p.key;
      return {
        // The canonical resolution key. Stable across rebuilds (derived from the
        // data, not the run), so the review queue's decisions key on it.
        key: p.key,
        name: display,
        identifiers: [...p.identifiers],
        channels: [...p.channels].sort(),
        channelCount: p.channels.size,
        messages,
        sent: p.sent,
        received: p.received,
        // Do they write back? min/max so the scale is intuitive: 1.0 is a
        // balanced two-way thread, 0 is a broadcast nobody answered. A bond
        // versus a megaphone.
        reciprocity:
          Math.max(p.sent, p.received) > 0
            ? Math.round((100 * Math.min(p.sent, p.received)) / Math.max(p.sent, p.received)) / 100
            : 0,
        metInPerson: p.metInPerson,
        firstSeen: p.firstSeen,
        lastSeen: p.lastSeen,
        // The dormancy clock the whole build was for: days since THEY last
        // reached the owner (not since the owner last pinged them).
        dormancyDays: p.lastFromThem === null ? null : Math.floor((now - p.lastFromThem) / DAY),
        // 0, not negative nonsense, for a person whose only signals are still
        // in the future (lastSeen null).
        relationshipDays: p.lastSeen === null ? 0 : Math.floor((p.lastSeen - p.firstSeen) / DAY),
        // The raw clocks behind dormancy, exposed for open-loop detection
        // (profile.mjs): who spoke last, on a message channel, and when.
        lastFromThem: p.lastFromThem,
        lastFromOwner: p.lastFromOwner,
        // Month-bucketed activity, oldest first: [{ ym: 'YYYY-MM', sent,
        // received, met }]. The extraction layer's raw material.
        timeline: [...p.timeline.entries()]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([ym, b]) => ({ ym, ...b })),
        linkedin: p.linkedin,
        content: p.content,
      };
    })
    // Drop the singletons that are almost always noise: a single email from a
    // no-reply, one calendar invite from a room. A person worth knowing about
    // shows up more than once OR across more than one channel.
    ;
  // THE "≥2" EXISTENCE BAR IS GONE (owner, 2026-08-21). Every resolved person
  // is kept, even one with a single message on a single channel — a lone real
  // email from a VC used to be filtered as noise before ranking ever saw it,
  // and that is exactly the person a "find everyone from my past" sweep wants.
  // Automated one-offs are dropped later by the ranker's address filters, and
  // each need's own gate (investor identity/content) does the real filtering,
  // so the graph itself stops pre-judging who counts.
}
