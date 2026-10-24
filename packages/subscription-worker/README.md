# CPA subscription worker

Current source-level integration: [BYOS flow and activation gates](../../docs/design/byos-integration.md).
The feature is disabled by default. Synthetic acceptance is not real-provider acceptance.

Run on the Agent's cloud Linux machine:

    pnpm test:byos-worker

This verifies the exact official CPA commit, starts disposable loopback Postgres,
applies all 29 migrations, builds the production and acceptance-only executables,
runs Go race tests and vet, then runs application/native/browser acceptance and
migration replay. No real grant, account credentials, Infisical write, provider
inference or E2B sandbox is used. Docker images and Go module sums are pinned.

## Implemented path

1. Settings Connect starts a NEW provider OAuth attempt through Mikka's authenticated
   subscription API. No native CLI auth file, Keychain or browser-cookie import exists.
2. The worker binds owner/workspace/connection, a hash of the Mikka session, random
   state, S256 PKCE, a five-minute TTL and one-time callback consumption.
   PKCE verifier material stays in Infisical; Postgres stores metadata/references.
3. Provider acquisition uses actual CPA credential types and login/store managers.
   Codex uses CPA's OAuth service with an injected bounded ordinary HTTP client.
   Claude uses a narrow Mikka exchange beside CPA's types, excluding the upstream
   fingerprint constructor, generated device pool and native roles replay.
   Requests identify Mikka honestly; redirects are refused.
4. Canonical bundles preserve credential/identity/expiry fields. Imported endpoints,
   headers, proxy settings, hooks and fingerprint configuration never become grants.
   The actual Codex partition refresh patch merges against the latest bundle.
5. Infisical v4 creates a unique immutable secret and reads pinned version one.
   Postgres operation/epoch/version checks publish it. Lost-write or database
   publication recovery never repeats a potentially consumed grant.
6. The app resolves persisted owner/consumer bindings, checks workspace membership,
   quota/capability/billing policy and streams through the private worker.
   CPA converters run through a separate ordinary Mikka HTTP model adapter;
   native identity metadata is removed, no native fingerprint executor is used.
   Errors, retries, cancellation and revocation fail closed without paid fallback.
7. The native launcher uses the same connection through access-only leases and
   existing daemon adapters. Codex has host-managed login/refresh callbacks.
   Claude uses its documented OAuth environment input and ends at access expiry;
   its SDK has no documented host refresh callback. A later start reuses the
   platform connection and refresh authority without login.

The worker is permanently scoped to one owner connection. No global tenant store
switch or account pool is used. Refresh claims serialize across processes;
routine rotation preserves bot bindings, reconnect/disconnect advance the epoch.
New turns refuse unavailable publications. Native refresh waits recognize their
own transient publication while still enforcing owner, epoch and binding.

## Private process boundary

The production executable reads one trusted configuration frame over stdin,
then private RPC. It opens no HTTP listener and reads no local provider credentials.
Status APIs contain metadata only; connection ceremony responses additionally
contain the public authorization URL, opaque attempt handle and device user code. Native access material is returned
only by the private nativeAuth RPC, consumed by the trusted launcher; model RPC
cannot select arbitrary methods. Infisical workload credentials never enter CLI
environments. The broker interface can be implemented by a private remote channel.

Three small original bridge files are installed in the ignored pinned upstream
checkout: data/converter aliases, a plain Codex HTTP constructor, and a plain
Claude constructor/exchange. No tracked upstream source is modified. The MIT
license is preserved; no Comma source is copied. Built-in cloaking/fingerprint
model executors are never registered.

The fixture executable requires its explicit build tag and a loopback test
database. It is not a mode or registry flag in the production worker.

## Unverified release gates

The code now includes HTTP/OAuth, streaming and private launcher wiring. Live
activation remains separate: provider client/redirect compatibility and
eligibility, actual token/native CLI compatibility, provider billing controls,
Infisical workload setup, and verified E2B owner isolation are not established.
Codex now uses CPA device authorization with its provider-owned callback. Claude
preserves CPA loopback redirect with explicit owner/session/state/PKCE-bound URL
handoff in the Mikka form. Arbitrary Mikka HTTPS redirects are not supported.
See docs/design/byos-oauth-transport.md for exact protocol and remaining live gates.

Config directories are not a security boundary against a same-user shell.
The web runtime never attests native isolation. Real E2B wiring must keep the
credential broker/control-plane secrets outside untrusted compute. No topology
or metered provisioning was selected here.

Provider revocation, historical secret/attempt GC and deployment workload-token
delivery/renewal remain operational integration work. Disconnect fences Mikka
use immediately; it does not claim provider-side revocation or undo an already
transmitted request.
