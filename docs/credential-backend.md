# Credential broker: backend and Claude wiring contract

Baseline: `alexj11324/Mikka`, main `5a0e1c411f487fee433c48414f7130d0d58dad92`.
No UI, Figma, OAuth grants or real account operations are included.

## Implemented boundary

This is platform-managed custody. The platform and Infisical can decrypt credentials;
this is not a zero-knowledge product. A credential never travels in chat, a run prompt,
run event, daemon command, MCP argument or model response. The independent HTTP
submission passes plaintext directly into `CredentialVault.put`; only that adapter
and trusted header/owned-browser executors may handle plaintext. JavaScript strings cannot
promise deterministic memory erasure. TLS, process isolation and privileged platform
operators are part of the trust boundary.

Application Postgres contains request state, hashes and random references. Infisical
names are random, with no owner, task, hostname, username or secret in their names.
No secret values, hashes of secret values, provider responses or arbitrary error text
are persisted. Tombstones deliberately survive run deletion so orphan cleanup remains
possible. Provider backups/version retention are governed by Infisical; logical delete
is not a claim of physical erasure from backups.

Every submit/use checks the original Better Auth session in Postgres, owner, active
workspace membership, exact task-to-workspace link, task owner, run owner, device owner,
device enabled and recent heartbeat, unexpired run lease, running/waiting-input status,
absence of stop request and exact execution session. Personal tasks without a workspace
link are rejected. A second login session does not inherit the first session's requests.
The two existing databases remain separate; no new cross-database foreign keys or changes
to the worker/daemon token interfaces are required.

Reference-only tools are registered in the existing Agent, Coordinator and MCP paths
(see the system-registration section). The signed-in owner still submits through the
separate secure HTTP form. No generic `getSecret` tool or plaintext getter route exists.

## HTTP contract

All paths below are relative to the app base path (`withBasePath`, currently `/mikka`).
Inputs and response types are in `lib/credentials/contracts.ts`. Existing Better Auth
cookies authenticate these routes; OAuth/MCP bearer tokens are not accepted instead.

All mutations require **exact deployment Origin**, `X-Mikka-Credential: 1`,
`Content-Type: application/json`, and session cookies. `Sec-Fetch-Site: cross-site`
is rejected. No wildcard CORS is enabled. JSON is capped at 12,288 bytes, with a maximum
8,192-character single header secret; CR/LF/NUL and unknown properties are rejected.
GETs also reject an explicitly foreign Origin. Responses use `private, no-store`.
Never put a secret/nonce in URLs, analytics, browser persistence or a chat message.

`POST /api/credential-requests`

```json
{
  "workspaceId": "<uuid>",
  "runId": "<uuid>",
  "serviceId": "<deployment-registered-service>",
  "mode": "api_header"
}
```

Task, owner, execution session and target origin are resolved on the server. The client
cannot supply them. The request has a five-minute submission deadline and one nonce.
`201` returns the view below plus `nonce` (43-character base64url, returned only once).
The nonce is only a submission/CSRF binding, not authorization. The DB stores its hash.
One active request per owner/workspace/run/execution session/service is enforced in SQL.
Duplicate creation returns `409 credential_request_exists`; cancel the prior request
before creating a replacement. GET does not recover a lost nonce.

`POST /api/credential-requests/:id/submit`

```json
{ "nonce": "<nonce from creation>", "secret": "<user-entered value>", "save": false }
```

`save` defaults to false: a ready reference lasts at most ten minutes and is consumed
by one admitted API use. Explicit `save:true` permits reuse **within the same original
login/run/execution session** for at most 24 hours. It does not create a global account
store or authorize reuse in another task. The initial schema supports a single header
credential or single password field for an allowlisted static form, not arbitrary
username/password bundles. `browser_login` requires an explicitly provisioned owned
executor session; the default production runtime has none and returns 501 before asking
for a password. A successful submission returns `200` with state `ready`.

