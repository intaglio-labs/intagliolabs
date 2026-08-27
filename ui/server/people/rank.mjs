// Ranking the people graph against a NEED — the reusable core under the
// mentor search (experiments/mentor-search/PROTOCOL.md).
//
// Pure and transparent on purpose. A person-search that decides who the owner
// should reconnect with is exactly the kind of judgement that must be legible
// code, not a model's inscrutable vibe: every candidate's score decomposes
// into named reasons the owner can audit. The model's ONLY job downstream is
// to write one human sentence from evidence code already selected — it never
// picks who is on the list.
//
// A "need" is declarative: which seniority signals matter, whether the person
// must be reachable by a real message channel, and how to weight depth of
// history against seniority against dormancy. The mentor need is one preset;
// the same engine answers "who could intro me to X" or "who have I dropped"
// by swapping the spec.

// Seniority is read off the LinkedIn title, because that is the one place the
// corpus states "operates ahead of me" explicitly. Word-boundary matches, most
// senior first — a Founder outranks a Lead.
import { activityInWindow } from './profile.mjs';

const SENIORITY_TIERS = [
  { re: /\b(founder|co-?founder|ceo|cto|coo|chief|president|managing partner|general partner|partner|principal|investor|venture)\b/iu, points: 5 },
  { re: /\b(vp|vice president|head of|director|gm|general manager)\b/iu, points: 3 },
  { re: /\b(lead|principal engineer|staff|senior manager|founding)\b/iu, points: 2 },
];

export function seniorityScore(linkedin) {
  const hay = `${linkedin?.position ?? ''} ${linkedin?.company ?? ''}`;
  for (const tier of SENIORITY_TIERS) if (tier.re.test(hay)) return tier.points;
  return linkedin ? 1 : 0; // on LinkedIn at all is a weak positive
}

// Depth of the actual relationship — the "real history" half. Log-damped
// message volume so a chatty friend does not swamp everyone, plus the signals
// that a bond is two-way and embodied.
export function depthScore(p) {
  return (
    Math.log10(p.messages + 1) * 2 +
    p.reciprocity * 4 +
    Math.min(p.metInPerson, 12) * 0.5 +
    (p.channelCount - 1) * 1.5 +
    Math.min(p.relationshipDays / 365, 6) * 0.5
  );
}

// Can the owner actually reach them tomorrow? A LinkedIn-only tie cannot be
// texted; a phone/mail thread can. The mentor need REQUIRES this — "could
// text tomorrow without it being weird" is in the card.
export function reachable(p) {
  return p.channels.some((c) => c === 'imessage' || c === 'whatsapp' || c === 'mail');
}

// The mentor preset. Weights are declared here, once, so tuning is a visible
// diff and the write-up can cite them.
export const MENTOR_NEED = Object.freeze({
  label: 'mentor for the founder stretch',
  requireReachable: true,
  // A real bond that has gone a little quiet is the sweet spot — not a
  // stranger, not someone messaged yesterday. This rewards dormancy in a band
  // and ignores it outside.
  dormancyBandDays: [30, 900],
  weights: { depth: 1, seniority: 2.5, dormancyBand: 1.5 },
  minDepth: 3,
});

// IS this person actually an investor — someone who deploys capital — by
// role or firm? A FOUNDER IS NOT: a founder is a peer on the other side of
// the table, and rewarding "Founder" is exactly what filled the first list
// with founder friends. So founder/CEO titles score zero here; investor
// titles (Partner, Principal, Angel, GP) and investor firms (…Ventures,
// …Capital, …Partners, …Fund) score, and a title AND a firm together score
// highest.
// An INVESTOR EMAIL DOMAIN is the strongest and cleanest signal there is —
// nate@newstack.vc, danny@lux.vc, jz@character.vc are investors by their
// address alone, and most of them are email-only contacts with no LinkedIn
// row at all. A `.vc` TLD, or a domain containing ventures/capital/vc, is a
// VC firm; the generic ".capital"/"partners" get a word boundary so
// "capitalone.com" and a law firm's "partners" do not over-fire.
export function investorDomain(identifiers = []) {
  for (const id of identifiers) {
    const at = String(id).indexOf('@');
    if (at === -1) continue;
    const domain = String(id).slice(at + 1).toLowerCase();
    if (/\.vc$/u.test(domain)) return true;
    if (/\b(ventures?|vcfund|venturecapital)\b/u.test(domain)) return true;
    if (/(ventures?|capital|venturepartners)\.[a-z]+$/u.test(domain)) return true;
  }
  return false;
}

