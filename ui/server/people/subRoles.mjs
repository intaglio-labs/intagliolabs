// Sub-role tags over the LinkedIn export: a deterministic, local read of
// `position` (and, for the ambiguous "Partner" title, `company`) into a
// closed set of investor/founder/operator labels a "founder" or "investor"
// mode can filter on.
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

// Investor words that are unambiguous on their own -- everything except a
// bare "Partner", which a law, consulting or accounting firm uses just as
// often as a fund does.
const INVESTOR_STRONG = /\b(?:general\s+partner|managing\s+partner|gp|principal|investor|ventures?|vc|angel|capital|fund(?:s|ing)?|investing)\b/iu;

const BARE_PARTNER = /\bpartner\b/iu;

// Firm-side words that resolve the ambiguous bare "Partner" title, checked
// against the title itself (e.g. "Partner at Example Capital") and, when the
// caller supplies one, the company field too.
const FIRM_WORDS = /\b(?:capital|ventures?|vc|fund|partners)\b/iu;

// "Founding Engineer" and similar "founding <role>" phrases never match here:
// the word is "founding", not "founder", and the two are different tokens
// under a word boundary.
const FOUNDER_WORDS = /\b(?:co-?founder|founder|ceo|chief\s+executive(?:\s+officer)?|owner)\b/iu;

const OPERATOR_WORDS = /\b(?:head\s+of|vp|vice\s+president|director|chief\s+(?:\w+\s+){1,3}officer|cto|coo|cfo|cpo|cmo)\b/iu;

function isInvestor(title, company) {
  if (SERVICE_PROVIDER.test(title)) return false;
  if (INVESTOR_STRONG.test(title)) return true;
  if (BARE_PARTNER.test(title)) {
    return FIRM_WORDS.test(title) || FIRM_WORDS.test(company);
  }
  return false;
}

function isFounder(title) {
  return FOUNDER_WORDS.test(title);
}

function isOperator(title) {
  return OPERATOR_WORDS.test(title);
}

function deriveSubRoles(position, company) {
  const title = String(position ?? '');
  const co = String(company ?? '');
  const roles = new Set();
  if (isInvestor(title, co)) roles.add('investor');
  if (isFounder(title)) roles.add('founder');
  // Operator is the fallback senior-title read, only when neither a founder
  // nor an investor word already decided this person's tag.
  if (roles.size === 0 && isOperator(title)) roles.add('operator');
  return [...roles].sort();
}

function canonicalSubRoles(list) {
  return [...new Set((Array.isArray(list) ? list : []).filter((role) => SUB_ROLE_SET.has(role)))].sort();
}

// Position-only derivation. Firm-side words still resolve an ambiguous bare
// "Partner" when they appear in the title text itself (e.g. "Partner at
// Example Capital"); subRolesFor additionally checks the company field.
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