Concurrent submission returns `409 credential_busy`; a duplicate completed submission
returns `409 credential_already_submitted`. An expired or cancelled nonce cannot create
another secret (`410 credential_request_gone`). An invalid nonce returns `403
credential_nonce_invalid`. A failed/unknown vault write terminates the request and leaves
a cleanup tombstone; create a new request rather than retrying the secret on the old one.
If a response is lost, GET the request; do not blindly resubmit.

`POST /api/credential-requests/:id/cancel` with `{}` revokes immediately and returns `200`
with the terminal view. Cancellation is idempotent, including already-terminal requests;
it does not undo a completed upstream side effect. No new operation is admitted after
the cancellation update. An operation already admitted before cancellation may finish;
its client HTTP request is bounded by five seconds and credential expiry. Cleanup waits
for its exclusive vault lock. `cleanupPending:true` means physical provider cleanup is
still pending, never that a new use remains permitted.

`GET /api/credential-requests/:id` returns the current authorized view and detects
expiry/disconnect. An example view (no nonce/secret/vault path):

```ts
{
  id: string, credentialRef: string, serviceId: string, targetOrigin: string,
  mode: 'api_header' | 'browser_login',
  state: 'pending' | 'submitting' | 'ready' | 'using' | 'active_session' | 'consumed' |
         'cancelled' | 'expired' | 'failed' | 'disconnected' | 'handoff_required',
  retention: 'once' | 'session', expiresAt: string, useExpiresAt: string | null,
  cleanupPending: boolean, version: number
}
```

`GET /api/credential-requests/:id/events` is an authenticated SSE snapshot stream,
emitting `credential.state`, `id: <version>` and the same view, then closing. EventSource
reconnects after two seconds; deduplicate by version and close it at terminal state.
This endpoint is separate from chat/run event storage. Authentication failures return
JSON HTTP errors; GET is also available when EventSource cannot expose an error body.

Errors always have `{ "error": "<fixed code>" }`, with no validation values or causes:

| HTTP | Codes / client behavior |
| --- | --- |
| 400 | `credential_request_invalid`, `credential_submission_invalid`, `credential_body_invalid`; correct input |
| 401 | `credential_auth_required`; sign in; do not retain input across accounts |
| 403 | `credential_csrf_rejected`, `credential_nonce_invalid`; stop and establish a fresh request |
| 404 | `credential_not_found`; nonexistent, foreign owner/session or unauthorized binding are indistinguishable |
| 409 | `credential_request_exists`, `credential_busy`, `credential_already_submitted`, `credential_not_ready`; refresh state |
| 410 | `credential_request_gone`; create a new request if still needed |
| 413 / 415 | `credential_body_too_large` / `credential_json_required` |
| 422 | `credential_service_unavailable`; no configured exact target. Executor `browser_handoff_required` means stop automated attempts and review the target; GET the terminal state |
| 501 | `browser_isolation_unavailable`; browser capability is unavailable; do not ask for a password |
| 502 / 503 | fixed execution/vault/configuration/availability codes; GET state before any retry |

Reference wiring for Claude (no UI implementation included):

```ts
const request = await fetch(withBasePath('/api/credential-requests'), {
  method: 'POST', credentials: 'same-origin',
  headers: { 'Content-Type': 'application/json', 'X-Mikka-Credential': '1' },
  body: JSON.stringify({ workspaceId, runId, serviceId, mode: 'api_header' }),
}).then(checkStatusAndJson)
// Keep nonce and input only in ephemeral form state. Explicit save choice defaults false.
await fetch(withBasePath(`/api/credential-requests/${request.id}/submit`), {
  method: 'POST', credentials: 'same-origin',
  headers: { 'Content-Type': 'application/json', 'X-Mikka-Credential': '1' },
  body: JSON.stringify({ nonce: request.nonce, secret: inputValue, save: explicitSaveChoice }),
}).then(checkStatusAndJson)
// Clear local input/nonce on submit, cancel, timeout, disconnect and unmount.
// On cancel POST {}. AbortController alone is not server cancellation; inspect server state.
// Never include the Request, submission body or inputValue in errors/analytics/chat.
```

