# CPA subscription credentials: storage and lifecycle adapter

Engineering review, 2026-10-24. The requested acquisition path is **CPA's Codex
and Claude subscription login**, followed by platform custody and reuse. It is
not a switch to generic SaaS OAuth or an SIWC-only product. Infisical is the
preferred existing managed store to evaluate. No new vault, credential table,
SaaS account, OAuth grant, secret import/write or connector is implemented here.

Mikka owns account authorization; CPA acquires/uses provider grants; Infisical
stores those bundles; E2B supplies compute. A workspace member does not thereby
own another member's subscription. The browser receives connection status and
safe login ceremony data, never token bundles or provider passwords. Each
provider must be shown as available, unverified or blocked honestly.

## Verified CPA extension points

Reviewed source at CPA `8289ec4c71ad914d0612c2776352b76ba3d355a6`:

| Extension | Verified behavior | Mikka adapter responsibility |
| --- | --- | --- |
| [`sdk/cliproxy/auth/store.go`](https://github.com/router-for-me/CLIProxyAPI/blob/8289ec4c71ad914d0612c2776352b76ba3d355a6/sdk/cliproxy/auth/store.go) | `List(ctx)`, `Save(ctx,*Auth)(string,error)`, `Delete(ctx,id)`; no tenant parameter | Construct an owner/connection-scoped store instance or validate trusted owner context on every operation; never list a global pool for user requests |
| [`sdk/auth/manager.go`](https://github.com/router-for-me/CLIProxyAPI/blob/8289ec4c71ad914d0612c2776352b76ba3d355a6/sdk/auth/manager.go) | Login invokes store Save; manager accepts a Store | Use same adapter for acquisition and runtime persistence; require successful durable save before publishing connected state |
| [`sdk/auth/store_registry.go`](https://github.com/router-for-me/CLIProxyAPI/blob/8289ec4c71ad914d0612c2776352b76ba3d355a6/sdk/auth/store_registry.go) | Global `RegisterTokenStore` / `GetTokenStore`, default file store | Do not swap a process-global store per concurrent user request; isolate worker/manager instances or retain immutable trusted owner scope |
| [`sdk/cliproxy/auth/types.go`](https://github.com/router-for-me/CLIProxyAPI/blob/8289ec4c71ad914d0612c2776352b76ba3d355a6/sdk/cliproxy/auth/types.go) | `Storage` and `CodexRefreshPatch` are excluded from JSON; Metadata may be separate from initial token storage | Never serialize Auth blindly: normalize typed Storage plus Metadata into the provider credential bundle; never persist arbitrary runtime URLs/proxy/header configuration from imports |
| [`conductor_refresh.go`](https://github.com/router-for-me/CLIProxyAPI/blob/8289ec4c71ad914d0612c2776352b76ba3d355a6/sdk/cliproxy/auth/conductor_refresh.go), [`conductor_lifecycle.go`](https://github.com/router-for-me/CLIProxyAPI/blob/8289ec4c71ad914d0612c2776352b76ba3d355a6/sdk/cliproxy/auth/conductor_lifecycle.go) | Per-auth refresh locking, registration/credential versions, `UpdateRefreshedAuth` and store persistence | Extend protection across worker processes and reconnects; retain one refresh authority; do not assume process-local locks coordinate multiple replicas |
| [`codex_persist.go`](https://github.com/router-for-me/CLIProxyAPI/blob/8289ec4c71ad914d0612c2776352b76ba3d355a6/sdk/cliproxy/auth/codex_persist.go) | Refresh patch merges with current credential partitions, using disk/file-lock semantics in the native store | Apply equivalent patch semantics to latest stored bundle under a Mikka revision/lease; do not overwrite newer outer/SIWC partitions with an old full snapshot |
| [`internal/api/handlers/management/auth_files_crud.go`](https://github.com/router-for-me/CLIProxyAPI/blob/8289ec4c71ad914d0612c2776352b76ba3d355a6/internal/api/handlers/management/auth_files_crud.go) | Full management surface directly handles auth-dir files | A Store replacement alone does not make the entire CPA server diskless or tenant-safe; do not expose this management API to browsers |

CPA's [`CodexAuthenticator`](https://github.com/router-for-me/CLIProxyAPI/blob/8289ec4c71ad914d0612c2776352b76ba3d355a6/sdk/auth/codex.go)
supports PKCE/browser login and a device flow; callback defaults to port 1455.
[`ClaudeAuthenticator`](https://github.com/router-for-me/CLIProxyAPI/blob/8289ec4c71ad914d0612c2776352b76ba3d355a6/sdk/auth/claude.go)
uses PKCE/browser callback (default 54545), with a prompt fallback. Hosted
callback routing, concurrent attempts, state/expiry/one-time consumption and
safe event delivery need a dedicated adapter. Their CLI-oriented URL printing
must not become unrestricted application logs. None of these flows ran here.

## Infisical-compatible design

Use a workload identity scoped to a dedicated BYOS project/environment/path,
separate from platform secret syncs such as `prod:/vercel`. Store one canonical
CPA bundle per opaque connection/grant reference. Never sync all user secrets
to Vercel or E2B environment variables. Use opaque names, not email addresses.

Neon stores metadata only: Mikka owner/workspace/provider, stable upstream
identity, state, connection revision, secret reference and refresh lease. The
complete CPA payload (access/refresh/ID tokens, expiry and provider-required
grant fields) stays in Infisical and trusted CPA process memory. Canonical
Codex outer and SIWC grants are distinct partitions if both exist. Preserve
required fields but reject arbitrary endpoint, proxy, header, filename and
executable metadata. The model sees model results, never the bundle.

The public connection revision is an **authorization epoch**: reconnect,
disconnect or account replacement changes it. Routine successful refresh only
advances a private credential version/secret reference under that epoch. It
must not invalidate all bot bindings or ask the user to reconnect per task.

The custom Go Store maps CPA List/Save/Delete to this service through a private
authenticated broker. CPA's store signature does not carry Mikka ownership;
do not infer ownership from Auth.Metadata supplied by a client. The broker's
workload/request identity supplies the immutable connection scope. Use CPA's
published lifecycle/executor extension points behind that boundary. No
public unauthenticated proxy listener or user-selectable account pool is needed.

Infisical provides managed storage and versioning; **atomic conditional update
semantics for our exact deployment/API have not been established**. Do not
pretend a read-then-update sequence is compare-and-swap. Before integration,
verify immutable/versioned read/write support and choose either an appropriate
native conditional write or a Neon lease plus staged-secret publication:

1. Claim a renewable per-connection refresh lease against current authorization
   epoch and credential version;
   block concurrent refresh/use of a grant that may rotate.
2. Fetch only the referenced bundle and perform CPA refresh once. Do not let a
   native CLI independently rotate that same grant in parallel.
3. Normalize returned fields; merge a Codex patch into the latest bundle under
   the lease. Store a new immutable/version-pinned secret reference.
4. Publish that reference using a transactional epoch/credential-version check. A
   reconnect/disconnect that advanced the revision prevents publication.
5. If the provider rotated but persistence/publication outcome is uncertain,
   mark unavailable/reconnect-required; do not silently keep spending through
   an in-memory token. Retry known-idempotent storage publication only after
   resolving its outcome. Clean orphaned secret versions asynchronously.

These are integration steps, not implemented transactions. No encryption
implementation or general-purpose credential vault is introduced. Verify
Infisical's service limits, audit redaction, latency, access isolation and
delete/version-retention semantics before selecting its final API.

## Both consumers of the connected account

| Consumer | CPA-compatible execution design | Remaining compatibility proof |
| --- | --- | --- |
| Mikka own harness | Explicit `codex_cpa` / `claude_cpa` binding resolves an owner-scoped supplied-credential worker. It reuses reviewed CPA authorization/refresh/execution adapters, then adapts model streaming into the existing AI SDK loop | Build the pinned worker with safe transport/configuration, normalize tokens correctly, enforce fixed upstream destinations, verify eligibility and account-bound quota, scrub raw errors. Real CPA execution is not wired in this slice |
| Hosted native Codex | Existing `CodexAdapter` continues to run official app-server. Evaluate its experimental host-managed `chatgptAuthTokens` mode plus refresh callback so CPA can remain the single refresh writer; a native-state projection is another compatibility option | The adapter does not implement these auth RPCs today. Validate CPA token audience/scope, stable account ID, expiry, protocol version and host-refresh handshake. CPA JSON is not native `auth.json`. Never let CPA and CLI rotate the same grant independently |
| Hosted native Claude Code | Existing SDK/bundled CLI adapter continues to execute. Account connection may contain a verified native grant/state reference alongside the CPA grant | CPA's flattened JSON is not Linux `claudeAiOauth` state. Native `.credentials.json`/config path and refresh behavior require an explicit tested bridge; preserve required provider fields and choose a single refresh writer |

One Mikka connection can hold provider-specific grants. Connecting once means
reuse across normal tasks and worker restarts, not a promise that every token
works in both consumers. Disclose separate initial consent if required. Future
native projection, if approved, must be outside shared project files, atomic,
owner-only and protected by a verified runtime boundary. A native process that
must hold a credential can expose it if compromised; never claim absolute
secrecy. No projection or credential-file reading was implemented/run here.

The [official Codex app-server authentication reference](https://learn.chatgpt.com/docs/app-server#authentication)
documents `chatgptAuthTokens` and `account/chatgptAuthTokens/refresh` for hosts
that own auth lifecycle; it is experimental and does not prove CPA credential
compatibility. Managed native login remains a fallback integration option under
the same account, with any distinct initial consent disclosed. Claude's
[documented native auth inputs](https://code.claude.com/docs/en/authentication)
also require a version-specific compatibility test; the environment's OAuth
token input is not evidence that arbitrary CPA JSON is a native credential.

## Comma reference and transport constraints

[Comma `ddcdcc5` account-proxy](https://github.com/AFK-surf/Comma/blob/ddcdcc5bd49620cefa623da2f38b98e72a7b613e/systems/account-proxy/README.md)
uses tenant-owned encrypted persistence and versioned refresh claims in Salix,
then supplies one selected credential to its Go worker. The worker is distinct
from native Claude process launch in station. Its
[bootstrap](https://github.com/AFK-surf/Comma/blob/ddcdcc5bd49620cefa623da2f38b98e72a7b613e/systems/account-proxy/bootstrap.sh)
pins CPA `d33f63f8e3d98428440ebca5a5b6a981a61ff71e`, not the reviewed newer
CPA commit. We reuse the ownership/worker separation as a design reference,
without copying Comma's AGPL source or building its account-pool fallback.

CPA contains client identity/fingerprint/cloaking paths. Reusing it wholesale
would include behavior this phase explicitly excludes. The next worker design
must inventory and disable/remove those paths using reviewed upstream
extension points or a narrowly maintained patch; if not separable, return that
specific blocker rather than copying the transport and calling it supported.
No CPA code/dependency is bundled in this slice, and no upstream test suite or
live executor was run. CPA's MIT license and Comma's AGPL license were checked;
provider authorization is an independent release gate.

## Optional E2B delivery

[E2B Secrets](https://e2b.dev/resources/introducing-e2b-secrets) can inject headers
outside sandbox memory/files to specific HTTPS destinations, with write-only
value management and rotation affecting later requests. That can complement
the CPA broker where a supported request shape allows it. It does not acquire
or refresh OAuth grants and does not convert CPA bundles into native CLI state.
Do not select a second proxy stack just to store a bundle. Keep `E2B_API_KEY`
in the control plane and owner-bound secret references out of model control.
