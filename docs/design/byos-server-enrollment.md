# Server-side subscription enrollment

The user authorizes Claude/ChatGPT on the provider's own page. Mikka's server
holds PKCE/state, exchanges the new grant, and stores it in the existing Mikka
Infisical project. Users do not install or sign into Infisical, grant a website
access to an Infisical localhost service, or export native CLI credentials.
The Mac may host the user's browser; it is not a credential-custody service.

The dedicated acceptance Preview retains test source copies pending a separately
approved cleanup scope; ordinary production lifecycle behavior is unchanged; see **Explicit source-retention policy** below. No real deletion
is implicitly authorized by a synthetic acceptance test.

## Current receiver

`POST /mikka/api/subscriptions/enrollments` is a disabled-by-default private
operator endpoint, not an anonymous signup or fabricated Mikka session. It
accepts only `start`, `complete` (enrollment ID and complete Claude callback
URL), and `status`. Its operator credential stays on the control plane; it must
not be embedded in frontend code, browser storage, model tools or logs. Rotate
or remove that credential/feature flag to disable the endpoint. Its hash binds
attempts to the issuing operator principal; rotation does not delete stored
grants, but a new operator key cannot automatically claim the old principal.

This receiver is independent of PostgreSQL, the inference reader, native CLI
isolation, E2B and the secure-form feature. It stores state/PKCE before releasing
the provider link, enforces a five-minute expiry, exact registered redirect,
single code/state values, principal identity and immutable one-use claim before
exchange. No token or verifier is returned to the browser. Callback bodies and
authorization URLs must not be included in request-body/URL capture logs.

The resulting envelope is `mikka.byos.unbound-grant.v1`, state
`pending_unbound`, always `taskUseAllowed:false`. It preserves actual CPA
`Auth.Storage` access/refresh credentials, expiry and account/organization
identity, rather than serializing `Auth` and losing Storage. It cannot be
decoded as the worker's execution bundle. No ordinary bot/task can use it.
After a real Mikka user/workspace is authenticated, an explicit owner-binding
transfer must republish it in the existing canonical format and establish the
existing single-refresh-authority record. This transfer is now implemented by
the private `/api/subscriptions/enrollments/bind` route. It requires both the
source operator credential and an actual Mikka session, derives the user ID
from `auth.api.getSession`, and uses the existing active workspace membership
check. Its body accepts only enrollment/workspace IDs, not owner/principal or
connection IDs. No fake user or session is substituted. Pending enrollment
does not independently rotate refresh tokens. After binding, the existing
bound lifecycle is the refresh authority without another provider login.

The additive `20261024223000_byos_enrollment_transfers.sql` migration stores
only ownership, source digest/subject and original operation/epoch metadata.
One transaction reserves the connection, acquire operation and transfer. A
separate immutable Claims entry fixes source principal/digest, target database
identity, owner/workspace, transfer/connection/operation IDs and epoch globally.
Thus another preview database cannot consume the same source by creating a
second local ledger. Database identity normalizes pooled/direct Neon hostname
forms and excludes passwords. No user can supply that identity through HTTP.

Initial publication reuses `Store.Save`. A failed publication resumes only the
original staged names/digest via `createArtifact` and `Store.Recover`. A pending
reservation may extend its own deadline; it never acquires a new epoch. Routine
refresh preserves bot bindings and increments credential version. An explicit
reconnect/disconnect advances epoch and permanently fences the old transfer.
Repeated successful bind requests return the same connection and do not replace
a refreshed grant with the escrow snapshot. No provider calls are made to bind.

The source escrow is a recovery copy until canonical publication succeeds.
Migration `20261024230000_byos_enrollment_cleanup.sql` journals its grant and
PKCE attempt paths before publication. The canonical publication transaction
records durable publication evidence, so disconnect between publication and the
HTTP bind response cannot strand the copy. Successful bind immediately attempts
bounded deletion of both source records. Repeated bind verifies the existing
owner/workspace/database ledger and global immutable claim before returning the
canonical connection; it does not reread a deleted escrow or overwrite refreshed
credentials with the old snapshot.