## Controlled API executor and cleanup

`getCredentialBroker().use(credentialRef, expectedBinding)` is a server-only integration
point behind the reference-only tool adapter. `expectedBinding` is constructed from the
trusted authenticated execution context, not copied from model arguments. It includes
ownerId, workspaceId, taskId, runId, executionSession, authSessionId and serviceId.
Wrong bindings fail before vault read. Only a reference may enter tool arguments.

`MIKKA_CREDENTIAL_SERVICES` is an operator-owned JSON array of fixed operations:

```json
[{ "id": "example-api-check", "endpoint": "https://api.example.com/v1/credential-check", "method": "GET", "header": "Authorization", "prefix": "Bearer " }]
```

This is documentation, not a real configured service. Only GET/POST, Authorization or
X-Api-Key, and empty/`Bearer ` prefix are permitted. The registry owns the exact URL
(including path), method and header. The client cannot supply paths, query strings,
request bodies, headers or redirects. Use only trusted public service endpoints; the
deployment owner must control their DNS/egress policy. Do not register generic URL
fetchers, echo endpoints or sensitive/private network targets. Responses expose only
`{status:number}`; body, headers, redirect targets and exceptions are discarded because
upstreams can echo credentials. This proves an API HTTP result, not website login.

The broker uses a Postgres session advisory lock across each put/read/use/delete.
Cancellation updates are independent of that lock. State CAS, deadlines and a final
authority check occur after vault IO and before use admission. No DB transaction or
business write contains plaintext. Tombstones, created before provider writes, retain
unknown outcomes; repeated idempotent deletion handles a late provider write after an
earlier delete. Crashed `submitting`/`using` operations are failed once their lock is free.
There is no attempt to replay an upstream side effect after a crash.

Database triggers immediately revoke on run stop/termination/deletion or execution-session
change, device disable/delete/owner change, and auth session deletion/expiry update. They
enqueue durable cleanup without network IO. `broker.disconnect(ownerId, runId,
executionSession)` is also available to a trusted gateway on a transport disconnect.
This module does not rewrite BYOS disconnect code. Each use and sweep independently
checks run/session/lease/device state, so changed session/ended run/expired lease/revoked
login or membership blocks a new use. An unchanged database row cannot reveal a network
disconnect until the heartbeat/lease expires; instant detection requires the gateway
to call the hook. Client unmount/beacon delivery is not a disconnect guarantee.

`GET /api/cron/credential-cleanup` requires exact `Authorization: Bearer <CRON_SECRET>`
and runs a bounded sweep, independently of the admission enable flags. `vercel.json`
registers a once-per-minute cleanup invocation for a future authorized deployment.
**No scheduler has been deployed and no paid resource has been provisioned.** Check
plan support/capacity before any later deployment; an external scheduler can call the
same authenticated endpoint instead.
Create/status/use/cancel also perform relevant cleanup, but are not a substitute for
the scheduler when idle. Sweep batches rotate by `updated_at`; size/frequency must be
sufficient for all active rows/tombstones. Cleanup failures retain `cleanupPending` and
references; alert on sustained backlog without logging provider exceptions.

## Browser protocol and implemented owned Chromium executor

`lib/credentials/browser-protocol.ts` provides reference-only commands, legal phase
transitions and bounded receipts. `OwnedChromiumExecutor` implements these phases for
**new private backend-owned Chromium processes only**. The default production runtime
does not attach this executor and rejects browser_login with 501 before issuing a nonce
or accepting a secret. No existing shared browser, CDP URL, agent profile, viewer or
daemon CUA interface can be attached. There is no Boolean self-attestation to enable one.

