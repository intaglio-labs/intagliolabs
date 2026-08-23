// Grouping people into firms and scoring relationship WARMTH — turning a flat
// list of 47 investor contacts into "Character VC (4 contacts, warm, met 9×)"
// and ranking by how live the relationship actually is, not just whether it
// exists.
//
// Pure functions over the graph's person objects. Firm and warmth are both
// CODE — no model — for the same reason identity is: the owner audits every
// grouping and every score.

// The firm a person belongs to. For investors the email DOMAIN is the firm
// (character.vc, forerunnerventures.com); the LinkedIn company is a nicer
// display name when present. Returns { key, label } — key groups, label shows.
// A person with no firm signal is their own singleton (key = their name).
export function firmOf(p) {
  // An investor domain from any email identifier is the strongest firm key.
  for (const id of p.identifiers ?? []) {
    const at = String(id).indexOf('@');
    if (at === -1) continue;
    const domain = String(id).slice(at + 1).toLowerCase();
    if (/(\.vc$|ventures?|capital|\bfund\b|partners)/u.test(domain)) {
      return { key: domain, label: p.linkedin?.company || prettyDomain(domain) };
    }
  }
  // Else a LinkedIn company, if the person has one.
  const co = p.linkedin?.company;
  if (typeof co === 'string' && co.trim()) {
    return { key: `co:${co.trim().toLowerCase()}`, label: co.trim() };
  }
  return { key: `solo:${p.name}`, label: p.name, solo: true };
}

// character.vc -> "Character", forerunnerventures.com -> "Forerunnerventures".
// Deliberately light: strip the TLD and title-case the label. The LinkedIn
// company name wins over this whenever it exists, so this is only the fallback.
function prettyDomain(domain) {
  const label = domain.replace(/\.[a-z.]+$/u, '').replace(/[.-]/gu, ' ');
  return label.replace(/\b\w/gu, (c) => c.toUpperCase());
}

// WARMTH: how live is this relationship, right now? Distinct from identity
// (are they an investor) and from depth (how much history). Warmth rewards the
// things that mean "I could call them and it would not be weird": they reply
// (reciprocity), they expressed interest in backing you (directional content),
// you have met in person, and it was recent. A cold decade-old cc and a warm
// active thread both "exist"; warmth is what separates them.
export function warmthScore(p) {
  const recency =
    p.dormancyDays === null
      ? 0.5 // on record but no inbound — neutral, not cold
      : p.dormancyDays < 90
        ? 3
        : p.dormancyDays < 365
          ? 1.5
          : p.dormancyDays < 730
            ? 0.5
            : 0;
  return (
    p.reciprocity * 3 +
    Math.min(p.content?.investor ?? 0, 6) * 1.2 +
    Math.min(p.metInPerson, 10) * 0.8 +
    recency +
    Math.log10(p.messages + 1)
  );
}

// A one-word warmth label for the chat line.
export function warmthLabel(w) {
  return w >= 6 ? 'warm' : w >= 3 ? 'lukewarm' : 'cold';
}

// Group ranked candidates into firms. Each firm carries its contacts (warmest
// first), the firm's best warmth (used to rank firms), and aggregates worth
// seeing at a glance. Solo people (no firm) come back as one-contact firms.
export function groupByFirm(candidates) {
  const firms = new Map();
  for (const p of candidates) {
    const firm = firmOf(p);
    if (!firms.has(firm.key)) {
      firms.set(firm.key, { key: firm.key, label: firm.label, solo: firm.solo === true, contacts: [] });
    }
    firms.get(firm.key).contacts.push({ ...p, warmth: warmthScore(p) });
  }
  const out = [];
  for (const firm of firms.values()) {
    firm.contacts.sort((a, b) => b.warmth - a.warmth);
    firm.warmth = firm.contacts[0].warmth; // the firm is as warm as its warmest contact
    firm.metInPerson = firm.contacts.reduce((n, c) => n + c.metInPerson, 0);
    firm.minDormancy = firm.contacts
      .map((c) => c.dormancyDays)
      .filter((d) => d !== null)
      .reduce((m, d) => (m === null ? d : Math.min(m, d)), null);
    out.push(firm);
  }
  out.sort((a, b) => b.warmth - a.warmth);
  return out;
}
