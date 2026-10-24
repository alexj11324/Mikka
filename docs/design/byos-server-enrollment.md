# Server-side subscription enrollment

The user authorizes Claude/ChatGPT on the provider's own page. Mikka's server
holds PKCE/state, exchanges the new grant, and stores it in the existing Mikka
Infisical project. Users do not install or sign into Infisical, grant a website
access to an Infisical localhost service, or export native CLI credentials.
The Mac may host the user's browser; it is not a credential-custody service.

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

Proposed staging paths: `/byos/enrollment-attempts`, `/byos/enrollment-claims`,
`/byos/pending-grants`. They are proposals, not configured resources. Custody
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

The proposed target is an independent preview of the existing Mikka project in
team `mikka-dev`. Root has candidate project metadata, but repository linkage
must be reverified after connector consent before selecting `mikka` rather than
`mikka-web`. No production alias, new project, paid sandbox or new IAM role is
part of this proposal. A unique reachable HTTPS URL, logging controls, actual
vault contract and callback relay acceptance are still pending deployment approval.

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
approval is pending; no real authorization link has been generated.
