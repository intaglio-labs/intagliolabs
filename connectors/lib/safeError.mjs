// Convert an arbitrary thrown value into a log-safe operational fingerprint.
//
// Provider errors are untrusted data. Their message can quote an email subject,
// a remote response body, an account address, or a local path. Persisting that
// string in connectors.log or state.db would create a second, unmanaged copy of
// private data. Keep only bounded machine-shaped facts that help distinguish
// network, authorization and filesystem failures.

function safeAtom(value, fallback) {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(value)) {
    return fallback;
  }
  return value;
}

export function safeErrorFingerprint(error) {
  const name = safeAtom(error?.name, 'Error');
  const facts = [name];
  const status = Number(error?.status ?? error?.statusCode);
  if (Number.isInteger(status) && status >= 100 && status <= 599) {
    facts.push(`status=${status}`);
  }
  const code = safeAtom(error?.code, null);
  if (code) facts.push(`code=${code}`);
  return facts.join(' ');
}