// Is this person an investor — by email domain (strongest), or by LinkedIn
// role/firm? A FOUNDER IS NOT: rewarding "Founder" is what filled the first
// list with peers. Takes the whole person so it can read the email domain,
// not just the LinkedIn row.
export function investorIdentity(p) {
  if (investorDomain(p?.identifiers ?? [])) return 5;
  const linkedin = p?.linkedin;
  if (!linkedin) return 0;
  const pos = (linkedin.position ?? '').toLowerCase();
  const co = (linkedin.company ?? '').toLowerCase();
  const investorTitle = /\b(partner|principal|angel|investor|gp|general partner|managing director|venture)\b/u.test(pos);
  const investorFirm = /\b(ventures?|capital|\bpartners\b|\bfund\b|\bvc\b|angel)\b/u.test(co);
  if (investorTitle && investorFirm) return 5;
  if (investorTitle || investorFirm) return 3;
  return 0; // a founder/operator title alone is not investor identity
}

// The investor need, redefined to the owner's terms (2026-08-21): "someone I
// previously talked to about investing IN ME." Directional content
// (people/graph.mjs CONTENT_SIGNALS.investor) carries the definition;
// investor IDENTITY confirms it; and depth is deliberately near-zero, because
// a real investor might live in a dozen emails, not two thousand texts —
// weighting volume was floating friends to the top. A candidate must show the
// directional content OR investor identity; neither, not a candidate.
export const INVESTOR_NEED = Object.freeze({
  label: 'investors who talked about backing you',
  // "Textable tomorrow" is GONE for investors (owner, 2026-08-21). That rule
  // was a mentor concept — you reconnect with a mentor by texting. An investor
  // you're connected to on LinkedIn but never had a phone thread with is still
  // a real past investor contact, and this is what lets the whole LinkedIn
  // connections graph become candidates.
  requireReachable: false,
  // NO DORMANCY BAND (owner, 2026-08-21): there is no "sweet spot" of
  // time-ago for a past investor — one you emailed last month and one from
  // your earliest days both count. Timing gives no bonus and no penalty.
  dormancyBandDays: null,
  contentSignal: 'investor',
  identityFn: investorIdentity,
  identityLabel: 'investor',
  requireContentOrIdentity: true,
  weights: { depth: 0.3, identity: 2.5, content: 3.5 },
  minDepth: 1,
});

function contentScore(p, signal) {
  if (!signal) return 0;
  const hits = p.content?.[signal] ?? 0;
  // Log-damped: five threads about raising is a strong signal; fifty is not
  // ten times stronger, it is a running joke or a newsletter.
  return hits > 0 ? Math.log2(hits + 1) : 0;
}

function dormancyBandScore(p, band) {
  if (p.dormancyDays === null) return 0;
  const [lo, hi] = band;
  if (p.dormancyDays < lo || p.dormancyDays > hi) return 0;
  // Peak in the middle of the band, tapering to the edges.
  const mid = (lo + hi) / 2;
  return 1 - Math.abs(p.dormancyDays - mid) / (hi - mid);
}