Explicit owner disconnect fences the connection epoch and clears usable
references before deletion. The shared cleanup RPC and authenticated daily cron
retry canonical and escrow/attempt deletion, including source-only leftovers.
An unpublished sole recovery copy stays protected unless the owner explicitly
disconnects/reconnects (advancing the epoch). Deletion requires fresh verification
of the exact global claim and database identity; a losing preview reservation
cannot delete another database's grant. Missing custody configuration or proof
leaves a visible pending state rather than claiming success. Cleanup/status and
disconnect do not require an inference reader identity.

Immutable token-free creation receipts identify acknowledged source writes.
A legacy missing receipt or any uncertain create remains repeat-delete eligible,
even after successful DELETE/404, because a late commit may still recreate the
record. Cleanup reports `creation_outcome_unknown` until that uncertainty is
resolved; it never reports every copy deleted. Missing source configuration,
ownership proof failures and remote deletion failures are reported distinctly.
The immutable code-use, binding and creation claims retain only replay/ownership
metadata; they are not provider credentials and are intentionally not removed.
No refresh/access tokens or PKCE verifier belong in these claims.

Provider revocation remains `not_implemented`. Local fencing/deletion does not
revoke an upstream grant or undo an already transmitted provider request. No
real account, source deletion or deployment has been validated by the synthetic
lifecycle tests. After binding, use authenticated subscription status for the
canonical connection; the DB-free custody status only describes whether an
unbound source copy is available and cannot attest canonical runtime state. Pending grants without a confirmed authenticated binding remain
persistent custody records and are not selected by the bound-connection cron.

The one-use latch requires the vault's exclusive POST-create contract for a
secret name/path; no CAS or mutable lock is invented. Verify duplicate-create
refusal with synthetic records before enabling real exchange. A failed or
uncertain claim never permits exchange. An uncertain grant create is read back
and compared; at most one retry writes the same captured payload/name if it is
still missing. A definitive refusal is not retried. Code exchange is never
repeated. A consumed claim with no confirmed grant reports `custody_unconfirmed`.
If every durable write fails or the process crashes between provider exchange
and vault commit, a fresh consent may be required. This distributed transaction
has no absolute zero-loss guarantee and no plaintext local retry file. Confirmed
real pending grants remain persistent until explicitly bound. After canonical
publication, only the canonical lifecycle retains the usable grant; redundant
source copies follow the cleanup rules above.
Synthetic acceptance cleanup must never delete real pending grants.

## Claude callback compatibility

Pinned CPA `8289ec4c71ad914d0612c2776352b76ba3d355a6` generates
`https://claude.ai/oauth/authorize` for public client
`9d1c250a-e61b-44d9-88ed-5944d1962f5e` with S256 and registered redirect
`http://localhost:54545/callback`. The requested scope is exactly
`user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload`.
The server exchanges at `https://platform.claude.com/v1/oauth/token`, using
ordinary HTTPS and Mikka's identity, without fingerprint/device generation or
native roles replay. Missing account identity uses the plain profile endpoint.

