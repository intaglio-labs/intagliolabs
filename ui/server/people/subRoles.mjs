// Sub-role tags over the LinkedIn export: a deterministic, local read of
// `position` (and, for the ambiguous "Partner"/"Principal"/"Venture"/"Owner"/
// "CEO" titles, `company`) into a closed set of investor/founder/operator
// labels a "founder" or "investor" mode can filter on.
//
// Same posture as roles.mjs: this is a small, reviewable interpretation
// layer, not a model call. The owner's own correction (config.personSubRoles)
// always wins over whatever this file guesses.

export const SUB_ROLES = Object.freeze(['founder', 'investor', 'operator']);
const SUB_ROLE_SET = new Set(SUB_ROLES);

// Service-provider titles use the same vocabulary as venture investing
// ("Financial Advisor", "Insurance Broker", "Mortgage Broker") without being
// it. This exclusion is checked before any investor word, so it always wins:
// a wealth manager who also happens to say "capital" in a firm name is still
// not an investor for our purposes.
const SERVICE_PROVIDER = /\b(?:wealth|financial\s+advis(?:e|o)r|advis(?:e|o)r|raymond\s+james|insurance|mortgage|real\s+estate|realtor|broker|recruit\w*|talent|sales|account\s+executive|business\s+development|bdr|sdr|marketing)\b/iu;

// "Investor Relations" is a corporate-communications function, not an
// investor -- checked before the (otherwise unconditional) bare "investor"
// word so it always wins.
const INVESTOR_RELATIONS = /\binvestor\s+relations\b/iu;

// "Principal <engineering/science role>" is a seniority title borrowed from
// the same word VC firms use for junior investment staff. Checked before any
// investor word (including the weak-partner/principal path below) so it
// always wins -- even for a founder, whose founder tag is unaffected since
// this only excludes the investor read (see isFounder).
const PRINCIPAL_ROLE = /\bprincipal\s+(?:software|research|data|hardware|systems|ml|machine\s+learning)?\s*(?:engineer|scientist|architect|consultant|designer|analyst)\b/iu;

// Incubators, accelerators and university/college innovation programs use
// "venture" and "founder" vocabulary for staff who aren't check-writers.
// Checked against title and company both, since the tell is often the
// employer ("XYZ University Innovation Lab") rather than the title.
const INSTITUTIONAL = /\b(?:incubat(?:or|ion)|accelerator|innovation\s+lab|universit(?:y|ies)|colleges?|schools?)\b/iu;

// Investor words that are unambiguous on their own, regardless of company:
// everything except "principal", "partner" and bare "venture", which a law,
// consulting, accounting or engineering-titled role uses just as often as a
// fund does. "General Partner" and "Managing Partner" are exempted from that
// ambiguity even though they contain "partner".
const INVESTOR_STRONG = /\b(?:general\s+partner|managing\s+partner|gp|investor|angel|capital|fund(?:s|ing)?|investing|vc)\b/iu;

// Same set, plus "venture" -- used only to resolve an ambiguous "partner" or
// "principal" off the title text itself (e.g. "Venture Partner"). Kept
// separate from INVESTOR_STRONG because bare "venture" is *not* strong on
// its own (see WEAK_VENTURE below); it only strengthens partner/principal.
const INVESTOR_STRONG_OR_VENTURE = /\b(?:general\s+partner|managing\s+partner|gp|investor|angel|capital|fund(?:s|ing)?|investing|vc|ventures?)\b/iu;

const WEAK_PARTNER_PRINCIPAL = /\b(?:partner|principal)\b/iu;
const WEAK_VENTURE = /\bventures?\b/iu;

// Fund-side words that resolve an ambiguous "partner"/"principal"/"venture"
// title, checked against the title itself (e.g. "Partner at Example Capital")
// and, when the caller supplies one, the company field too.
const FUND_SIDE_WORDS = /\b(?:capital|ventures?|venture\s+partners|vc|funds?|funding|partners|holdings|angels?|seed|growth\s+equity|investments)\b/iu;

// "Capital" is bank-like -- not fund-side -- immediately next to these
// words ("Capital One", "Capital Markets", "Capital Bank", "Bank Capital").
// Small explicit denylist rather than a general classifier: strip these
// phrases out before testing for fund-side words, so a bank whose name
// happens to contain "Capital" doesn't register as a fund.
const BANK_LIKE_CAPITAL = /\bcapital\s+(?:one|bank|markets|group)\b|\b(?:one|bank|markets|group)\s+capital\b/giu;

// Investing-platform brand names: staff at these companies are investor-side,
// but the brand names are compounds that defeat FUND_SIDE_WORDS' own word
// boundaries -- "AngelList" contains "angel" but not as a separate token, so
// \bangels?\b never matches it. The fix is not to loosen "angel" to a bare
// prefix match (that would also catch "Los Angeles"); instead this is a
// small, closed, explicitly-named list. Keep it closed: add a platform only
// after confirming its name isn't a substring of an unrelated common word.
const INVESTING_PLATFORMS = /\b(?:angellist|wefunder|seedinvest|republic\.co|stonks)\b/iu;

// "Founding Engineer" and similar "founding <role>" phrases never match here:
// the word is "founding", not "founder", and the two are different tokens
// under a word boundary. "Founder"/"co-founder" are unconditional founder
// words (subject only to the service-provider-company exclusion below);
// bare "owner" and bare "ceo"/"chief executive officer" are each handled on
// their own, since each is ambiguous in a different way (see isFounder).
const CORE_FOUNDER_WORDS = /\b(?:co-?founder|founder)\b/iu;
const CEO_WORDS = /\b(?:ceo|chief\s+executive(?:\s+officer)?)\b/iu;
const OWNER_WORD = /\bowner\b/iu;

