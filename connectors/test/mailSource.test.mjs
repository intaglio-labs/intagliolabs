import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createMailSource,
  mailSecretName,
  planFolderScan,
  resolveAccounts,
} from '../sources/mail.mjs';

// THE SILENT-STALL TEST. If UIDVALIDITY changes and the cursor is kept, every
// renumbered UID is below it, the search returns nothing, and the connector
// stops fetching forever without erroring. Nothing else in this file matters
// as much.
test('a UIDVALIDITY change discards the cursor instead of advancing past it', () => {
  const plan = planFolderScan({
    storedValidity: '111',
    serverValidity: '222',
    storedUid: '5000',
    backfill: false,
  });
  assert.equal(plan.fromUid, 1, 'must re-scan, not resume above renumbered UIDs');
  assert.equal(plan.resetReason, 'uidvalidity-changed');
});

test('an unchanged UIDVALIDITY resumes just past the cursor', () => {
  const plan = planFolderScan({
    storedValidity: '111',
    serverValidity: '111',
    storedUid: '42',
    backfill: false,
  });
  assert.equal(plan.fromUid, 43);
  assert.equal(plan.resetReason, null);
});

test('a first run and an explicit backfill both start at 1', () => {
  assert.equal(planFolderScan({ storedValidity: null, serverValidity: '1', storedUid: undefined, backfill: false }).fromUid, 1);
  assert.equal(planFolderScan({ storedValidity: '1', serverValidity: '1', storedUid: '900', backfill: true }).fromUid, 1);
});

test('a corrupt cursor re-scans rather than resuming from garbage', () => {
  for (const bad of ['', 'abc', '0', '-3', null]) {
    assert.equal(
      planFolderScan({ storedValidity: '1', serverValidity: '1', storedUid: bad, backfill: false }).fromUid,
      1,
      `expected a reset for stored cursor ${JSON.stringify(bad)}`
    );
  }
});

// Gmail issues app passwords per account; two mailboxes must never collide on
// one secret file.
test('each mailbox resolves to its own secret filename', () => {
  assert.equal(mailSecretName('ay@austinyoshino.com'), 'gmail-app-password-ay-austinyoshino-com.txt');
  assert.notEqual(mailSecretName('a@b.co'), mailSecretName('c@d.co'));
  for (const evil of ['../../etc/passwd', 'a/../b']) {
    assert.ok(!mailSecretName(evil).includes('/'));
    assert.ok(!mailSecretName(evil).includes('..'));
  }
});

test('accounts inherit mail defaults and override them per account', () => {
  const accounts = resolveAccounts({
    mail: {
      folders: ['INBOX', 'Sent'],
      backfillDays: 90,
      accounts: [{ user: 'a@b.co' }, { user: 'c@d.co', folders: ['INBOX'] }],
    },
  });
  assert.deepEqual(accounts[0].folders, ['INBOX', 'Sent'], 'inherits');
  assert.deepEqual(accounts[1].folders, ['INBOX'], 'overrides');
  assert.equal(accounts[0].backfillDays, 90);
  assert.equal(accounts[0].host, 'imap.gmail.com', 'default host');
});

test('the single-account spelling still resolves', () => {
  const accounts = resolveAccounts({ mail: { user: 'solo@x.com' } });
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].user, 'solo@x.com');
});

test('no mail config resolves to no accounts, not a crash', () => {
  assert.deepEqual(resolveAccounts({}), []);
  assert.deepEqual(resolveAccounts(undefined), []);
  assert.deepEqual(resolveAccounts({ mail: { accounts: [] } }), []);
});

// An unprovisioned source should wait at the gate, not fail mid-run with a
// socket already open.
test('needs() names the missing app password per mailbox', () => {
  const source = createMailSource();
  const missing = source.needs({
    config: { mail: { accounts: [{ user: 'nobody@nowhere.invalid' }] } },
  });
  assert.equal(missing.length, 1);
  assert.ok(missing[0].includes('nobody@nowhere.invalid'));
});

test('needs() says so when no mailbox is configured at all', () => {
  const missing = createMailSource().needs({ config: {} });
  assert.equal(missing.length, 1);
  assert.ok(missing[0].includes('mail.accounts'));
});

// One provisioned mailbox is enough to run. Gating on the least-ready account
// would mean adding a second mailbox silently switches the connector off —
// which is exactly what happened the first time a real app password landed.
test('needs() blocks only when NO mailbox is provisioned', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'mail-needs-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, '.hazlie', 'secrets'), { recursive: true, mode: 0o700 });
  const config = { mail: { accounts: [{ user: 'has@pw.com' }, { user: 'no@pw.com' }] } };
  const source = createMailSource();

  assert.equal(source.needs({ config, home }).length, 2, 'neither provisioned → blocked, both named');

  writeFileSync(join(home, '.hazlie', 'secrets', mailSecretName('has@pw.com')), 'x\n', { mode: 0o600 });
  assert.deepEqual(source.needs({ config, home }), [], 'one provisioned → the run may start');
});
