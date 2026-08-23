// JSON-lines operational log for the connectors daemon.
//
// THE LOG NEVER CARRIES ROW TEXT. Not message bodies, not mail subjects, not
// note content, not contact names — counts, ids, durations, error messages,
// and schema facts only. The corpus boundary is hermes' database; a log line
// that quotes a message re-creates the corpus in a second file with none of
// hermes' deletion discipline. This is enforced at the seam below (a closed
// blocklist of field names that only ever mean content), and by policy in
// connectors/AGENTS.md for everything a blocklist cannot see.
import { closeSync, mkdirSync, openSync, statSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function defaultLogPath(home = homedir()) {
  return join(home, '.hazlie', 'logs', 'connectors.log');
}

// Field names that only ever name content. A field slipping past this list
// is still a policy violation — the list is a tripwire, not the boundary.
const FORBIDDEN_FIELDS = Object.freeze([
  'text',
  'body',
  'subject',
  'content',
  'snippet',
  'message',
  'transcript',
  'note',
]);

const LEVELS = Object.freeze(['info', 'warn', 'error']);

export function createLogger({ path = defaultLogPath() } = {}) {
  const dir = dirname(path);
  const previousUmask = process.umask(0o077);
  let fd;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // 0600 applies at creation; an existing file keeps whatever setup gave
    // it, which statSync verifies rather than silently widens.
    fd = openSync(path, 'a', 0o600);
    const mode = statSync(path).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      closeSync(fd);
      throw new Error(`connectors log must not be group/other readable: ${path} is ${mode.toString(8)}`);
    }
  } finally {
    process.umask(previousUmask);
  }

  let closed = false;
  const write = (level, event, fields = {}) => {
    if (closed) return; // a straggling timer after shutdown is not worth a crash
    if (typeof event !== 'string' || event.length === 0) {
      throw new Error('log event must be a non-empty string');
    }
    for (const key of Object.keys(fields)) {
      if (FORBIDDEN_FIELDS.includes(key.toLowerCase())) {
        throw new Error(
          `log field "${key}" is refused: the connectors log never carries row content ` +
            '(counts, ids, durations, schema facts only — connectors/AGENTS.md)'
        );
      }
    }
    const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
    writeSync(fd, line + '\n');
  };

  const logger = { path };
  for (const level of LEVELS) {
    logger[level] = (event, fields) => write(level, event, fields);
  }
  logger.close = () => {
    if (!closed) {
      closed = true;
      closeSync(fd);
    }
  };
  return logger;
}