An arbitrary Mikka HTTPS callback is not registered by this patch. Official
[Claude headless sign-in guidance](https://code.claude.com/docs/en/whats-new/2026-w18)
supports a code handoff when the browser callback cannot reach localhost; it
does not establish Mikka redirect registration. A thin relay or controlled HTTPS
handoff must be reachable and tested before starting a real attempt. A relay
forwards only the complete authorization callback to this receiver, holds no
Infisical identity or provider token, and must not log its URL/code/state. The
receiver still validates the original registered redirect/state/PKCE. Do not
replace it with an invented public callback or let a relay choose upstream URLs.

## Private deployment configuration

| Field | Purpose |
| --- | --- |
| `MIKKA_BYOS_ENROLLMENT_ENABLED` | Explicit `1` only after live gates pass |
| `MIKKA_BYOS_ENROLLMENT_OPERATOR_TOKEN` | Independent random control-plane credential, at least 32 characters; never the Infisical admin token |
| `MIKKA_BYOS_ENROLLMENT_BINARY` | Packaged Linux `mikka-subscription-enrollment` executable |
| `MIKKA_BYOS_INFISICAL_ORIGIN` | Existing Infisical HTTPS origin |
| `MIKKA_BYOS_INFISICAL_PROJECT` | Existing Mikka project ID |
| `MIKKA_BYOS_INFISICAL_ENVIRONMENT` | Explicit nonproduction environment, currently proposed staging |
| `MIKKA_BYOS_INFISICAL_TOKEN` | Existing controlled server custody identity; delivery/renewal stays server-side |
| `MIKKA_BYOS_ENROLLMENT_ATTEMPT_PATH` | Dedicated temporary state/PKCE records |
| `MIKKA_BYOS_ENROLLMENT_CLAIM_PATH` | Distinct immutable one-use claims |
| `MIKKA_BYOS_ENROLLMENT_GRANT_PATH` | Distinct persistent real pending grants |

Binding additionally uses the existing request-scoped application database URL,
workspace database/auth session, `MIKKA_BYOS_INFISICAL_PATH` for canonical grants
and `MIKKA_BYOS_ACCESS_INFISICAL_PATH` for access-only projections. All five
vault paths must differ. Custody writes the projection using its existing
server identity; an inference reader token is not needed merely to bind. The
inference reader and route readiness/billing/quota checks remain required before
actual model/native use. The receiving and binding routes never deliver the
operator credential to the browser; ordinary end-user UI wiring must keep it on
the trusted backend. This patch changes no frontend.

Configured staging paths (baseline Preview acceptance, 2026-10-25):
`/byos/enrollment-attempts`, `/byos/enrollment-claims`, `/byos/pending-grants`.
The persistent operator key is in `/byos/enrollment-control`. Custody
needs create/read on all three and delete only for completed attempts. No new
IAM or execution-reader setup is a prerequisite to custody. Platform proxy/CA
settings are honored by the trusted Go process; unrelated environment secrets,
HOME and local CLI credential sources are not inherited.

Build the pinned CPA source with `node packages/subscription-worker/bootstrap.mjs`,
then `CGO_ENABLED=0 go build -mod=readonly -trimpath -o bin/mikka-subscription-enrollment ./cmd/mikka-subscription-enrollment`
inside `packages/subscription-worker` using pinned Go 1.26.10. The binary is an
ignored build artifact, not part of the source patch. Next output tracing includes
it for the enrollment route. An authorized deployment must build/package it;
uploading source alone does not prove the binary was delivered. Other required
files are the receiver command/library, existing CPA compatibility bridges and
license, the TypeScript private client/handler, route and `next.config.mjs` trace.

The authorized target is an independent Preview of the existing `mikka` project
in `mikka-dev`; live metadata verified its `alexj11324/Mikka` repository linkage.
Baseline `6fea698` was deployed READY at
`https://mikka-7qvbzek5t-mikka-dev.vercel.app`. It passed private receiver 401/200
checks with synthetic records and the actual Infisical create-only contract.
That baseline has no scoped handoff route; the later handoff candidate requires
its own frozen deployment. No production alias, new project, paid sandbox or
IAM change is included. Deployment-only server configuration avoids publishing
a Git branch or changing shared project variables. No real provider grant has
been created by these checks.

## Linux evidence

Go tests exercise actual plain CPA OAuth serialization, complete Storage
normalization, restart, expiry, principal isolation, concurrent/replayed callback,
unknown claims and failed/uncertain publication. Node tests exercise the actual
HTTP handler, production private Go executable and TLS Infisical fixture without
database or inference settings. No real provider account, grant or vault write
was used. These checks do not establish a published receiver or live acceptance.

After building the binary, `node scripts/test-subscription-enrollment-app.mjs`
also starts the original Next application in an isolated Linux Docker snapshot
and exercises the actual enrollment route against a local TLS vault fixture.
It has no database, execution-reader or provider account configuration. The
synthetic authorization link is never opened or passed to a user.

`MIKKA_BYOS_BACKEND_ONLY=1 node scripts/test-subscription-worker.mjs` also runs
binding tests with real disposable Postgres, all 34 migrations/replay,
the production custody process and TLS vault fixtures. Session inputs in that
synthetic integration are test dependencies, not proof of a real Mikka account.
Actual account creation/session, provider consent and deployed Infisical policy
still require the approved persistent preview acceptance.

## Authenticated browser binding handoff

The direct bind API requires both a real Mikka session and the private operator
credential. An ordinary browser instead receives a short-lived, target-scoped
binding proof minted only by the controlled operator. Its purpose-separated HMAC
binds the enrollment ID, exact authenticated Mikka user ID, workspace, receiving
HTTPS origin, canonical database identity and an expiry of at most five minutes.
The server derives the original custody principal from its own configuration;
the browser never supplies a principal or obtains the global operator key.

The thin GET transport on the existing bind route immediately scrubs its fragment
and submits to that same origin using the real session. It stores no proof or
credentials. It handles a new fragment on an already-open page. The POST still
checks the actual session user and active workspace authorization before calling
the existing worker. Mikka owner email and provider subscription email may differ.

This proof permits safe retries to the same target within its TTL; it is not a
strict single-consumption token. The worker's immutable cross-database ownership
claim and epoch checks remain authoritative, including after reconnect or
disconnect. Signing a proof neither creates a session nor changes connection
state. No public proof-signing endpoint is provided.

Linux checks cover exact target matching, modified or expired proof, foreign
origin/database/owner, workspace refusal, missing actual session, and clean-page
then fragment navigation. The custody-only unauthenticated refusal still works
without a database. Synthetic sessions in tests do not establish real binding.

## Escrow cleanup Linux verification (2026-10-24)

Source-only checks use synthetic credentials, loopback TLS fixtures and disposable
Postgres 17. No Infisical account, real token, provider request, IAM change or
external deployment was used.

- `MIKKA_BYOS_BACKEND_ONLY=1 node scripts/test-subscription-worker.mjs` passed:
  50 top-level Go tests, race detector, vet, production/fixture executable builds,
  authenticated app/stream/native fixture and production custody bind/cleanup
  fixture; 34 migrations and migration-ledger replay. Source fixtures cover
  deletion failure and retry, missing/foreign claim or database identity,
  publication-before-bind disconnect, protected recovery, late uncertain creates,
  post-purge idempotence, normal refresh and old-epoch refusal. Backend-only mode
  intentionally skips browser CLI execution in the older composite fixture.
- The added legacy source migration test passed separately on a fresh disposable
  Postgres: two recorded copies per old transfer, publication-proof backfill,
  unknown creation state, retained history and direct SQL replay.
- 12 enrollment/binding/model/production-custody Node tests and four daemon
  private-process tests passed. Execution frames strip every source path;
  custody retains them. Root and daemon type checks, lint, migration policy and
  11 migration tests passed.
- Actual Next startup/private route to the production custody executable and
  loopback TLS fixture passed without SQL, inference reader, native runtime or
  external OAuth. Full original-config webpack production build passed in an
  isolated Linux Docker snapshot; all seven BYOS route traces include their
  intended production worker binary. The build emitted known next-intl cache
  parsing and missing live Better Auth configuration diagnostics. This is a
  build check, not a live login/deployed result.
- An independent read-only review found missing-config cleanup starvation and
  partial source configuration blocking canonical disconnect. Both were fixed
  and covered by the repeated Go/application acceptance. No security check was
  weakened to make a test pass.

A projection POST returning 503 is deliberately kept in the canonical unknown-
creation queue after disconnect, even when DELETE removes its active value.
The application test checks this pending count instead of falsely asserting all
copies are gone. Real OAuth, provider compatibility/revocation and deployment
acceptance remain separate, unrun gates. Current Preview/team configuration
was subsequently obtained for an independent Preview; no real authorization
link was generated by those source checks.

## Scoped Claude browser handoff

The private operator start response now includes an independent random
`handoffKey`. Its SHA256 digest is bound to the original principal, enrollment
ID, Claude provider, state, server PKCE verifier and expiry. Only the scoped key
is delivered to the browser/loopback transport. Global operator and Infisical
credentials remain on Mikka's server. This is still pending-unbound custody,
not an authenticated Mikka user/task authorization.

`POST /mikka/api/subscriptions/enrollments/handoff` accepts exactly enrollment
ID, `provider:claude`, the scoped key and the complete registered callback URL.
The Go worker loads the original principal from the protected attempt; the
browser cannot supply or replace it. It checks the full capability binding,
five-minute expiry, exact callback origin/path, single matching state and the
original verifier. Scoped and legacy operator completion share the same durable
one-use claim before exchange, including concurrent calls and uncertain writes.
Old v1 attempts without a capability retain operator completion support and
cannot use the public handoff route. No upstream URL/model/vault/bind selection
is exposed by this route.

The route's GET response is a minimal transport document, not a product frontend
redesign. Launch fields (`id`, `provider`, `handoffKey`, `authorizationUrl`) go
only in the browser fragment. The page removes the fragment before navigation,
checks the fixed official Claude client/redirect/scopes, retains only the scoped
completion context in sessionStorage, then opens the official provider page.
After the registered loopback callback, the relay redirects to the same Mikka
page with the callback in a fragment. The page clears its saved context and
POSTs on its own origin. Same-document hash navigation is handled explicitly.
It displays only fixed outcomes, with no-store/no-referrer and a nonce CSP.
There are no external scripts, callback values in server URLs, or token logging.

`scripts/byos-claude-loopback-relay.mjs` is optional browser transport only. Start
it with the exact new Preview's HTTPS handoff URL and the original state in
`MIKKA_BYOS_RELAY_STATE` (process memory only, never chat/logs). Preflight the
port with synthetic state before creating the real attempt. It binds localhost:54545, validates Host, expected state and callback shape, forwards
only to the fixed Mikka Preview path, and releases its port after the matching callback or at most ten minutes.
It reads no CLI auth file/Keychain, provider access/refresh token, operator key or
Infisical identity. A conflicting listener is reported; it is never killed or
reused. Preflight deployment protection/browser access before starting the
five-minute OAuth attempt. Private launch data must go directly to the intended
browser, never ordinary chat or logs. The Mac/browser owner remains the parent
thread's existing task; no second provider flow is started here.

### Explicit source-retention policy

Only the dedicated acceptance Preview sets
`MIKKA_BYOS_ACCEPTANCE_RETAIN_SOURCES=1`. It is honored only when
`VERCEL_ENV=preview`; production ignores it. The shared configuration helper
sets `retainSources` / `retainEnrollmentSources` for that acceptance mode. Successful completion does
not delete its temporary attempt, and bind/cleanup/disconnect cannot delete
escrow/attempt copies through the shared cleanup boundary in this mode. Pending
source cleanup reports `deletion_not_authorized` and rotates fairly rather than
claiming physical deletion. Logical disconnect still fences use immediately.
Normal deployments default to the existing owner-requested disconnect/delete
lifecycle and durable retries; product users are not asked for extra operator
approval. This acceptance-only hold is not a production deletion policy. Exact
external test cleanup requires a separately approved record scope. Local in-memory/isolated fixtures
exercise both retained and specifically authorized cleanup behavior.

This retention hold follows the owner's clarified deletion rule; it does not
remove the previously tested cleanup implementation or claim provider revoke.
Retained attempts remain expired/consumed for authorization purposes. Real grants
are persistent and are never synthetic-test cleanup targets.

Scoped handoff Linux checks passed: 55 top-level Go race tests plus vet and
production builds; all 34 disposable Postgres migrations/replay and three app
fixtures; 15 Node enrollment/binding/model/production-receiver tests; three
handoff HTTP tests and one browser transport test; root/daemon type checks,
lint; actual Next operator/handoff routes with the production binary and a TLS
vault fixture; original-config webpack build with eight worker asset traces.
The browser test uses intercepted synthetic HTTPS destinations and separately
checks the real loopback 303 before applying its Location in the browser, because
Playwright interception does not repeat across a redirect chain. This does not
claim real provider/browser acceptance. The private Pages evidence must capture
only the final scrubbed Mikka outcome and non-secret run metadata, never login,
password/MFA, authorization code, callback, capability or token content.
