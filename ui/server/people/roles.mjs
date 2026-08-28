// Relationship roles are a small, local interpretation layer over direct
// messages. They are intentionally guesses, not facts about a person: the
// owner can override any one from the People page, and the override wins.
//
// This stays deterministic and local. Sending an entire relationship history
// to a model just to choose one of four UI labels would be a poor privacy and
// latency trade; the exact language signals below are reviewable instead.

import { threadKind, counterpartyFromThread, GROUP } from '../memory/threadKind.mjs';

export const RELATIONSHIP_ROLES = Object.freeze(['friend', 'business', 'romantic', 'family']);

const KIN = 'mom|mother|mama|mum|mummy|dad|father|papa|pops|sis|sister|bro|brother|grandma|grandpa|grandmother|grandfather|nana|aunt|auntie|uncle|cousin|niece|nephew|sibling';
const ADDRESS_KIN = 'mom|mother|mama|mum|mummy|dad|father|papa|pops|sister|brother|grandma|grandpa|grandmother|grandfather|nana|aunt|auntie|uncle|cousin|niece|nephew';
// A contact label is identity evidence: "Mother" and "Big Bro Example"
// describe who the person is. A random message containing "my mom" does not.
const FAMILY_NAME = new RegExp(`\\b(?:${KIN})\\b`, 'iu');
// Direct address is weaker than a saved contact label and must repeat before
// it wins. Casual "bro"/"sis" are deliberately absent here because friends
// use them constantly; the explicit relationship form below may still earn it.
const FAMILY_ADDRESS = new RegExp(
  `\\b(?:love you|miss you|good ?night|good morning|hey|hi|hello|thanks|thank you)\\s*,?\\s+(?:${ADDRESS_KIN})\\b`,
  'iu'
);
const FAMILY_EXPLICIT = new RegExp(`\\byou(?:'re| are)\\s+(?:the best\\s+)?(?:my\\s+)?(?:${KIN})\\b`, 'iu');
// Romantic is intentionally much stricter than ordinary affection. Close
// friends and family say "love you", "miss you", "babe" and "baby" too; one
// such line used to relabel an entire multi-year friendship. Direct identity
// evidence may decide immediately. Affectionate address must recur across
// several messages before it can decide anything.
const ROMANTIC_EXPLICIT = /\b(?:you(?:'re| are) my (?:boyfriend|girlfriend|romantic partner)|our anniversary)\b/iu;
const ROMANTIC_AFFECTION = /\b(?:(?:love|miss) you(?: so much)?[\s,!]*(?:babe|baby|my love)|(?:babe|baby|my love)[\s,!]+(?:i )?(?:love|miss) you|good ?night[\s,!]+(?:babe|baby|my love)|date night|xoxo)\b/iu;
const BUSINESS = /\b(meeting|deck|fundrais\w*|investors?|term sheet|hiring|candidate|interview|offer letter|roadmap|launch|sprint|deploy\w*|repo|contract|invoice|client|customer|partnership)\b/iu;

export function scoreRoleText(text, scores = { friend: 0, business: 0, romantic: 0, family: 0 }) {
  const value = String(text ?? '');
  if (FAMILY_ADDRESS.test(value)) scores.family += 5;
  if (FAMILY_EXPLICIT.test(value)) scores.family += 10;
  if (ROMANTIC_EXPLICIT.test(value)) scores.romantic += 100;
  else if (ROMANTIC_AFFECTION.test(value)) scores.romantic += 1;
  if (BUSINESS.test(value)) scores.business += 1;
  return scores;
}

export function scoreRoleName(name, scores = { friend: 0, business: 0, romantic: 0, family: 0 }) {
  if (FAMILY_NAME.test(String(name ?? ''))) scores.family += 100;
  return scores;
}

// Turn the differently-scaled evidence counters into comparable likelihoods.
// These are intentionally calibrated by specificity rather than raw volume:
// a sibling can discuss hundreds of meetings without becoming a business
// relationship, while an explicit "you're my girlfriend" should beat a couple
// of family-style greetings. Generic business vocabulary is therefore capped
// below direct family/romantic evidence. Friend is the useful baseline when no
// more specific role clears its evidence threshold.
function relationshipRoleLikelihoods(scores = {}) {
  const family = Number(scores.family) || 0;
  const romantic = Number(scores.romantic) || 0;
  const business = Number(scores.business) || 0;
  return {
    friend: 0.5,
    business: business >= 3
      ? Math.min(0.79, 0.58 + Math.log1p(business - 2) * 0.045)
      : 0,
    romantic: romantic >= 100
      ? 0.99
      : (romantic >= 4 ? Math.min(0.90, 0.82 + (romantic - 4) * 0.01) : 0),
    family: family >= 100
      ? 1
      : (family >= 10 ? Math.min(0.93, 0.86 + (family - 10) * 0.005) : 0),
  };
}

// Exactly one winner. Manual overrides are applied later by graph.mjs and
// remain authoritative; this ranking is only the inferred fallback.
export function guessRelationshipRole(scores = {}) {
  const likelihoods = relationshipRoleLikelihoods(scores);
  return RELATIONSHIP_ROLES.reduce((winner, role) =>
    likelihoods[role] > likelihoods[winner] ? role : winner
  , 'friend');
}

function normalizedName(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function personKeys(row, meta, idToKey) {
  if (row.source === 'linkedin' && meta.kind && meta.kind !== 'message') return null;
  if (threadKind(row, meta) === GROUP) return null;
  if (row.source === 'mail') {
    // The sender identifies an incoming email, while recipients identify an
    // owner-sent one. idToKey contains relationship identities but not the
    // owner, so folding every mapped participant handles both directions and
    // stays consistent with graph.mjs's mail attribution.
    const ids = [
      ...(Array.isArray(meta.from) ? meta.from : []),
      ...(Array.isArray(meta.to) ? meta.to : []),
      ...(Array.isArray(meta.cc) ? meta.cc : []),
    ].filter((value) => typeof value === 'string').map((value) => value.toLowerCase());
    return [...new Set(ids.map((id) => idToKey.get(id)).filter(Boolean))];
  }
  if (row.source === 'linkedin' && meta.kind === 'message' && typeof meta.from === 'string') {
    const name = normalizedName(meta.from);
    const key = name ? idToKey.get(`liname:${name}`) : null;
    return key ? [key] : [];
  }
  const id = meta.chat_handle ?? meta.handle ?? counterpartyFromThread(row, meta);
  const key = id ? idToKey.get(id) : null;
  return key ? [key] : [];
}

// One narrow scan, keyed by raw identifier then folded by the graph's current
// resolution. Only direct message/mail rows participate: a group member saying
// "my sister" must never label a relationship they are merely adjacent to.
//
// The lifetime and per-year scores are accumulated together. A relationship
// changing shape is the point of the year tabs: romantic language in 2019 must
// not brand the same person romantic in 2024. Keeping the lifetime result as a
// separate index still gives the all-time globe an honest overall label.
export function inferRelationshipRoleIndex(contextDb, idToKey, keyToName = new Map()) {
  const scoresByKey = new Map();
  const scoresByKeyYear = new Map();
  const nameRoles = new Map();
  for (const key of new Set(idToKey.values())) {
    const scores = { friend: 0, business: 0, romantic: 0, family: 0 };
    scoreRoleName(keyToName.get(key), scores);
    scoresByKey.set(key, scores);
    nameRoles.set(key, guessRelationshipRole(scores));
  }
  const rows = contextDb.prepare(
    "SELECT ts, source, text, meta FROM context WHERE source IN ('imessage','whatsapp','messenger'," +
      "'instagram','twitter','telegram','discord','slack','linkedin','mail') " +
      'AND text IS NOT NULL AND length(text) > 0'
  ).all();
  for (const row of rows) {
    let meta;
    try { meta = JSON.parse(row.meta ?? '{}') ?? {}; } catch { continue; }
    const keys = personKeys(row, meta, idToKey) ?? [];
    for (const key of keys) {
      const scores = scoresByKey.get(key) ?? { friend: 0, business: 0, romantic: 0, family: 0 };
      scoreRoleText(row.text, scores);
      scoresByKey.set(key, scores);

      const year = new Date(row.ts).getFullYear();
      if (!Number.isInteger(year)) continue;
      let byYear = scoresByKeyYear.get(key);
      if (!byYear) {
        byYear = new Map();
        scoresByKeyYear.set(key, byYear);
      }
      let yearScores = byYear.get(year);
      if (!yearScores) {
        yearScores = { friend: 0, business: 0, romantic: 0, family: 0 };
        // A saved identity such as "Mother" remains identity evidence in every
        // active year; ordinary message language is still isolated to its year.
        scoreRoleName(keyToName.get(key), yearScores);
        byYear.set(year, yearScores);
      }
      scoreRoleText(row.text, yearScores);
    }
  }
  return {
    roles: new Map([...idToKey.values()].map((key) => [key, guessRelationshipRole(scoresByKey.get(key))])),
    rolesByYear: new Map([...scoresByKeyYear].map(([key, byYear]) => [
      key,
      new Map([...byYear].map(([year, scores]) => [year, guessRelationshipRole(scores)])),
    ])),
    nameRoles,
  };
}

// Compatibility for the all-time callers and focused unit tests.
export function inferRelationshipRoles(contextDb, idToKey, keyToName = new Map()) {
  return inferRelationshipRoleIndex(contextDb, idToKey, keyToName).roles;
}
