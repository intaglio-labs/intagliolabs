// Privacy-safe live connector coverage audit.
//
// Hermes owns the corpus query and returns aggregates only. This command joins
// those aggregates to the connector scheduler's boolean/year checkpoints and
// activity queue. It never opens context.db and never prints names, addresses,
// room ids, entity ids, cursor values, message text, or credentials.
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { adminCoverage, DEFAULT_HERMES_BASE_URL } from './lib/ingestClient.mjs';
import { assertOwnerOnlyFile, defaultHermesTokenPath } from './lib/secrets.mjs';
import { openStateDb } from './lib/state.mjs';
import { yearlyBackfillCoverage } from './lib/yearlyBackfill.mjs';
import { defaultActivityPath, defaultConfigPath, loadConfig } from './daemon.mjs';
import { pendingPortalInviteCount } from './sources/matrix.mjs';

export const HISTORY_CONNECTORS = Object.freeze([
  'imessage',
  'calendar',
  'mail',
  'granola',
  'whatsapp',
  'matrix',
]);

export const AUDITED_SOURCES = Object.freeze([
  'imessage',
  'calendar',
  'mail',
  'granola',
  'whatsapp',
  'messenger',
  'instagram',
  'twitter',
  'telegram',
  'discord',
  'slack',
  'linkedin',
]);

const SOCIAL_SOURCES = new Set([
  'messenger', 'instagram', 'twitter', 'telegram', 'discord', 'slack', 'linkedin',
]);
const COORDINATOR = Object.freeze({
  ...Object.fromEntries(AUDITED_SOURCES.map((source) => [source, source])),
  messenger: 'matrix',
  instagram: 'matrix',
  twitter: 'matrix',
  telegram: 'matrix',
  discord: 'matrix',
  slack: 'matrix',
  linkedin: 'matrix',
});

const safeTaskName = (task) => {
  const platform = typeof task?.platform === 'string' && SOCIAL_SOURCES.has(task.platform)
    ? task.platform
    : null;
  if (platform) return platform;
  return HISTORY_CONNECTORS.includes(task?.connector) || task?.connector === 'contacts'
    ? task.connector
    : null;
};

export function sanitizeActivity(raw) {
  const phase = ['idle', 'waiting', 'syncing', 'maintaining'].includes(raw?.phase)
    ? raw.phase
    : null;
  const queue = Array.isArray(raw?.queue)
    ? raw.queue.map(safeTaskName).filter(Boolean)
    : [];
  const backfill = Array.isArray(raw?.backfill)
    ? raw.backfill.filter((name) => HISTORY_CONNECTORS.includes(name))
    : [];
  return {
    phase,
    // `waiting` activity carries the next scheduled task in the same top-level
    // fields as an active run. It is not current work: the ordered queue below
    // is the truthful place to report it.
    current: phase === 'syncing' || phase === 'maintaining' ? safeTaskName(raw) : null,
    queue,
    backfill,
    backfillYear: Number.isInteger(raw?.backfillYear) ? raw.backfillYear : null,
    estimate: typeof raw?.estimate === 'string' && /^~ \d+(?:\.\d)? hrs left$/u.test(raw.estimate)
      ? raw.estimate
      : null,
  };
}

export function buildCoverageReport({
  hermes,
  yearly,
  activity = sanitizeActivity({}),
  contacts = 0,
  pendingPortalInvites = 0,
} = {}) {
  const bySource = new Map(
    (hermes?.sources ?? [])
      .filter((row) => AUDITED_SOURCES.includes(row?.source))
      .map((row) => [row.source, row])
  );
  const byCoordinator = new Map(
    (yearly?.connectors ?? []).map((row) => [row.connector, row])
  );
  const activeSocial = new Set(
    [...activity.queue, activity.current].filter((name) => SOCIAL_SOURCES.has(name))
  );
  const sources = AUDITED_SOURCES.map((source) => {
    const row = bySource.get(source);
    // Matrix has one shared barrier for every currently linked social bridge.
    // Do not assign its pending/completed state to an unlinked platform merely
    // because that platform exists in the product roster.
    const history = SOCIAL_SOURCES.has(source) && !activeSocial.has(source)
      ? null
      : byCoordinator.get(COORDINATOR[source]);
    return {
      source,
      rows: Number(row?.rows ?? 0),
      conversations: row?.conversations === null || row?.conversations === undefined
        ? null
        : Number(row.conversations),
      oldestTs: Number.isFinite(row?.oldest_ts) ? Number(row.oldest_ts) : null,
      newestTs: Number.isFinite(row?.newest_ts) ? Number(row.newest_ts) : null,
      years: Array.isArray(row?.years)
        ? row.years.map(({ year, rows }) => ({ year: Number(year), rows: Number(rows) }))
        : [],
      completedYears: history?.completedYears ?? [],
      historyExhausted: history?.exhausted ?? false,
      historyPending: Boolean(history) && activity.backfill.includes(COORDINATOR[source]),
    };
  });
  return {
    generatedAt: new Date().toISOString(),
    sources,
    contacts: { records: Number(contacts) },
    history: {
      year: yearly?.year ?? null,
      complete: yearly?.complete ?? false,
    },
    transport: {
      pendingPortalInvites: Number(pendingPortalInvites),
    },
    queue: activity,
  };
}