The owned executor uses an anonymous debugging pipe, a fresh private temporary profile,
disabled page JavaScript and Service Workers, blocked WebSockets, no downloads, no
video/HAR/trace setup, and an exact form/submit/success URL allowlist. It therefore
supports static HTML forms only; JS-dependent login flows are unavailable. All DOM,
screenshot and click API calls across callers use the same synchronous fence and drain.
Raw CDP/recording are always forbidden. Debug protocol logging configurations are rejected.
The broker verifies a policy fingerprint including a randomly provisioned context identity
before vault read, preventing a reference from moving to another executor instance.

Successful login means an allowlisted site's exact success URL and selector were verified
while isolated; it is not universal login proof. An optional `continuation` policy keeps
authentication within the **same task/reference**. Inside the fence, only its named
HttpOnly cookie is transferred internally to a fresh private browser; the original
password process, form/POST history and profile are destroyed, and fresh inputs cleared.
The logical execution/context identity is retained. This process handoff is used to
prove password-history cleanup rather than guessing whether DOM clearing erased it.
No cookie getter, cookie file or CDP address is exposed to agents.

After the protected account page is verified, the phase lock is released and request
state becomes `active_session`. The original submitted password is deleted from vault.
The task can continue through the unified, reference-only operation:

```ts
await broker.continueBrowser(ref, trustedBindingWithService, { type: 'navigate', pageId: 'projects' })
await broker.continueBrowser(ref, trustedBindingWithService, { type: 'read', regionId: 'items' })
// { pageId: 'projects', text: '<bounded business text with known secrets redacted>' }
await broker.continueBrowser(ref, trustedBindingWithService, { type: 'click', targetId: 'account' })
await broker.finishBrowser(ref, trustedBindingWithService)
```

`browserTaskActionSchema` validates these commands; callers cannot supply URLs, CSS,
headers, JS, cookies or arbitrary input. Policy `continuation.pages` defines exact page
URLs, named readable regions and named non-form anchor links to another policy page:

```ts
continuation: {
  accountURL: 'https://service.example/account', accountSelector: '[data-account-id]', cookieName: 'session',
  pages: [
    { id: 'account', url: 'https://service.example/account',
      regions: [{ id: 'summary', selector: '[data-account-summary]' }],
      links: [{ id: 'projects', selector: 'a[data-projects]', pageId: 'projects' }] },
    { id: 'projects', url: 'https://service.example/projects',
      regions: [{ id: 'items', selector: '[data-project-list]' }] },
  ],
}
```

Only explicit main-frame GET navigation is allowed; subresources, background navigation,
frames, arbitrary form submission and arbitrary JS stay blocked. Reads strip sensitive
elements/root nodes, track cookie rotation across all paths privately, and redact exact
known password/cookie values using hash+length descriptors. Overlapping matches are
merged on original text, with lookahead before the 4096-character output cap. No password
plaintext is retained for redaction. This is not a universal detector of every unknown
token in arbitrary websites: policies must declare genuinely non-sensitive business
regions and harmless navigation links. Raw DOM/pixel/cookie/CDP interfaces remain closed
on authenticated sessions; structured region reads and named navigation/clicks are the
available computer-use capabilities.

Every operation rechecks the full original identity, live authority and TTL before and
after execution and serializes on the reference. A second service login cannot run over
an authenticated/fenced session. Cookie state lasts at most five minutes, additionally
clamped to the original credential deadline and current run lease. It is destroyed on
`finishBrowser`, cancel, disconnect, detected revocation or TTL; it never crosses tasks.
The runner must use the attached broker for lifecycle sweeps. Cleanup failure keeps
reference ownership and a fenced quarantine for retry, including failed replacement
processes. Old tombstones cannot delete a newer task's session. No timeout unlocks it.
Policies without continuation retain the one-shot destroy-and-blank behavior.

