# CPA subscription worker

Current source-level integration: [BYOS flow and activation gates](../../docs/design/byos-integration.md).
The feature is disabled by default. Synthetic acceptance is not real-provider acceptance.

Run on the Agent's cloud Linux machine:

    pnpm test:byos-worker

This verifies the exact official CPA commit, starts disposable loopback Postgres,
applies all 34 migrations, builds the production and acceptance-only executables,
runs Go race tests and vet, then runs application/native/browser acceptance and
migration replay. No real grant, account credentials, Infisical write, provider
inference or E2B sandbox is used. Docker images and Go module sums are pinned.

## Implemented path

The independent [server enrollment receiver](../../docs/design/byos-server-enrollment.md)
can receive consent before SQL/reader/native setup. Its private bind route then
requires actual Mikka session/workspace authorization plus source operator
authority, publishes through the same Store lifecycle and fences one-time source
ownership globally. No user-side Infisical install/login is needed. Redundant escrow/PKCE copies
are eligible for authorized deletion after canonical publication; owner-directed disconnect and the shared
retry queue cover all recorded copies. Unknown remote writes remain explicitly
pending. Live account/provider/deployment acceptance remains separate from
synthetic canonical publication and deletion tests.

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
7. Bot claims pin a native binding to the run. The opt-in hosted Linux daemon
   uses the existing adapters in a network-isolated Docker runtime. Its external
   Unix-socket broker injects credentials in Go; the CLI receives only a public
   placeholder. CPA remains the refresh authority. See the current hosted broker
   section in the integration document for boundaries and unverified gates.

The worker is permanently scoped to one owner connection. No global tenant store
switch or account pool is used. Refresh claims serialize across processes;
routine rotation preserves bot bindings, reconnect/disconnect advance the epoch.
New turns refuse unavailable publications. Native refresh waits recognize their
own transient publication while still enforcing owner, epoch and binding.

## Backend credential boundary

Custody children acquire/refresh grants and publish two immutable artifacts: the
full grant and an independently validated access-only projection. Both references
publish in one Postgres transaction. Execution children receive only the access
reader identity; they cannot invoke custody methods or fall back to full bundles.
A trusted prepare call handles refresh and upgrades legacy projections without
another login. Go enforces owner/workspace/consumer/binding/route/model/revision
and quota at use, not only in the TypeScript caller. Quota HTTP stays in Go and
returns a numeric/boolean projection without bearer tokens or raw diagnostics.

`MIKKA_BYOS_ACCESS_INFISICAL_PATH` and `MIKKA_BYOS_ACCESS_INFISICAL_TOKEN` are new
private configuration. The access path and reader identity must differ from the
grant path/identity. Custody needs read/create/delete on both exact BYOS paths;
the execution identity needs read-only access on the access path, no grant-path
access. Source checks do not establish actual IAM policy. No identities, grants
or permissions were configured during synthetic validation. Ordinary trusted
platform custody remains readable to its authorized runtime/operators.

The production executable refuses raw native credential export unconditionally.
Its nativeContext/nativeStream RPCs return metadata and brokered protocol bytes,
never the bearer token. They require a live owner-bound run and exact model.
The device route additionally requires an operator allow-list and advertised
hosted-broker capability. Fake CLI integration and real Claude offline shell
acceptance passed; actual vendor compatibility and E2B delivery remain unverified.

## Credential deletion

An owner-bound durable artifact journal is written before any secret create.
Disconnect advances the epoch and clears live references before deletion.
Cleanup protects current/recoverable artifacts, tracks late writes and reports
pending/failed/uncertain creation states. Unknown remote commits remain queued
after 404 rather than being declared permanently deleted. Per-artifact and
per-connection retries rotate fairly. The authenticated BYOS cron drains bounded
batches daily; preparing another task also drains its connection. Scheduling is
source configuration only until an authorized deployment.

Enrollment source copies have their own path-aware journal. Canonical publication
records evidence atomically; before that point the sole recovery copy is protected
unless explicit disconnect/reconnect advances the epoch. Fresh global claim and
database identity checks prevent a losing preview from deleting the shared source.
Source-only failures are eligible for the same bounded cron. Current Web
configuration holds source deletion and reports `deletion_not_authorized` until
a separate exact cleanup scope is approved; callback handoff never needs a global
operator/vault key in the browser or Mac. Token-free immutable
claims remain for replay protection; unknown/uncertain creates stay pending after
404 to catch late commits. Status exposes missing configuration, ownership proof
and deletion failures. Cleanup/status/disconnect custody works without an inference
reader; execution children receive none of the enrollment paths.

Provider revocation is explicitly `not_implemented`; no undocumented endpoint
is invented. Historical artifacts whose references were already lost before the
journal cannot be attributed/deleted automatically. Known prior references are
backfilled by the additive migration. Real deletion permission and API operation
remain untested; logical stop and physical deletion are distinct outcomes.

## Private process boundary

The production executable reads one trusted configuration frame over stdin,
then private RPC. It opens no HTTP listener and reads no local provider credentials.
Status APIs contain metadata only; connection ceremony responses additionally
contain the public authorization URL, opaque attempt handle and device user code. Native access material is returned only by explicitly enabled library/test
capabilities; the production nativeAuth RPC refuses export. Model RPC cannot
select custody methods. Infisical workload credentials never enter CLI
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

Provider revocation, pre-journal orphan discovery and deployment workload-token
delivery/renewal remain operational integration work. Durable known-artifact
cleanup is implemented and tested against local fakes, not real vault records. Disconnect fences Mikka
use immediately; it does not claim provider-side revocation or undo an already
transmitted request.
