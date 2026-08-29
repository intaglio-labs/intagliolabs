// Rebuildable links from raw context rows to canonical people.
//
// The link table stores no corpus prose. It answers the structural question
// "which person participated in this event, and how?" so deep search can join
// the existing local FTS index to one person without rebuilding identity or
// reparsing every connector row for each question.

import {
  normIdentifier,
  personSignalsForRow,
  RELATIONSHIP_SOURCES,
} from './graph.mjs';

function parseMeta(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  try {
    const value = JSON.parse(raw ?? '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function graphIndex(graph) {
  const exact = new Map();
  const loose = new Map();
  const ambiguousLoose = new Set();
  for (const person of graph) {
    for (const identifier of person.identifiers ?? []) {
      const raw = String(identifier);
      exact.set(raw.toLowerCase(), person);
      const normalized = normIdentifier(raw);
      if (!normalized) continue;
      const prior = loose.get(normalized);
      if (prior && prior.key !== person.key) ambiguousLoose.add(normalized);
      else if (!prior) loose.set(normalized, person);
    }
  }
  for (const identifier of ambiguousLoose) loose.delete(identifier);
  return {
    personFor(identifier) {
      const raw = String(identifier ?? '');
      return exact.get(raw.toLowerCase()) ?? loose.get(normIdentifier(raw)) ?? null;
    },
  };
}

function linkConfidence(person, identifier) {
  const evidence = (person.identityEvidence ?? []).filter((item) => item.identifier === identifier);
  const linkage = evidence.filter((item) => item.type !== 'source_observed');
  if (linkage.length === 0) return 1;
  return Math.max(...linkage.map((item) => Number(item.confidence ?? 1)));
}

function conversationKey(row, meta, signal) {
  let value;
  if (row.source === 'mail') {
    value = meta.thread_id ?? meta.threadId ?? meta.gmail_thread_id ?? signal.id;
  } else if (row.source === 'linkedin' && meta.kind === 'message') {
    value = meta.conversation_id ?? meta.thread_id ?? signal.id;
  } else {
    value = meta.chat_guid ?? meta.chat_handle ?? meta.thread_id ?? meta.conversation_id;
  }
  value ??= row.entity_id ?? row.id;
  return `${row.source}:${String(value)}`;
}

function relationshipRows(contextDb, contextIds) {
  const sourcePlaceholders = RELATIONSHIP_SOURCES.map(() => '?').join(',');
  if (!Array.isArray(contextIds)) {
    return contextDb.prepare(
      `SELECT id, ts, source, speaker, meta, entity_id FROM context WHERE source IN (${sourcePlaceholders})`
    ).all(...RELATIONSHIP_SOURCES);
  }
  const ids = [...new Set(contextIds.map(Number).filter(Number.isFinite))];
  const rows = [];
  for (let index = 0; index < ids.length; index += 500) {
    const chunk = ids.slice(index, index + 500);
    rows.push(...contextDb.prepare(
      `SELECT id, ts, source, speaker, meta, entity_id FROM context ` +
        `WHERE source IN (${sourcePlaceholders}) AND id IN (${chunk.map(() => '?').join(',')})`
    ).all(...RELATIONSHIP_SOURCES, ...chunk));
  }
  return rows;
}

export function buildPersonEventLinkBatch(
  contextDb,
  graph,
  { owner = { addresses: new Set(), names: [] }, contextIds = null } = {}
) {
  const index = graphIndex(graph);
  const rows = relationshipRows(contextDb, contextIds);
  const links = new Map();
  let unresolved = 0;
  for (const row of rows) {
    const meta = parseMeta(row.meta);
    for (const signal of personSignalsForRow(row, meta, owner)) {
      const person = index.personFor(signal.id);
      if (!person) {
        unresolved += 1;
        continue;
      }
      const role = signal.role ?? 'participant';
      const key = `${person.key}\u0000${row.id}\u0000${role}`;
      const link = {
        personKey: person.key,
        contextId: Number(row.id),
        source: row.source,
        role,
        authored: signal.authored === true,
        ownerAuthored: signal.ownerAuthored === true,
        room: signal.room === true,
        confidence: linkConfidence(person, signal.id),
        conversationKey: conversationKey(row, meta, signal),
      };
      const prior = links.get(key);
      if (!prior || link.confidence > prior.confidence) links.set(key, link);
    }
  }
  return { links: [...links.values()].sort((a, b) =>
    a.personKey.localeCompare(b.personKey)
      || a.contextId - b.contextId
      || a.role.localeCompare(b.role)
  ), unresolved };
}

export function buildPersonEventLinks(contextDb, graph, options = {}) {
  return buildPersonEventLinkBatch(contextDb, graph, options).links;
}

const SELECT_LINKED =
  'SELECT pel.person_key, pel.role, pel.authored, pel.owner_authored, pel.room, pel.confidence, ' +
  'pel.conversation_key, c.id, c.ts, c.source, c.speaker, c.text, c.meta, c.entity_id ';

export function linkedEvidenceRows(
  db,
  {
    sources = [], roles = [], authored = null, ownerAuthored = null, authoredOrOwner = false,
    from = null, to = null, fts = null, limit = 6000,
  } = {}
) {
  const params = [];
  const clauses = [];
  const fromSql = fts
    ? 'FROM context_fts JOIN context c ON c.id = context_fts.rowid ' +
      'JOIN person_event_links pel ON pel.context_id = c.id '
    : 'FROM person_event_links pel JOIN context c ON c.id = pel.context_id ';
  if (fts) {
    clauses.push('context_fts MATCH ?');
    params.push(fts);
  }
  if (sources.length > 0) {
    clauses.push(`pel.source IN (${sources.map(() => '?').join(',')})`);
    params.push(...sources);
  }
  if (roles.length > 0) {
    clauses.push(`pel.role IN (${roles.map(() => '?').join(',')})`);
    params.push(...roles);
  }
  if (authored !== null) {
    clauses.push('pel.authored = ?');
    params.push(authored ? 1 : 0);
  }
  if (ownerAuthored !== null) {
    clauses.push('pel.owner_authored = ?');
    params.push(ownerAuthored ? 1 : 0);
  }
  if (authoredOrOwner) clauses.push('(pel.authored = 1 OR pel.owner_authored = 1)');
  if (Number.isFinite(from)) {
    clauses.push('c.ts >= ?');
    params.push(from);
  }
  if (Number.isFinite(to)) {
    clauses.push('c.ts <= ?');
    params.push(to);
  }
  const sql = SELECT_LINKED + fromSql +
    (clauses.length > 0 ? `WHERE ${clauses.join(' AND ')} ` : '') +
    'ORDER BY c.ts DESC, c.id DESC LIMIT ?';
  return db.prepare(sql).all(...params, limit).map((row) => ({
    ...row,
    authored: Number(row.authored) === 1,
    ownerAuthored: Number(row.owner_authored) === 1,
    room: Number(row.room) === 1,
    confidence: Number(row.confidence),
  }));
}
