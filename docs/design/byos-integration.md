# BYOS: source integration and live-validation handoff

Current implementation record, 2026-10-24. This supersedes phase-two statements
that OAuth, streaming, UI entry and private launcher wiring are absent. The
feature remains off by default; no real account or E2B resource was used.

## User-driven connection

Settings → Integrations → Connect subscription starts a NEW authorization.
Codex now follows pinned CPA's device flow: Mikka shows the official device page
and user code, keeps device_auth_id private, enforces the returned poll interval,
and exchanges the resulting code with the provider-owned device callback URI.
Its opaque application attempt handle is owner/session-bound; device authorization
uses the provider-returned PKCE verifier/challenge, not a fabricated web redirect.

Claude preserves CPA's registered http://localhost:54545/callback URI and S256
PKCE. The user signs in in a separate tab, then pastes the complete final callback
URL into the authenticated Mikka form. A refused localhost connection is expected
without a local listener; the address bar still provides the handoff. Mikka never
fetches this URL. It requires the exact origin/path, one code and one matching
state, original owner/session, five-minute TTL, and atomic one-time consumption.
Raw codes, fragments, duplicate query keys, arbitrary callbacks and URL redirects
are refused. This is an explicit manual ceremony, not seamless HTTPS callback
support. Codex attempts expire after 15 minutes.

Neither provider password nor access/refresh token reaches the browser. OAuth
code/state and the user-facing device code are temporary ceremony data. They must
stay out of logs, screenshots and assistant chat; production request-body logging
and provider-page handling still require deployment acceptance. The old GET
callback now returns 410; native clients cannot configure a Mikka HTTPS redirect.

Existing local Claude/Codex credentials are not an acquisition source. The new
feature has no file, Keychain, cookie or native-login import endpoint. Existing
local-daemon native login/quota readers remain separate and can still read their
local auth state; that does not mean the whole repository has removed local auth.

The complete provider bundle and temporary PKCE verifier stay in Infisical.
Neon stores ownership, status, authorization epoch, secret reference/digest,
attempt/session hashes, consumer bindings and quota observations. There is no
new general-purpose vault or custom cryptography. Platform secrets such as
E2B_API_KEY stay on the control plane and never enter an agent environment.

## Implemented request paths

| Path | Current source and evidence | Real-world status |
| --- | --- | --- |
| Connect/callback/reconnect | Authenticated HTTP handlers, workspace authorization, durable attempts, CPA-compatible acquisition/store, Infisical publication | Production device/code-return adapters tested with synthetic grants. Actual provider acceptance/eligibility remains unverified |
| Own Mikka harness | Agent route → persisted binding → membership/capability/quota checks → AI SDK stream → private Go RPC → CPA converters and plain Mikka HTTP adapter | Text, tool calls/results, errors, cancellation and revocation tested through native provider SSE fixtures. Actual provider acceptance/eligibility unverified |
| Hosted Codex | Service native dispatch → trusted runner factory → private access lease → existing CodexAdapter host-managed auth/refresh | Fake app-server and actual SDK Store exercised. Pinned official app-server/audience/billing compatibility unverified |
| Hosted Claude Code | Same dispatch/broker → access-only OAuth lease → existing SDK adapter with isolated runtime home, account-mode check and expiry stop | Fake CLI exercised. Actual token scope/native compatibility unverified; transparent continuation at expiry is deferred |

The binding, model and workspace come from owner-scoped server records. A
selected chat binding is remembered for later turns; disconnect/reconnect never
silently selects the default paid model. Routine credential refresh preserves
the authorization epoch. Account reconnect/replacement invalidates old bindings;
they require explicit rebinding. Two consumers can reuse one provider connection.

The public API accepts only connection/binding references and safe ceremony
inputs. It exposes no native lease, secret reference, token import or arbitrary
upstream URL. The private worker is permanently owner-bound. Its nativeAuth RPC
is for the trusted launcher, not model tools or browser clients. Cancellation
closes provider transport; active streams and native sessions observe revocation.
There is no account pool, limit-evasion logic or fallback credential.