// Score one person for a need. Returns { score, reasons } — reasons is the
// audit trail, always, so no number is unexplained.
export function scoreForNeed(p, need = MENTOR_NEED) {
  const reasons = [];
  if (need.requireReachable && !reachable(p)) return { score: 0, reasons: ['not reachable by message'] };

  const depth = depthScore(p);
  if (depth < (need.minDepth ?? 0)) return { score: 0, reasons: ['relationship too thin'] };

  // An explicit era filter (`activeWindow: ['2020-01', '2022-12']` -- see
  // search.mjs detectEraWindow): the owner named a WHEN, and a person with no
  // contact inside those months is a wrong answer however strong otherwise.
  // A hard gate, not a weight, for that reason.
  let windowActivity = null;
  if (need.activeWindow) {
    windowActivity = activityInWindow(p.timeline ?? [], need.activeWindow[0], need.activeWindow[1]);
    if (windowActivity.messages + windowActivity.met === 0) {
      return { score: 0, reasons: ['no contact inside the asked window'] };
    }
  }

  // Identity: a need may supply its own identity function (the investor need
  // uses one that rewards VC/angel/firm and IGNORES founder); otherwise the
  // general seniority tiers apply. The score line uses whichever ran.
  // identityFn takes the whole person (it may read the email domain);
  // the default seniority path takes just the linkedin row.
  const identity = need.identityFn ? need.identityFn(p) : seniorityScore(p.linkedin);
  const dorm = need.dormancyBandDays ? dormancyBandScore(p, need.dormancyBandDays) : 0;
  const content = contentScore(p, need.contentSignal);

  // The investor gate: directional content OR investor identity. Neither means
  // not a candidate, however chatty or senior — this is what keeps founder
  // friends and generic startup talk off the list.
  if (need.requireContentOrIdentity && content === 0 && identity === 0) {
    return { score: 0, reasons: ['no sign they talked about backing you'] };
  }
  // The older, looser gate for content needs without the strict flag.
  if (need.contentSignal && !need.requireContentOrIdentity && need.requireContent !== false && content === 0 && identity < 3) {
    return { score: 0, reasons: ['no talk of the topic on record'] };
  }

  const w = need.weights;
  const score =
    depth * (w.depth ?? 0) +
    identity * (w.identity ?? w.seniority ?? 0) +
    dorm * (w.dormancyBand ?? 0) +
    content * (w.content ?? 0);

  if (identity >= 3 && p.linkedin?.position) reasons.push(`${need.identityLabel ?? 'senior'}: ${p.linkedin.position}${p.linkedin.company ? ' @ ' + p.linkedin.company : ''}`);
  else if (identity >= 3 && need.identityFn) {
    // Investor identified by email domain, no LinkedIn title — name the domain.
    const dom = (p.identifiers ?? []).map((id) => String(id).split('@')[1]).find((d) => d && /(\.vc$|ventures?|capital)/u.test(d));
    reasons.push(dom ? `${need.identityLabel ?? 'senior'} domain: ${dom}` : (need.identityLabel ?? 'senior'));
  } else if (identity > 0 && p.linkedin) reasons.push('on linkedin');
  if (p.metInPerson > 0) reasons.push(`met in person ${p.metInPerson}×`);
  if (p.reciprocity >= 0.4) reasons.push(`two-way (${p.reciprocity})`);
  if (p.messages >= 50) reasons.push(`${p.messages} messages`);
  if (dorm > 0) reasons.push(`quiet ${Math.round(p.dormancyDays / 30)}mo — reconnect window`);
  if (p.channelCount >= 2) reasons.push(`${p.channelCount} channels`);
  if (need.contentSignal && (p.content?.[need.contentSignal] ?? 0) > 0) {
    reasons.push(`${p.content[need.contentSignal]} threads mention ${need.contentSignal} topic`);
  }
  if (windowActivity !== null) {
    reasons.push(
      `in window: ${windowActivity.messages} messages` +
        (windowActivity.met > 0 ? `, met ${windowActivity.met}×` : '')
    );
  }

  return { score: Math.round(score * 100) / 100, reasons };
}

// Rank the whole graph for a need. Excludes obvious non-people (the owner,
// no-reply-shaped names) by leaving that to the graph's own filtering plus a
// small name guard here.
// Non-people: automated senders and role addresses. Newsletters are the
// content signal's worst false positive — a fundraising newsletter uses the
// exact vocabulary in every issue — so the automated-sender shapes
// (mail./newsletter@/updates@/hello@ and the like) are named here. A real
// investor writes from a personal address; this misses the rare one at a
// role address, which the owner catches by eye.
const NON_PERSON =
  /\b(no-?reply|do-?not-?reply|notification|newsletter|updates?@|mailer|team@|support@|info@|hello@|contact@|homescreen|digest|guest of)\b/iu;
// Role / automated LOCAL PARTS — the @-prefix shapes a service uses and a
// person does not. Extended after morning-brew, arc and adobesign slipped
// through the investor list: crew@, members@, automated@, and the like.
const ROLE_LOCALPART =
  /^(automated|members?|crew|hello|hi|notifications?|updates?|news|newsletter|digest|billing|receipts?|invoices?|orders?|noreply|no-reply|donotreply|mailer|marketing|events?|community|admin|help|care|service|accounts?|adobesign|docusign|calendar|meet|invite)[@+]/iu;
