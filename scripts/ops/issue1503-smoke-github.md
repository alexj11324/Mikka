# Issue 1503: temporary smoke GitHub connection

This one-off operator module implements Alex's explicit authorization to prepare
the existing smoke alias for the Factory acceptance. It does not claim that an
interactive OAuth flow was tested. It adds no product endpoint, session bypass,
cross-user runtime fallback, profile, subscription share, E2B key or workspace.
Importing the module alone performs no I/O.

## Runner use

Use the deployed source revision with Node 24 and dependencies installed. Load
server-only source modules with the repository's existing server loader:

```sh
node --import ./tests/support/server-only.mjs --import tsx ./scripts/ops/your-issue1503-driver.mjs
```

The existing production database, Better Auth encryption and GitHub App settings
must be available to that runner through the existing credential controller.
Never print environment variables or put their values in command arguments.

```js
import { writeFile } from 'node:fs/promises'
import { setupIssue1503SmokeGitHub } from './issue1503-smoke-github.mjs'

const fixture = await setupIssue1503SmokeGitHub({ ownerUserId: verifiedOwnerUserId })
await writeFile(statePath, JSON.stringify(fixture.state, null, 2), { mode: 0o600 })
try {
  // Sign in to the existing smoke account normally, then use the real product
  // APIs for dispatch, Factory review/revision, and merge. No bypasses here.
} finally {
  // First finish/stop all fixture runs and remove their temporary resources.
  // Existing daemon token caches are independent of the connection DB row.
  const cleanup = await fixture.cleanup()
  // Only this safe metadata, never the fixture's in-memory credentials, is logged.
  console.log(JSON.stringify({ githubCleanup: cleanup }))
}
```

State contains IDs, timestamps and a SHA-256 fingerprint of the newly minted
random token. It contains neither a token nor an encrypted credential. Recovery
in a later runner can call `cleanupIssue1503SmokeGitHub(state)`: it decrypts only
the exact smoke row whose identity, timestamps and digest still match. It never
reads Owner's token during recovery. A changed connection is preserved. An absent
row cannot prove provider revocation; recovery reports that explicitly. Keep the
in-process cleanup closure until both revocation and disconnect succeed.

## Exact scope and checks

- Only smoke user `cL1NXe1mr7WuIS8xWhU37v0p7kNoUMY3` is allowed, initially with no
  GitHub connection and no legacy GitHub login account.
- Owner user ID is fixed to `XjTsvV1ASqtV8wWat9aco0Z0KLodd9jJ`.
  `githubTokenForUser(ownerUserId, { minValidityMs: 14_400_000 })` obtains the
  existing real user's token. Its live `/user` must be user `183887963`, login
  `alexj11324`. Requesting four hours of validity can refresh the Owner token;
  GitHub invalidates the previous access token on refresh, so existing Owner
  runs retaining that old token can be affected.
- `POST /applications/{client_id}/token` checks that the source token belongs
  to the configured client. The official authorization schema guarantees
  `app.client_id`, not `app.id`. If `GITHUB_APP_ID` and response `app.id` are
  absent, the module discovers the numeric ID from `/user/installations` by
  exact `installation.client_id` matching and requires a unique positive
  `app_id`. It reuses the same Owner token and exposes only the public app ID.
  Optional authorization `user` metadata, when present, must match; live
  `/user` is mandatory for both Owner and newly minted tokens regardless.
- GitHub's `POST /applications/{client_id}/token/scoped` uses Basic auth with
  the existing App's client ID/secret. Its JSON body is:

```json
{
  "access_token": "<existing real user token, memory only>",
  "target": "alexj11324",
  "repositories": ["Mikka-handoff"],
  "permissions": {
    "metadata": "read",
    "contents": "write",
    "pull_requests": "write",
    "checks": "read",
    "statuses": "read",
    "actions": "read"
  }
}
```

The source must be a non-scoped user token. The endpoint does not accept an
arbitrary TTL. The module requires a distinct new token, the expected App and
person, exact requested permissions, selected repositories, and a finite
provider `expires_at` with at least two hours remaining. The local connection is
limited to four hours, with a margin below provider expiry, and has no refresh
token. A local expiry cap does not shorten the provider token's own expiry.

Before saving, the new token must pass live `/user`, repository push-access and
the same installation/repository listing endpoints used by Mikka. The target
installation and repository IDs must match the Owner's live listing. GitHub's
installation directory describes the authenticated user's explicit repository
access; it does not promise a scoped-token allowlist. The first production
attempt confirmed that the directory also returns additional installed-repository
metadata even after a successful selected-repository mint. Therefore extra
directory entries are counted in the safe receipt, without logging their names,
and are not interpreted as proof that the token has additional write access.
The exact `target`/`repositories` mint request and selected/permission-scoped
authorization response remain mandatory evidence of the token's requested scope.

The module also calls Check-token for the newly minted token. App and identity
must agree; any returned installation scope must still be selected with exactly
the permitted access. GitHub's authorization schema permits this installation
metadata to be omitted: the receipt distinguishes that case with
`checkTokenScopeConfirmed: false`, while retaining the verified mint evidence.
Unsupported installation listing, missing target, extra permissions, wrong
authorization scope, or any identity mismatch still fails and revokes the new
token. There is no broad-token fallback and no change to product authorization.

Saving calls the existing `saveGitHubConnection` under a serializable transaction
that rechecks the absence of a connection, then validates the sealed row and its
expiry before commit. Cleanup calls the existing `disconnectGitHub` under a row
lock after checking the exact fixture credential. Provider revocation uses only
`DELETE /applications/{client_id}/token` with the newly created token; it never
uses `/grant`, never revokes the source token, and never duplicates a refresh
token. Setup/cleanup errors contain closed codes and numeric HTTP statuses,
never raw provider or SQL exception text.

## Verification and limits

Run `node --test scripts/ops/issue1503-smoke-github.test.mjs`. These are injected
unit tests, with no production network or database access. They validate target
pinning, provider identity, expiry, exact scope, installation compatibility,
secret-free state/error paths, rollback and cleanup. A real production runner
must still prove that GitHub supports this scoped token for the App and that
Factory completes with this identity; unit tests do not establish that claim.

If a runner is killed after mint but before state is saved, the provider token
may survive until its actual expiry. The normal in-process `try/finally` must be
kept around the complete acceptance. A local connection delete alone does not
revoke a token already cached by a daemon.

Official references:

- [Create a scoped access token](https://docs.github.com/en/rest/apps/apps#create-a-scoped-access-token)
- [Delete an app token](https://docs.github.com/en/rest/apps/oauth-applications#delete-an-app-token)
- [Check a token](https://docs.github.com/en/rest/apps/oauth-applications#check-a-token)
- [List repositories accessible to the user access token](https://docs.github.com/en/rest/apps/installations#list-repositories-accessible-to-the-user-access-token)
- [Official REST OpenAPI schema](https://github.com/github/rest-api-description/blob/main/descriptions/api.github.com/api.github.com.json)
- [Refreshing user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)