## Why the plain CPA adapters differ

Pinned CPA is 8289ec4c71ad914d0612c2776352b76ba3d355a6, MIT.
The upstream Claude constructor selects a Firefox fingerprint transport in
internal/auth/claude/anthropic_auth.go. Its exchange generates a device pool and
replays native companion calls. Its model executor invokes applyCloakingInternal
and forces CLI identity for OAuth in claude_fingerprint_policy.go. The Codex
executor supplies native Codex identity headers in codex_executor_request.go.
Those built-in model executors are not registered.

Mikka instead supplies bounded ordinary HTTP clients, fixed upstream targets,
Mikka identity headers and no redirects. Codex acquisition/refresh uses the
actual CPA service. A small original Claude exchange uses CPA's response/storage
types without fingerprint construction, device generation or roles replay;
refresh reuses CPA through the ordinary client. Plain profile lookup is allowed
when needed to verify account identity.

Inference reuses CPA's actual request and stream converters through its
ProviderExecutor interface. Claude conversion gets an explicit Mikka application
marker before the converter's derived-ID path, then all identity metadata is
removed before transport. Tests assert the final wire has no native identity
metadata and identifies Mikka. No cloaking algorithm or Comma AGPL source is
copied. Narrow original bridge files are added beside the pinned source; tracked
upstream files and their license are preserved.

The fixed Codex backend-api inference target remains an unverified provider route,
not an officially supported public independent-harness API. SIWC is a distinct
optional capability, not a reinterpretation of arbitrary Codex tokens. Honest
Mikka requests may be refused; the adapter returns an error rather than imitating
an official client, changing accounts or using API credits.

Quota probes use platform access leases and existing decoding functions, not
local credential readers. Missing or enabled provider credit/extra-usage fallback
evidence remains unknown and refuses use. Native OAuth mode alone is not proof
that provider-side spending controls are disabled. These controls require live
compatibility validation before marking a route ready.

## Feature and infrastructure configuration

No settings below were written or enabled. Source configuration is deliberately
separate from user consent and provider compatibility evidence:

- MIKKA_BYOS_ENABLED enables the feature only after control-plane configuration.
- MIKKA_BYOS_WORKER_BINARY selects a trusted Linux artifact; workload configuration
  goes over private stdin, never process arguments or native CLI environments.
  The acceptance script builds a static Linux production executable. Next tracing
  includes that artifact for the subscription and agent routes; build/copy it
  before activating the feature on an authorized deployment.
- MIKKA_BYOS_INFISICAL_ORIGIN / PROJECT / ENVIRONMENT / PATH / TOKEN select a
  dedicated managed workload scope. They are not per-user shared environment
  variables. The worker fetches each owner's bundle by its opaque reference.
- MIKKA_BYOS_CODEX_OAUTH / MIKKA_BYOS_CLAUDE_OAUTH control the acquisition
  routes. Redirects are fixed to CPA protocol values, never runtime configuration.
- MIKKA_BYOS_VALIDATED_MODEL_ROUTES and MIKKA_BYOS_VALIDATED_NATIVE_ROUTES are
  trusted operator capability settings, not browser assertions or proof by
  themselves. They default empty. The web process always has native isolation
  set to none; flags cannot make Vercel a verified owner runtime.

The app captures the selected request database query and URL together so a
preview worker and later stream callbacks keep the same database boundary.

E2B is the intended hosted compute backend. The native runner accepts a narrow
private broker interface so Infisical workload credentials can stay outside
untrusted compute. This phase tests local fake processes with a test-only
runtime attestation; it does not prove E2B isolation. The topology decision
(verified owner boundary versus shared project storage) remains open. No separate
per-owner sandbox topology was silently selected, and the missing #161 machine/
viewer implementation was not replaced with a new desktop UI.

## Exact next live-validation boundary

