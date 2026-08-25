// Per-person, per-YEAR topics: what did we actually talk about, in 2021
// specifically? Two mechanisms, both code, no model:
//
//   1. A TAXONOMY of curated topic signals (TOPIC_SIGNALS) counted per row --
//      clean, predictable labels ("fundraising", "travel"). Unlike
//      graph.mjs CONTENT_SIGNALS.investor these are NOT directional evidence
//      for a ranked need; they are conversation labels, so recall matters
//      more than the investor signal's precision-hard stance.
//
//   2. DISTINCTIVE TERMS: the words unusually THEIRS -- counted per
//      person-year and weighted against how many other person-years use the
//      same word (an idf weight). This is what makes a chip personal
//      ("tahoe", "figma", "warriors") instead of generic.
//
// The output is labels and counts only -- never a quote, never a row. A
// distinctive term is a single corpus-frequency-ranked token; that is the
// closest this module gets to message content, and it is deliberate, owner-
// approved (2026-08-24), and bounded: tokens pass a stoplist, a name filter,
// and a minimum-count floor, so a one-off word (or one weird message) cannot
// become a chip.
//
// All tallies key on (person, year): the year view shows what you talked
// about THAT year, so a friendship that moved from "classes" to "startups"
// reads as the story it is.

// Curated topic signals. Word-boundary, case-insensitive, one hit counted per
// ROW containing the signal (a message that says "coffee" five times is one
// coffee conversation, not five).
export const TOPIC_SIGNALS = Object.freeze({
  fundraising:
    /\b(fundrais\w*|term sheet|cap table|pitch deck|seed round|series [abc]\b|valuation|investors?|angel round|our raise|raising (money|capital|a round))\b/iu,
  hiring:
    /\b(hiring|recruit\w*|job (description|posting|offer)|candidates?|interview\w*|offer letter|headcount|resume|role at)\b/iu,
  'product & startup':
    /\b(product|launch\w*|roadmap|features?|beta|mvp|prototype|demo|ship(ped|ping)?|startup|users?|customers?)\b/iu,
  engineering:
    /\b(code|coding|bug|deploy\w*|api|backend|frontend|database|repo|github|python|javascript|typescript)\b/iu,
  design:
    /\b(design\w*|figma|mockups?|wireframes?|branding|logo|typography|ui|ux)\b/iu,
  travel:
    /\b(flights?|trip|airport|hotel|airbnb|itinerary|visa|travel\w*|vacation|layover|passport)\b/iu,
  'food & drinks':
    /\b(dinner|lunch|brunch|restaurant|coffee|drinks|happy hour|reservation|bar tonight|grab (food|a bite))\b/iu,
  fitness:
    /\b(gym|workout|lifting|yoga|surf\w*|hik(e|ing)|climb\w*|training|marathon|pilates)\b/iu,
  health:
    /\b(doctors?|dentist|therapy|therapist|sick|injur\w*|appointment|prescription|urgent care)\b/iu,
  family:
    /\b(mom|dad|mother|father|sister|brother|grandma|grandpa|cousin|wedding|baby|kids?|parents)\b/iu,
  housing:
    /\b(apartment|lease|rent|landlord|moving (out|in|to)|roommates?|house hunt\w*|mortgage|sublet)\b/iu,
  money:
    /\b(invoice|venmo|paypal|zelle|payment|paid you|you owe|i owe|split (it|the bill|the check)|reimburse\w*)\b/iu,
  events:
    /\b(party|concert|tickets?|festival|birthday|show tonight|rsvp|housewarming)\b/iu,
  school:
    /\b(class(es)?|professor|exam|semester|homework|campus|degree|thesis|midterm|finals week)\b/iu,
});

