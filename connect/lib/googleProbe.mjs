// DID THE GOOGLE GRANT ACTUALLY BUY A READ?
//
// A token file on disk is not the question, and answering it from the file is
// how onboarding used to pass a screen that had not worked. Consent can
// complete and the read still fail: the OAuth project can be over its
// restricted-scope user cap, gmail.readonly can be unticked on the consent
// screen while calendar stays on, or the grant can be revoked afterwards. In
// every one of those the token exists, /api/status reports `connected`, and
// the mail connector then reads nothing.
//
// So this does the smallest real read there is -- one messages.list with
// maxResults=1, per live account -- and reports what Google said.
//
// COUNTS AND HTTP STATUSES ONLY. No account address, no message id, no header,
// no snippet, nothing from the mailbox. The failure `reason` is lifted out of
// Google's own error body through a strict allowlist pattern rather than
// passed through, because the thrown message carries the account's email
// address; connect/test/googleProbe.test.mjs pins that.
//
// Its own module rather than a function in server.mjs: importing server.mjs
// binds a port, so anything living there is untestable by construction.
//
// EGRESS: already declared. ops/EGRESS.json's www.googleapis.com row names
// reading the owner's mailbox under gmail.readonly, and this reaches that host
// with the same installed client, the same scope, and strictly less data than
// connectors/sources/mail.mjs already fetches.
import {
  GMAIL_SCOPE, accountsWithScope, accountsWithScopeIncludingStale,
} from '../../connectors/lib/googleAccounts.mjs';
import { createGmailClient } from '../../connectors/lib/gmailClient.mjs';

// Google's own machine-readable reason, and nothing else from the body.
//
// The thrown message is `Gmail messages.list failed: HTTP 403 <body slice>`
// and that slice can contain the account's email address, so it must never be
// passed through. This pulls the one token worth showing a person —
// insufficientPermissions, rateLimitExceeded — and refuses anything that is
// not a bare identifier.
function gmailFailureReason(error) {
  const match = /"reason"\s*:\s*"([A-Za-z][A-Za-z0-9_]{0,48})"/u.exec(String(error?.message ?? ''));
  return match ? match[1] : null;
}

// One messages.list per live account, in parallel. See the file header for
// what this is for and what it must never return.
//
// The two seams are the ones connectors/sources/mail.mjs already takes for the
// same reason: a test of what this function REPORTS must not need a real
// Google grant, and the property under test -- that no address, message id or
// error message reaches the reply -- is exactly the one a mocked client can
// prove and a live one cannot.
export async function googleProbe({
  accountsForScope = accountsWithScope,
  accountsIncludingStale = accountsWithScopeIncludingStale,
  makeClient = createGmailClient,
} = {}) {
  const live = accountsForScope(GMAIL_SCOPE);
  const withStale = accountsIncludingStale(GMAIL_SCOPE);
  const out = {
    ok: true,
    // Accounts holding the gmail.readonly scope, and how many of those Google
    // has already refused a refresh for. accountsWithScope filters a stale
    // grant out, so reporting only its length would say "0 accounts" for a
    // mailbox the owner can see they signed into.
    accounts: live.length,
    stale: withStale.length - live.length,
    reading: 0,
    failures: [],
  };
  const results = await Promise.all(live.map(async (account) => {
    try {
      const client = makeClient({ email: account.email, tokensPath: account.tokensPath });
      await client.listMessages({ maxResults: 1 });
      return null;
    } catch (error) {
      // `status` is set by gmailClient's statusError; a transport failure has
      // none, and 0 says "the call did not reach Google" rather than pretending
      // to a status code Google never sent.
      return {
        status: Number.isInteger(error?.status) ? error.status : 0,
        reason: gmailFailureReason(error),
      };
    }
  }));
  for (const failure of results) {
    if (failure === null) out.reading += 1;
    else out.failures.push(failure);
  }
  return out;
}

