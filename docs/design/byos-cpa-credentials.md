# CPA subscription credentials: storage and lifecycle adapter

Current source wiring, validation and activation prerequisites are recorded in
[BYOS integration](byos-integration.md). Both acquisition adapters, the HTTP
ceremony, streaming model adapter and private native launcher are implemented
behind disabled flags. No real provider compatibility is implied by mock tests.

Engineering review, 2026-10-24. The requested acquisition path is **CPA's Codex
and Claude subscription login**, followed by platform custody and reuse. It is
not a switch to generic SaaS OAuth or an SIWC-only product. Infisical is the
preferred managed backing store. The implementation now includes a pinned CPA
worker/store library, Infisical v4 HTTP adapter and additive Postgres metadata
migration. Acquisition/rotation are exercised through actual CPA SDK managers
with synthetic issuer/Infisical HTTP. No real OAuth grant, secret import/write,
SaaS account, connector or new vault has been configured.

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
callback routing requires a verified client/redirect pair. Mikka now implements
session-bound PKCE/state/TTL/one-time callback handling and separate ordinary
HTTP acquisition adapters. The executable never registers these CLI-oriented
authenticators or their unrestricted URL printing. Both adapters are disabled
by default; actual provider services/types are tested against TLS fixtures.
No real provider flow ran here.

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

The implemented Go Store binds one owner/workspace/connection for its lifetime,
queries Postgres using that scope, and calls Infisical directly with a trusted
workload token. CPA's store signature does not carry Mikka ownership; ownership
is never taken from Auth.Metadata. A trusted control-plane parent supplies scope
and configuration over private stdio. There is no public management listener,
request-controlled store switch or user-selectable account pool.

Infisical's documented v4 API provides unique-name creation and version-specific
reads; its update contract does not document a conditional-version parameter.
The implementation therefore never PATCHes a secret or assumes Infisical CAS.
It uses Postgres conditional updates and staged immutable-name publication:

1. Claim a bounded per-connection refresh operation against current authorization
   epoch and credential version;
   block concurrent refresh/use of a grant that may rotate.
2. Fetch only the referenced bundle and perform CPA refresh once. Do not let a
   native CLI independently rotate that same grant in parallel.
3. Normalize returned fields; merge a Codex patch into the latest bundle under
   the lease. Store a new immutable/version-pinned secret reference.
4. Publish that reference using a transactional epoch/credential-version check. A
   reconnect/disconnect that advanced the revision prevents publication.
5. If persistence/publication is uncertain, retain `publication_pending` and
   deny use. Recovery reads only that staged name/version, verifies scope/digest,
   and publishes without another OAuth/refresh call. A missing/invalid value
   stays unavailable; no in-memory credential can bypass the database fence.

These boundaries are implemented in `packages/subscription-worker` and tested
against real isolated Postgres and TLS HTTP fakes. Normal refresh keeps the
account epoch/bot binding; explicit reconnect/disconnect advances it. Expired
operations cannot automatically replay a potentially rotated grant. Inference
receives access material without refresh/ID tokens. No encryption algorithm or
general vault is introduced. Live Infisical workload permissions, region/path,
audit behavior, limits and latency still require separately authorized setup.
Historical secret deletion, orphan-version GC and provider-side revocation are
not implemented by logical disconnect.

## Both consumers of the connected account

| Consumer | CPA-compatible execution design | Remaining compatibility proof |
| --- | --- | --- |
| Mikka own harness | Agent route resolves persisted owner/consumer bindings and streams through private Go RPC, actual CPA converters and ordinary Mikka HTTP transports. HTTP consent/store/tool-stream/error/cancel/revocation integration tests pass | Actual provider client/redirect, eligibility, model API compatibility and billing controls remain unverified. Built-in identity-cloaking model executors are excluded |
| Hosted native Codex | Access-only `chatgptAuthTokens`, host refresh callback, service dispatch and private native launcher are wired; nine fake app-server tests and the application integration pass | Actual CPA audience/pinned CLI and verified E2B runner remain unverified. SIWC is not silently converted. The CLI receives no refresh grant |
| Hosted native Claude Code | Private lease, service dispatch and native launcher use the documented OAuth input, separate runtime home and account-mode check; eight fake CLI tests and application integration pass | No documented host refresh callback: the child ends at expiry and the next start reuses CPA refresh authority. Real scopes/native acceptance and verified E2B runner remain unverified; no native credential-file import/projection |

One Mikka connection represents one provider account and serves both consumers. Connecting once means
reuse across normal tasks and worker restarts, not a promise that every token
works in both consumers. Disclose separate initial consent if required. Native
credential-file import/projection is outside this feature. A native process that
must hold a credential can expose it if compromised; never claim absolute
secrecy. No projection or credential-file reading was implemented/run here.

The Claude boundary is now implemented without native credential-file
conversion. The installed SDK `0.3.305` documents the OAuth environment input,
exposes `accountInfo()` and bundles CLI manifest `2.1.305`; no official CLI was
invoked with a grant. Its public interface has no host token-refresh callback.
Consequently long-running native Claude sessions stop at access expiry rather
than independently refreshing or switching billing modes. A subsequent start
can obtain a refreshed access lease from the same CPA connection without login.
Transparent continuation across that boundary remains future session work.
The native CLI receives access material in its process environment; a hosted
runtime must isolate that owner from other shell users. A different config
directory alone cannot provide that security boundary.

The [official Codex app-server authentication reference](https://learn.chatgpt.com/docs/app-server#authentication)
documents `chatgptAuthTokens` and `account/chatgptAuthTokens/refresh` for hosts
that own auth lifecycle; it is experimental and does not prove CPA credential
compatibility. Existing local native login is independent; it is not an
acquisition/import fallback for platform BYOS. Claude's
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
would include behavior this phase explicitly excludes. The implemented plain
Mikka adapters use narrow HTTP constructor/exchange bridges and CPA converters;
they exclude built-in model executors, generated native identity metadata and
fingerprint transports. The current integration document records exact source
differences and unverified live compatibility rather than calling it supported.
The worker now depends on the pinned CPA SDK; its MIT license is preserved in
`packages/subscription-worker/third_party`. A small original type-alias bridge
exposes actual upstream credential structs/patch logic without changing tracked
upstream files. Built-in CPA model executors and fingerprint/cloaking transports
are not registered or executed. No upstream full test suite, live executor or
real credential acquisition ran. Comma's AGPL source is not copied. Provider
authorization remains an independent release gate.

## Optional E2B delivery

[E2B Secrets](https://e2b.dev/resources/introducing-e2b-secrets) can inject headers
outside sandbox memory/files to specific HTTPS destinations, with write-only
value management and rotation affecting later requests. That can complement
the CPA broker where a supported request shape allows it. It does not acquire
or refresh OAuth grants and does not convert CPA bundles into native CLI state.
Do not select a second proxy stack just to store a bundle. Keep `E2B_API_KEY`
in the control plane and owner-bound secret references out of model control.