The 15-second operation deadline is checked before/after authorization and between phases;
browser actions, drain and process close also have timeouts. A blocked database query can
delay cleanup while the fence remains closed; this is not an absolute 15-second process
reclamation guarantee. A production runner needs process/cgroup supervision, watchdog
cleanup of orphan processes/profiles after a host/app crash, no untrusted shell on the
executor host/UID, and disabled external telemetry capture. These host controls have not
been deployed or verified. The local loopback fixture explicitly runs sandbox-disabled
Chromium only against synthetic loopback pages; non-fixture mode requires Chromium's
sandbox and HTTPS policies, and is not production-accepted by this test.

Actual trusted-server wiring (not a daemon API change):

```ts
const executor = new OwnedChromiumExecutor({ executablePath, policies: trustedStaticFormPolicies })
await executor.open(trustedBinding) // fresh blank process, no external browser attach
const broker = new CredentialBroker({ pool, vault, authority, services, browser: executor })
// Serve credentialHttp with this broker only on the dedicated trusted runner.
// A browser_login form request now resolves its service policy/context server-side.
// Reconstruct expectedBinding from current server auth/task context, never a model payload.
await broker.use(opaqueCredentialRef, { ...trustedBinding, serviceId })
await broker.continueBrowser(opaqueCredentialRef, { ...trustedBinding, serviceId }, { type: 'navigate', pageId: 'projects' })
await broker.continueBrowser(opaqueCredentialRef, { ...trustedBinding, serviceId }, { type: 'read', regionId: 'items' })
await broker.finishBrowser(opaqueCredentialRef, { ...trustedBinding, serviceId })
```

The default Next routes deliberately do not create long-lived Chromium children in a
serverless process. A dedicated runner integration is needed to expose this optional
backend capability outside the local harness; no runner/service/host is provisioned here.

Any extension to a general shared browser gateway must bind protocol version, operation/request/reference, owner,
workspace/task/run, execution session, browser context, exact origin, deadline and a
server-owned form policy. It must implement these operations before enabling admission:

1. `reserved → draining`: globally fence the browser/context from **every** agent and
   viewer. Stop and drain existing DOM, accessibility, screenshots, VNC/noVNC thumbnails,
   screen/video recorders, CDP reads/writes, trace/network/HAR/console capture, cookie
   sync and direct OS/browser/profile access. Block new calls across processes, agents,
   displays and gateway instances. A per-agent tool mutex is insufficient. Revoke old
   viewer/CDP handles and recording buffers; privileged gateway access is separate.
2. `isolated`: acknowledge the fence only after drain. Recheck exact origin, execution
   session, live grant and deadline, then let the isolated gateway resolve the reference
   from the vault directly; no `type(secret)` model command or secret-bearing RPC event.
3. `filled → submitted → verifying`: execute only server-owned form selectors. Recheck
   origin on redirects/frame changes. A submitted form is `submitted_unverified` unless
   a specific site's allowlisted verifier proves its defined result. There is no generic
   proof that arbitrary website login succeeded. Do not return pixels, DOM or cookies.
4. `scrubbing`: on success, failure, cancel, timeout, navigation or crash, keep the fence
   while destroying the isolated context or verifying site-specific cleanup of form DOM,
   history/autofill/storage, buffers, profile artifacts, recordings and traces. A worker
   restart must preserve the quarantine fence. Restore reads only with a bounded cleanup
   receipt. If cleanup/drain/origin verification cannot be proven, enter `quarantined`,
   destroy the context and never restore it by timeout alone.

The current shared CUA main does not implement this gateway, recording fence, OS isolation
or safe cookie sync. Header proxy support does not imply them. Linux acceptance separately
verifies the default 501/no-fill path and the owned executor's actual static-form login,
failure/cancellation cleanup, restoration and replacement-launch quarantine.

## Production gates and evidence

### Actual system registration increment (local candidate; acceptance pending)

The five reference-only tools `prepare_credential_request`, `credential_status`,
`credential_use`, `credential_browser_action` and `credential_finish` are registered
in the existing owner MCP, worker MCP, Agent route and durable Coordinator workflow.
`lib/credentials/execution-tools.ts` derives the live task, workspace and execution
session from the authenticated owner/run and the two existing databases. Workers
cannot override their run. Coordinator calls must name a live owned run. Submission
is still only the separate authenticated HTTP route; tools never accept a value or nonce.