// The stoplist for distinctive terms: standard English function words, chat
// filler, and the high-frequency conversational verbs/nouns that appear in
// EVERYONE's threads (they would top every list and say nothing about anyone).
// Apostrophes are stripped by the tokenizer, so contractions appear bare
// (dont, thats, youre).
const STOPWORDS = new Set(
  (
    'the a an and or but if then else when while for nor so yet of in on at to from by with about into over after ' +
    'before between out against during without within along across behind beyond under above near ' +
    'i me my mine we us our ours you your yours he him his she her hers it its they them their theirs this that ' +
    'these those there here what which who whom whose why how all any both each few more most other some such ' +
    'no not only own same than too very just also ever never always often really actually probably maybe ' +
    'is are was were be been being have has had having do does did doing will would can could should shall may ' +
    'might must am let lets im ive ill id youre youve youll youd hes shes theyre theyve weve well were wed ' +
    'thats whats heres theres dont doesnt didnt cant couldnt wont wouldnt shouldnt isnt arent wasnt werent ' +
    'havent hasnt hadnt aint gonna wanna gotta kinda sorta ' +
    'yes yeah yea yep no nope ok okay sure thanks thank thx please pls sorry oops congrats welcome ' +
    'lol lmao haha hahaha hehe omg wow hmm hmmm ugh yay woo hooray nice cool great awesome amazing perfect good ' +
    'bad fine love hate like liked want wanted need needed know knew think thought get got make made see saw ' +
    'say said tell told talk talked call called text texted send sent come came going gone went way ' +
    'meet meeting hey hi hello bye goodbye morning night tonight today tomorrow yesterday week weekend month year ' +
    'day days time times minute minutes hour hours soon later early late now right left new old big small ' +
    'first last next one two three thing things stuff bit lot little much many people person guy guys man dude ' +
    'work working works home house back down still around able keep let take took give gave put use used try ' +
    'tried look looked find found feel felt sound sounds pretty better best worse worst http https www com ' +
    // Learned from the first live run (2026-08, owner's corpus): weekday and
    // month names chip constantly ("monday(6)") and say nothing; so does chat
    // filler, profanity-as-filler ("fucking" in a text is emphasis, not a
    // topic), and bare -ing verbs.
    'monday tuesday wednesday thursday friday saturday sunday jan feb mar apr jun jul aug sep sept oct nov dec ' +
    'january february march april june july august september october november december ' +
    'honestly literally basically seriously exactly totally definitely obviously actually lowkey highkey ' +
    'ngl tbh idk idc imo imho btw asap bro bruh sis fam yall okie okey oki yuh welp whoa woah aww awww ' +
    'omw otw ttyl hbu wbu wyd wya smh wtf lmfao hahah hahahah heheh yup yupp nah nahh mhm damn dang god omg ' +
    'shit fuck fucking fucked ass hell bitch crazy insane wild funny weird cute dope fire lit bet facts true ' +
    'real deal huh cry crying dying dead bummer oof yikes sheesh ' +
    'looking making getting taking coming trying saying telling asking thinking feeling talking texting waiting ' +
    // Laughter runs in every alphabet the corpus texts in — 'kkk' is how half
    // the world laughs and reads appallingly as a chip.
    'kkk kkkk kkkkk jaja jajaja jajaj wkwk wkwkwk jeje interesting'
  ).split(/\s+/u)
);

// One person-year of tallies.
function emptyDoc() {
  return { taxonomy: {}, terms: new Map(), pairs: new Map() };
}

// Strip the shapes that must never become a chip before tokenizing: URLs and
// email addresses (they read as row content, and they are nobody's topic).
function stripNonProse(text) {
  return String(text)
    .replace(/https?:\/\/\S+/giu, ' ')
    .replace(/\S+@\S+/gu, ' ');
}