const AUTOMATED_DOMAIN = /@(mail|email|e|newsletter|news|updates?|notifications?|mailer|send|smtp|mktomail|mailgun)\./iu;
// Newsletter PLATFORMS: a substack/beehiiv/mailchimp address is a subscription,
// not a person the owner talked to — and these are the content signal's next
// worst false positive after role addresses (a fundraising newsletter hits the
// vocabulary every issue). Whole-domain match, so `x@substack.com` is dropped.
const NEWSLETTER_PLATFORM = /@(substack\.com|beehiiv\.com|mailchimp|mailchimpapp|convertkit|ghost\.io|buttondown|revue|tinyletter|list-manage)/iu;

// AN SMS SHORT CODE IS NOT A PERSON. Every rule above is an EMAIL shape, and on
// a corpus that is 85% iMessage they caught nothing at all: 152 short codes were
// sitting in the graph as people, 12% of it, contributing roughly 1,950
// messages, their notification text becoming somebody's topic chips (a
// pharmacy, a retailer, a bank, a weather alert).
//
// The test is length, and it is high precision because no real phone number is
// this short once you have a country code: a bare run of digits, no `+`, six or
// fewer. Measured over the owner's corpus, the identities this matches are 3, 4,
// 5 and 6 digits long, NONE of them has a name from Contacts, and there are no
// 7-, 8- or 9-digit bare identifiers at all -- so the local-number-without-a-
// country-code case this could otherwise catch does not arise here. Anything
// carrying a `+` or a letter is left alone, which is every international number
// and every WhatsApp LID.
const SHORT_CODE = /^\d{1,6}$/u;

// APPLE MESSAGES FOR BUSINESS is the other half of the same gap, arrived at
// independently: a sender whose iMessage handle is "urn:biz:<uuid>" is a company
// texting through Apple's business channel. Unlike the short code this needs no
// heuristic at all — the URN is Apple's OWN declaration that the sender is not a
// person. Seven sat in the owner's list as people (2026-08-25), one wearing
// order-confirmation topic chips.
const BUSINESS_URN = /^urn:biz:/iu;

// A non-person: an automated sender, a role address, an SMS short code, or a
// Messages-for-Business URN, by name or by any of its identifiers. Exported so
// the constellation (people/map.mjs) drops the same newsletters and no-reply
// handles the ranker does, from one definition rather than a second copy that
// drifts.
export function isNonPerson(p) {
  if (NON_PERSON.test(p.name) || BUSINESS_URN.test(p.name)) return true;
  return (p.identifiers ?? []).some(
    (id) =>
      AUTOMATED_DOMAIN.test(id) ||
      NEWSLETTER_PLATFORM.test(id) ||
      ROLE_LOCALPART.test(id) ||
      SHORT_CODE.test(String(id).trim()) ||
      BUSINESS_URN.test(id)
  );
}

export function rankForNeed(graph, need = MENTOR_NEED, { limit = Infinity } = {}) {
  const scored = [];
  for (const p of graph) {
    if (isNonPerson(p)) continue;
    const { score, reasons } = scoreForNeed(p, need);
    if (score > 0) scored.push({ ...p, score, reasons });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// The evidence a composer is handed for one candidate — code-computed facts
// and the person's own name only. NO message text (that stays excluded from
// every model everywhere); the model writes the "why" from these facts, it
// does not read anyone's words.
export function evidenceLine(p) {
  const last =
    p.dormancyDays === null
      ? 'no inbound on record'
      : p.dormancyDays > 365
        ? `last heard from ~${(p.dormancyDays / 365).toFixed(1)} years ago`
        : `last heard from ~${Math.round(p.dormancyDays / 30)} months ago`;
  const title = p.linkedin?.position
    ? `${p.linkedin.position}${p.linkedin.company ? ' at ' + p.linkedin.company : ''}`
    : 'no title on record';
  const contentBits = Object.entries(p.content ?? {})
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} threads touch ${k} topics`);
  return (
    `${p.name} — ${title}; ${last}; ${p.messages} messages over ${p.channels.join('/')}, ` +
    `reciprocity ${p.reciprocity}${p.metInPerson ? `, met in person ${p.metInPerson}×` : ''}` +
    `${contentBits.length ? '; ' + contentBits.join(', ') : ''}.`
  );
}