`prepare_credential_request` returns `{serviceId,targetOrigin,mode,runId,taskId,
workspaceId,executionSession,submission:{method,url,body},instruction}`. Claude's form
uses `submission.body` to create the request, keeps the returned nonce in local memory,
and submits directly as described above. No form/card/UI was implemented here.
After a successful submit the backend inserts an opaque reference/service notification
into existing `run_messages`, deduplicated by request ID. A sweep retries delivery.
The worker can then use the reference and perform named browser actions, ending with
`credential_finish`. Finish also destroys saved API-header credentials.

The daemon reuses `RunAssignment.mcp`, storing its platform run token only in the
trusted daemon process. Its existing harness MCP child receives a random local
capability for exactly those five tools, not the platform token. Per-run sandbox
network rules allow only that bridge's exact host/port. Local handoff tool discovery
is immediate and does not contact the backend. Failed remote initialization can retry;
stopped/device-switched/terminal run grants refuse calls and are removed within five
seconds. The backend independently checks authority on every operation.

Owned-browser deployment settings are `MIKKA_CREDENTIAL_BROWSER_RUNNER=owned`,
`MIKKA_CREDENTIAL_RUNTIME_KIND=dedicated`, `MIKKA_CREDENTIAL_CHROMIUM_PATH` and trusted
`MIKKA_CREDENTIAL_BROWSER_POLICIES` (the `OwnedBrowserPolicy[]` contract). Serverless
Vercel processes explicitly reject owned-browser enablement. Deploy the stateful runner
as a dedicated trusted process apart from agent sandboxes; setting a flag does not
prove host isolation. Only one live browser request per owner/workspace/run/session
is admitted across service IDs. Idle pending browser sessions have a five-minute TTL;
the dedicated process sweeps every five seconds, alongside the staged cron cleanup.
Host crash/profile reclamation still requires a separately verified supervisor.

The fill strategy is bounded: validate an exact same-origin POST form, one visible,
enabled, editable password input and its matching submit control; try direct fill once;
on failure revalidate the same target, verify keyboard focus, clear it and type once.
No target guessing, arbitrary coordinates or retry after submit is allowed. DOM,
screenshot and click observers remain fenced throughout both attempts. An unsafe target
or exhausted keyboard attempt enters terminal `handoff_required`, destroys the password
context, deletes its vault record and ends the replacement session. Claude should close
the old request and ask the owner to review the target/start a fresh secure request;
never ask them to paste a password into chat. An interactive owner takeover transport
is not implemented by this backend or this status. Native apps and payments are excluded.

`scripts/accept-credential-system.mjs` exercises the actual Next routes and MCP
registration with isolated full-schema databases, synthetic TLS vault and test site.
It is not a fake-handler substitute. This environment currently fails before Next
startup: SWC's native loader rejects cache ancestors owned by another untrusted UID.
Standard cache and supported temporary materialization both fail; no security-check
skip or package downgrade was used. Actual system routes, SRT proxy and model-driven
harness acceptance are therefore **unverified**, even though their source is connected.

For the authorized token owner's later staging provider probe only,
`node --import tsx scripts/accept-credential-vault.mjs crud <private-manifest.json>`
requires `MIK79_ALLOW_STAGING_CRUD=1` plus privately supplied
`MIKKA_CREDENTIAL_VAULT_TOKEN`. It is hard-scoped to project
`89850d6a-f020-4936-863e-df77380dfe40`, staging `/credential-acceptance/mik79`, at most
four random synthetic names. The folder must already exist. It does not list secrets,
create folders, change IAM or read business records. It records exact names before
attempted writes and retries idempotent deletion; `cleanup <same-manifest.json>` retries
only that manifest's names after interruption. Values/token are never stored or printed.
With the user's explicit staging approval this script was executed through the inherited
platform proxy on 2026-10-24: four random synthetic records each returned POST 200,
GET 200 with in-process value comparison, DELETE 200 and final exact-name GET 404.
The dedicated `mik79` child folder was created after metadata confirmed it absent;
no business values or IAM were accessed. Evidence/manifest:
`/workspace/credential-backend-delivery/real-vault-GdnpQJ/`.
This is vault CRUD evidence only and cannot establish full Mikka system acceptance.
Do not copy an admin token
between threads or into any agent configuration.

