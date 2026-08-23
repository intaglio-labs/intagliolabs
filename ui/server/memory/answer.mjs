// Composition: turning accepted claims plus a question into one short answer.
//
// This lives here rather than in the courier because it now has two callers —
// `hz ask` over iMessage and POST /vault/ask for the desktop widget — and the
// rules below must be identical for both. A second copy would drift, and the
// thing that would drift first is the envelope, which is the read-side
// poisoning defence.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ANSWER_PROMPT_PATH = join(HERE, '..', '..', '..', 'prompts', 'answer_from_claims.md');
export const EPISODIC_PROMPT_PATH = join(HERE, '..', '..', '..', 'prompts', 'answer_episodic.md');

// The episodic prompt: raw records instead of accepted claims. A separate
// file, not a variant paragraph, because the two envelopes make different
// promises — claims were human-approved, records were not, and the prompt
// that reads records has to say so.
export function readEpisodicPrompt() {
  return readFileSync(EPISODIC_PROMPT_PATH, 'utf8');
}

// The exact sentence used when there is no accepted support. One definition, so
// the widget and Messages abstain identically, and so it cannot drift into an
// apology or an offer to go and find out — both of which invite the owner to
// treat silence as a prompt to rephrase rather than as an answer.
export const ABSTAIN = "nothing in what i've got covers that";

export function readAnswerPrompt() {
  return readFileSync(ANSWER_PROMPT_PATH, 'utf8');
}

// The data envelope. The delimiters are not decoration: they are what lets the
// prompt say "everything between these markers is quoted material", which is
// the whole read-side defence against an accepted claim shaped like an
// instruction. The question is flattened so it cannot fake a new section.
export function buildAnswerPrompt({ lines, question }) {
  return (
    'BEGIN NOTES\n' +
    lines.join('\n') +
    '\nEND NOTES\n\n' +
    `Question: ${String(question).replace(/\s+/gu, ' ').trim()}`
  );
}

// Model output goes to a person, so it is bounded rather than trusted to be
// brief. A model that starts writing an essay gets cut off; markdown gets
// stripped, because this lands in a text bubble or a small chat panel.
export function tidyReply(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/^\s*[-*#>]+\s*/gmu, '')
    .replace(/\*\*?/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (text.length === 0) return null;
  return text.length > 600 ? `${text.slice(0, 597)}...` : text;
}

// The distinct source labels behind an answer. NAMES ONLY — `imessage`,
// `notes`. A row object here would be a corpus-boundary breach, and the widget
// contract says so in as many words.
export function sourceLabels(claims) {
  return [...new Set(claims.map((c) => c.source))].sort();
}