const displayName = (source) => ({
  imessage: 'iMessage',
  whatsapp: 'WhatsApp',
  twitter: 'X',
  linkedin: 'LinkedIn',
}[source] ?? source[0].toUpperCase() + source.slice(1));

const day = (ts) => {
  if (ts === null) return '—';
  const date = new Date(ts);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : '—';
};
const number = (value) => new Intl.NumberFormat('en-US').format(value);

export function formatCoverageReport(report) {
  const headers = ['connector', 'rows', 'conversations', 'oldest', 'newest', 'completed years', 'remaining'];
  const rows = report.sources.map((source) => [
    displayName(source.source),
    number(source.rows),
    source.conversations === null ? '—' : number(source.conversations),
    day(source.oldestTs),
    day(source.newestTs),
    source.completedYears.length ? source.completedYears.join(', ') : '—',
    source.historyPending ? `year ${report.queue.backfillYear ?? report.history.year}`
      : source.historyExhausted ? 'complete'
        : '—',
  ]);
  rows.push(['Contacts', number(report.contacts.records), '—', '—', '—', '—', '—']);
  const widths = headers.map((header, index) => Math.max(
    header.length,
    ...rows.map((row) => String(row[index]).length)
  ));
  const line = (row) => row.map((cell, index) => String(cell).padEnd(widths[index])).join('  ').trimEnd();
  const out = [line(headers), line(widths.map((width) => '─'.repeat(width))), ...rows.map(line), ''];
  const active = report.queue.current ? `current: ${displayName(report.queue.current)}` : 'current: idle';
  const estimate = report.queue.estimate ? ` · ${report.queue.estimate}` : '';
  out.push(`${active}${estimate}`);
  out.push(`scheduled queue (${report.queue.queue.length}): ${
    report.queue.queue.length ? report.queue.queue.map(displayName).join(', ') : 'empty'
  }`);
  out.push(`Matrix portal invites pending: ${number(report.transport.pendingPortalInvites)}`);
  out.push(`yearly backfill: ${report.history.complete ? 'complete' : `year ${report.history.year}`}`);
  return out.join('\n');
}

function readActivity(path = defaultActivityPath()) {
  if (!existsSync(path)) return sanitizeActivity({});
  const raw = assertOwnerOnlyFile(path, {
    label: 'connectors activity',
    setupHint: 'start Intaglio Labs once to initialize connector activity',
  });
  try {
    return sanitizeActivity(JSON.parse(raw));
  } catch {
    throw new Error('connectors activity file is not valid JSON');
  }
}

export async function runCoverage({ json = false } = {}) {
  const config = loadConfig(defaultConfigPath());
  const state = openStateDb();
  try {
    const hermes = await adminCoverage({
      baseUrl: process.env.HAZLIE_HERMES_URL ?? config.hermesUrl ?? DEFAULT_HERMES_BASE_URL,
      tokenFile: defaultHermesTokenPath(),
    });
    const yearly = yearlyBackfillCoverage({ state, connectors: HISTORY_CONNECTORS });
    const contacts = Number(state.db.prepare('SELECT COUNT(*) AS n FROM contact_ids').get().n);
    const pendingPortalInvites = pendingPortalInviteCount(
      state.getCursor('matrix:pending-portal-invites')
    );
    const report = buildCoverageReport({
      hermes,
      yearly,
      activity: readActivity(),
      contacts,
      pendingPortalInvites,
    });
    process.stdout.write(`${json ? JSON.stringify(report, null, 2) : formatCoverageReport(report)}\n`);
    return report;
  } finally {
    state.close();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runCoverage({ json: process.argv.slice(2).includes('--json') }).catch((error) => {
    // No stack: this command is routinely run during setup, and a local path
    // or token-shaped value in an unexpected cause must not become pasteable
    // audit output. The fixed prefix is enough to route the failure.
    console.error(`coverage audit failed: ${error?.status ?? 'local'} (${error?.name ?? 'Error'})`);
    process.exitCode = 1;
  });
}