Default is disabled. `MIKKA_CREDENTIAL_BROKER_ENABLED=1` plus
`MIKKA_CREDENTIAL_INGRESS_NO_BODY_CAPTURE=1` are necessary opt-ins. The latter is an
operator assertion, not a technical proof: verify all CDN/reverse-proxy/WAF/APM/error
monitoring/OpenTelemetry HTTP client instrumentation paths exclude submission bodies,
vault bodies and outbound credential headers before enabling. Application handlers do
not log those values. Current client analytics already disables exception capture and
session recording; Claude must preserve these rules around the form. Do not enable
auto-instrumentation that copies Fetch inputs or output bodies into telemetry.

Infisical v4 settings: `MIKKA_CREDENTIAL_VAULT_ORIGIN` (default
`https://us.infisical.com`), `MIKKA_CREDENTIAL_VAULT_PROJECT_ID`,
`MIKKA_CREDENTIAL_VAULT_ENVIRONMENT`, `MIKKA_CREDENTIAL_VAULT_PATH` (dedicated existing
folder), and `MIKKA_CREDENTIAL_VAULT_TOKEN` supplied through platform workload/secret
delivery. As of the online permission check reported by the parent on 2026-10-24,
the existing identity has project-wide admin permissions, including secret CRUD and
folder CRUD without environment/path conditions. Historical read-only identity notes
do not describe this current token. It can support platform-controlled custody; it
must not be given to an agent/runtime as a narrowly scoped reader. A dedicated test
folder and exact create/read/delete scope still require explicit authorization before
real acceptance. No IAM change or new identity is part of this patch. Token values never belong in a
local env file, command line, chat or repository. Official contracts:
[create](https://infisical.com/docs/api-reference/endpoints/secrets/create),
[read](https://infisical.com/docs/api-reference/endpoints/secrets/read),
[delete](https://infisical.com/docs/api-reference/endpoints/secrets/delete).

Existing main leases expire 90 seconds after claim and do not renew at heartbeat. The
credential broker does not weaken that check. Read-only inspection found PR #79 candidate
`9760e91299bf54165c04a2caafb383f9cc85b13f` implements `recordDeviceHeartbeat(db, deviceId,
harnesses, reportedRunIds)` and the existing `{leases: Record<runId, ISOTime>}` reply.
That candidate is not merged or included in this patch; long-running production sessions
need its separately reviewed renewal behavior. The local end-to-end test finishes inside
the legitimate initial lease; expired leases are explicitly tested as rejected.

Reproducible Linux test command (needs a dedicated loopback Postgres cluster and Chromium;
the runner creates two randomly named databases and drops only those it created):

```sh
CREDENTIAL_TEST_ADMIN_DATABASE_URL=postgres://agent@127.0.0.1:55439/postgres \
node scripts/test-credential-backend.mjs
```

The real HTTP tests use Better Auth signup/session cookies, actual Postgres SQL/locks,
two separate databases for the existing authority boundaries, a controlled localhost
upstream that echoes the synthetic secret, local Chromium test pages, and an in-memory
**fake** vault. Chromium itself, HTML filling/submission, HTTP and Postgres are real.
The general test suite uses a synthetic HTTP transport contract. A separate authorized
real Infisical synthetic CRUD probe is recorded above. No production credentials,
real account login, OAuth grants, SMS/email, paid resources, push, PR,
merge or deploy has been executed. No full Next production runtime/Preview acceptance
or platform telemetry configuration is established by this harness.
