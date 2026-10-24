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
existing single-refresh-authority record. That binding transfer is not yet
implemented here; no fake owner or session is substituted. Pending enrollment
does not independently rotate refresh tokens. The existing bound lifecycle
remains the refresh authority after integration, without another provider login.

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
real grants remain persistent; only completed temporary PKCE attempts are deleted.
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