function tokenize(text) {
  return stripNonProse(text)
    .toLowerCase()
    .replace(/[’'`]/gu, '')
    .split(/[^\p{L}]+/u)
    .filter((t) => t.length >= 3 && t.length <= 24 && !STOPWORDS.has(t));
}

// The same tokens, but clause by clause and with stopwords kept as gaps —
// the raw material for WORD PAIRS. A pair is two meaningful words that were
// literally adjacent in the same clause: splitting on punctuation first
// stops "seed round, term sheet" minting a phantom "round term", and a
// stopword between two words breaks the pair ("working on the app" is not
// "working app").
function clauseTokens(text) {
  return stripNonProse(text)
    .toLowerCase()
    .replace(/[’'`]/gu, '')
    .split(/[.!?,;:()\n\r]+/u)
    .map((clause) =>
      clause
        .split(/[^\p{L}]+/u)
        .filter((t) => t.length > 0)
        .map((t) => (t.length >= 3 && t.length <= 24 && !STOPWORDS.has(t) ? t : null))
    );
}

// The counterparty of one prose row -- the SAME derivation as graph.mjs's
// content scan (mail rows attribute to the sender, so the owner's outbound
// mail carries no tally; iMessage/WhatsApp threads attribute both directions
// to the counterparty, because "what WE talked about" includes both sides).
function rowPersonId(row, meta) {
  if (row.source === 'linkedin' && meta.kind !== 'message') return null;
  const id =
    row.source === 'mail'
      ? (Array.isArray(meta.from) ? meta.from[0]?.toLowerCase() : null)
      : (meta.chat_handle ?? meta.handle ?? null);
  return !id || meta.is_group ? null : id;
}

// Scan the prose sources once and tally, per (person, year): taxonomy topic
// hits and candidate term counts. `idToKey` maps a raw identifier to a person
// key (built from the graph's own resolution, so a merged person tallies as
// one). `nameTokens` is the token set of every display name plus the owner's
// names -- a person's own name is never their topic.
//
// Returns { docs: Map<'key|bucket', {taxonomy, terms}>, docFreq: Map<term, n>,
// totalDocs } where docFreq counts person-buckets containing the term -- the
// denominator that makes "tahoe" beat "tuesday". `bucketBy` picks the time
// grain: 'year' ('key|2021', the year view) or 'month' ('key|2021-03', for a
// months-of-one-year view where a year would blur the story).
export function topicTallies(contextDb, idToKey, { nameTokens = new Set(), bucketBy = 'year' } = {}) {
  const rows = contextDb
    .prepare(
      "SELECT source, ts, text, meta FROM context " +
        "WHERE source IN ('imessage','whatsapp','mail','linkedin') AND text IS NOT NULL"
    )
    .all();
  const docs = new Map();
  const topicNames = Object.keys(TOPIC_SIGNALS);
  for (const row of rows) {
    let meta = {};
    try {
      meta = JSON.parse(row.meta ?? '{}') ?? {};
    } catch {
      meta = {};
    }
    const id = rowPersonId(row, meta);
    if (id === null) continue;
    const key = idToKey.get(id);
    if (key === undefined) continue;
    const ts = Number(row.ts);
    if (!Number.isFinite(ts)) continue;
    const d = new Date(ts);
    const bucket =
      bucketBy === 'month'
        ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
        : String(d.getFullYear());
    const docKey = `${key}|${bucket}`;
    let doc = docs.get(docKey);
    if (doc === undefined) {
      doc = emptyDoc();
      docs.set(docKey, doc);
    }
    for (const name of topicNames) {
      if (TOPIC_SIGNALS[name].test(row.text)) doc.taxonomy[name] = (doc.taxonomy[name] ?? 0) + 1;
    }
    for (const clause of clauseTokens(row.text)) {
      for (let i = 0; i < clause.length; i++) {
        const t = clause[i];
        if (t === null || nameTokens.has(t)) continue;
        doc.terms.set(t, (doc.terms.get(t) ?? 0) + 1);
        // The pair: this word and the next, only when the next is also a
        // meaningful word (a stopword or name in between breaks adjacency).
        const u = clause[i + 1];
        if (u !== null && u !== undefined && !nameTokens.has(u)) {
          const pair = `${t} ${u}`;
          doc.pairs.set(pair, (doc.pairs.get(pair) ?? 0) + 1);
        }
      }
    }
  }
  // Document frequency over person-buckets — singles and pairs share one map
  // (the space in a pair key keeps the namespaces apart).
  const docFreq = new Map();
  for (const doc of docs.values()) {
    for (const t of doc.terms.keys()) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
    for (const pr of doc.pairs.keys()) docFreq.set(pr, (docFreq.get(pr) ?? 0) + 1);
  }
  return { docs, docFreq, totalDocs: docs.size };
}

// The token set of every name in play, so "sarah" is never Sarah's topic.
export function nameTokenSet(names) {
  const out = new Set();
  for (const name of names ?? []) {
    for (const t of tokenize(String(name))) out.add(t);
  }
  return out;
}

// Two-word phrases that are conversation, not conversation TOPICS — each is
// a fixed expression whose words are individually too ordinary to stoplist.
const PAIR_STOP = new Set([
  'fair enough', 'makes sense', 'take care', 'thank you', 'thanks man',
  'sounds like', 'kind regards', 'talk soon', 'miss you', 'appreciate it',
]);

// The candidate list under both chip backfill and the specifics line.
// PAIRS FIRST, then single words for whatever slots remain — not one merged
// score. Measured on the live corpus: a month rich in real phrases ("wake
// word", "desk companion") still rendered as word salad, because the phrase
// appears 3× while its component words appear 20× each and count×idf let
// the words win every slot. A pair is always the more specific claim, and
// specificity is this list's whole point, so specificity is structural, not
// a score nudge. Subsumption still applies — a picked pair covers its
// component words, and a later word-order variant of the same pair is
// covered by the same rule.
// `skip` lets the caller drop candidates a shown taxonomy chip already says.
function pickTerms(doc, docFreq, totalDocs, { limit, minCount, skip = null } = {}) {
  if (!doc || totalDocs <= 0 || limit <= 0) return [];
  const idf = (label) => Math.log((totalDocs + 1) / (docFreq.get(label) ?? 1));
  // Pairs get a floor one below the singles': an exact two-word phrase is a
  // far rarer event than a word, so repeating it even twice is signal.
  const pairFloor = Math.max(2, minCount - 1);
  const pairs = [...(doc.pairs ?? new Map())]
    .filter(([label, n]) => n >= pairFloor && !PAIR_STOP.has(label))
    .map(([label, n]) => ({ label, n, score: n * idf(label) }))
    .sort((a, b) => b.score - a.score);
  const singles = [...(doc.terms ?? new Map())]
    .filter(([, n]) => n >= minCount)
    .map(([label, n]) => ({ label, n, score: n * idf(label) }))
    .sort((a, b) => b.score - a.score);
  const out = [];
  const covered = new Set();
  for (const c of [...pairs, ...singles]) {
    if (out.length >= limit) break;
    if (skip !== null && skip(c.label)) continue;
    const words = c.label.split(' ');
    if (words.some((w) => covered.has(w)) || covered.has(c.label)) continue;
    out.push({ label: c.label, n: c.n });
    for (const w of words) covered.add(w);
    covered.add(c.label);
  }
  return out;
}

// Top topics for one person-bucket: taxonomy hits first (count >= minTaxonomy
// rows, ordered by count), backfilled to `limit` with distinctive terms —
// pairs and words via pickTerms, floored at minCount occurrences so a
// one-off cannot become a chip. Returns [{ label, n }].
export function topTopics(doc, docFreq, totalDocs, { limit = 3, minTaxonomy = 2, minCount = 3 } = {}) {
  if (!doc) return [];
  const out = [];
  const taken = new Set();
  const tax = Object.entries(doc.taxonomy)
    .filter(([, n]) => n >= minTaxonomy)
    .sort((a, b) => b[1] - a[1]);
  for (const [label, n] of tax) {
    if (out.length >= limit) break;
    out.push({ label, n });
    taken.add(label);
  }
  if (out.length < limit) {
    // A term already covered by a SHOWN taxonomy chip wastes the slot
    // ("fundraising · investors" says fundraising twice) — skip any candidate
    // the shown topics' own signals match. Learned from the first live run.
    const shownSignals = [...taken].map((label) => TOPIC_SIGNALS[label]).filter(Boolean);
    const skip = (label) => taken.has(label) || shownSignals.some((re) => re.test(label));
    out.push(...pickTerms(doc, docFreq, totalDocs, { limit: limit - out.length, minCount, skip }));
  }
  return out;
}

// The SPECIFICS: distinctive terms alone, idf-ranked, no taxonomy labels and
// no dedupe against them — this is "the actual words we used" (tahoe, figma,
// a nickname), for the expanded row where the generic category chips are not
// specific enough. Same floors as topTopics so a one-off word still cannot
// appear. Returns [{ label, n }].
export function topTerms(doc, docFreq, totalDocs, { limit = 8, minCount = 3 } = {}) {
  return pickTerms(doc, docFreq, totalDocs, { limit, minCount });
}