1. Review the source protocol evidence and manual UX in
   [BYOS OAuth transport review](byos-oauth-transport.md). Codex now uses CPA's
   device-code flow and its provider-owned redirect; Claude preserves CPA's
   registered loopback redirect with an explicit URL handoff. No arbitrary Mikka
   HTTPS registration is assumed. Source mocks prove parsing/state/lifecycle, not
   actual provider acceptance of Mikka's honest HTTP identity or hosted custody.
   Any live failure must stop that route; local CLI credentials are no substitute.
2. Transfer the reviewed commit/patch to an authorized staging deployment and
   build the pinned Linux worker there. Preserve the corrected owner-isolation
   handoff when reconciling documentation PR #173. No push/deploy is authorized
   or performed by this delivery.
3. Obtain explicit approval for one user-initiated provider authorization and
   storage of its access/refresh/identity/expiry bundle in a named dedicated
   Infisical workload path, plus the corresponding metadata in an isolated Neon
   branch. Include temporary PKCE records, workload permissions, retention and
   disconnect/provider-revocation handling. No real token goes through chat,
   screenshots, local auth files, the user's CLI cache or shared environment syncs.
4. The user's browser may then follow Mikka Connect to the official provider
   page and complete the device check or in-application callback URL handoff. This is a new consent flow. Verify account owner, callback replay refusal,
   persistence and task reuse before any inference. Provider calls require their
   own subscription-only, zero-API-credit test scope.
5. Real hosted native inference additionally requires a pinned CLI compatibility
   check and an authorized verified E2B owner boundary. The existing lifecycle-only
   E2B proposal is one 2-vCPU/4-GiB sandbox, at most 600 aggregate running seconds,
   estimated compute $0.0276 and proposed $0.05 cap. No E2B operation was run.

Historical secret/attempt GC, provider-side revocation, workload-token delivery
and renewal, real E2B transport/isolation, and Claude transparent continuation
after expiry remain release work. Logical disconnect immediately fences Mikka
use but cannot undo an already transmitted provider request.

## Cloud Linux evidence

- Worker: 19 top-level tests plus 6 provider subtests; race detector, vet, build,
  actual CPA Codex device exchange and plain Claude exchange/refresh against TLS
  fixtures. Disposable Postgres applied all 30 migrations and replayed successfully.
- Application acceptance: actual handlers → new consent attempt → owner/session
  device poll / exact callback-URL handoff → Infisical fixture → binding → AI SDK → actual CPA converters/plain
  provider SSE fixtures. Repeated tasks, tools, no retry/fallback, stream cancel,
  active revocation, both native fake CLIs, reconnect and stale binding are covered.
- Chromium: actual Settings component, synthetic Mikka session and provider
  device page and registered callback-URL handoff; connected state and disconnect
  passed with no page errors. This is
  component/handler acceptance, not deployed authenticated Mikka acceptance.
- Daemon: 209 passed, 7 real-agent tests skipped. Protocol: 223 passed. Model tests:
  8 passed. Root/daemon types, lint/migration policy, UI policy and i18n passed.
- Fresh Next production webpack build passed in isolated Docker Linux with 10 GiB
  memory, no platform/provider keys and no environment files copied.
- Root check still stops at the two unchanged baseline UI assertions. The separate
  partition-cookie assertion also fails on the unchanged base; neither was fixed
  as part of BYOS. Later root-check stages are not implied to pass.

Historical phase-three logs: /tmp/mikka-byos-phase3-acceptance-final.log, -daemon.log, -protocol.log,
-model.log, -types.log, -daemon-types.log, -lint.log, -build.log. Browser screenshot:
/tmp/mikka-byos-phase3-browser.png. All disposable test containers were removed.
No live grant, credential import, Infisical configuration/write, paid provider
request, E2B sandbox, push, PR or deployment was performed.

Current protocol review checks/logs are recorded in byos-oauth-transport.md; older
phase-three evidence does not validate the new device transport by itself.