// "Product Owner", "Technical Product Owner", "Business Owner", "Process
// Owner" are engineering/delivery titles, not company ownership -- "owner"
// never counts as a founder word when qualified this way.
const OWNER_DISQUALIFIED = /\b(?:product|technical|business|process)\s+(?:\w+\s+)?owner\b/iu;

// A founder-shaped title (founder, owner, or bare ceo) at one of these
// firms reads as that firm's own service line, not a startup the person
// built: a staffing/recruiting/consulting/agency/realty shop's "Founder" is
// running a services business, not the kind of company this tag is for.
const FOUNDER_COMPANY_SERVICE_PROVIDER = /\b(?:consult(?:ing|ants?)?|advisors?|advisory|staffing|recruit\w*|talent|agenc(?:y|ies)|realty)\b/iu;

const OPERATOR_WORDS = /\b(?:head\s+of|vp|vice\s+president|director|chief\s+(?:\w+\s+){1,3}officer|cto|coo|cfo|cpo|cmo)\b/iu;

function isFundSideText(text) {
  const stripped = String(text ?? '').replace(BANK_LIKE_CAPITAL, ' ');
  return FUND_SIDE_WORDS.test(stripped) || INVESTING_PLATFORMS.test(stripped);
}

function isInvestor(title, company) {
  if (SERVICE_PROVIDER.test(title)) return false;
  if (INVESTOR_RELATIONS.test(title)) return false;
  if (PRINCIPAL_ROLE.test(title)) return false;
  if (INSTITUTIONAL.test(title) || INSTITUTIONAL.test(company)) return false;

  if (INVESTOR_STRONG.test(title)) return true;

  if (WEAK_PARTNER_PRINCIPAL.test(title)) {
    // Fund-side words may resolve this off the title text itself (e.g.
    // "Partner at Example Capital", a single position string with no
    // separate company) or off the company field.
    return isFundSideText(title) || isFundSideText(company) || INVESTOR_STRONG_OR_VENTURE.test(title);
  }
  if (WEAK_VENTURE.test(title)) {
    // Checking the title here would be tautological -- it already contains
    // "venture", which is itself a fund-side word -- so only the company can
    // resolve a bare "venture" title (e.g. "Venture Lead").
    return isFundSideText(company);
  }

  // A bare "ceo"/"chief executive officer" -- with no explicit
  // founder/co-founder word alongside it -- at a fund-side company reads as
  // the investing principal running the fund, not a startup founder: tag
  // investor instead of (see isFounder) founder.
  if (CEO_WORDS.test(title) && !CORE_FOUNDER_WORDS.test(title)) {
    return isFundSideText(title) || isFundSideText(company);
  }

  return false;
}

function isFounder(title, company) {
  const hasCoreFounderWord = CORE_FOUNDER_WORDS.test(title);
  const hasCeoWord = CEO_WORDS.test(title);
  const hasBareOwner = OWNER_WORD.test(title) && !OWNER_DISQUALIFIED.test(title);
  if (!hasCoreFounderWord && !hasCeoWord && !hasBareOwner) return false;

  if (FOUNDER_COMPANY_SERVICE_PROVIDER.test(company)) return false;

  if (hasCoreFounderWord) return true;

  // Bare ceo/chief-executive-officer redirects to the investor tag (see
  // isInvestor) rather than founder when the company is fund-side.
  if (hasCeoWord) return !isFundSideText(title) && !isFundSideText(company);

  return hasBareOwner;
}

function isOperator(title) {
  return OPERATOR_WORDS.test(title);
}

function deriveSubRoles(position, company) {
  const title = String(position ?? '');
  const co = String(company ?? '');
  const roles = new Set();
  if (isInvestor(title, co)) roles.add('investor');
  if (isFounder(title, co)) roles.add('founder');
  // Operator is the fallback senior-title read, only when neither a founder
  // nor an investor word already decided this person's tag.
  if (roles.size === 0 && isOperator(title)) roles.add('operator');
  return [...roles].sort();
}

function canonicalSubRoles(list) {
  return [...new Set((Array.isArray(list) ? list : []).filter((role) => SUB_ROLE_SET.has(role)))].sort();
}

// Position-only derivation. Fund-side words still resolve an ambiguous
// "partner"/"principal"/"venture" when they appear in the title text itself
// (e.g. "Partner at Example Capital"); subRolesFor additionally checks the
// company field.
export function subRolesFromPosition(position) {
  return deriveSubRoles(position, '');
}

function overrideFor(overrides, key) {
  if (!overrides || key === undefined || key === null) return undefined;
  if (typeof overrides.get === 'function') return overrides.get(key);
  return Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : undefined;
}

// The full derivation for a projected person: an owner override (keyed by
// person.key, from config.personSubRoles) replaces the derived set entirely;
// otherwise the LinkedIn position/company on the person is read.
export function subRolesFor(person, overrides = {}) {
  const override = overrideFor(overrides, person?.key);
  if (override !== undefined) return canonicalSubRoles(override);
  const position = person?.linkedin?.position ?? '';
  const company = person?.linkedin?.company ?? '';
  return deriveSubRoles(position, company);
}
