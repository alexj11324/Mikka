# CPA subscription worker

Use this guide to verify the CLIProxyAPI (CPA) subscription worker and understand
its credential custody and execution boundaries. Runtime enablement comes from
`byosEnabled()` and `lib/deployment-switches.ts`. Community edition without a
PostHog key defaults BYOS and provider OAuth on, unless explicitly overridden.
Cloud edition retains its remote/legacy gate configuration. Check the effective
deployment switches when diagnosing availability.

## Verify the worker

Run the deterministic driver on the Agent's cloud Linux machine with Docker and
the repository's dependencies installed.

```sh
pnpm test:byos-worker
```

`scripts/test-subscription-worker.mjs` verifies the CPA revision in `CPA_COMMIT`,
starts isolated loopback PostgreSQL, applies the repository migrations, builds
the worker, enrollment receiver, and fixture executables, then runs Go race
tests, `go vet`, application/enrollment tests, and migration replay. Its success
message reports the applied migration count. Docker images and Go module sums
are pinned. It uses TLS fakes and fixture credentials. Live-provider acceptance
requires separate evidence.

The driver retains its PostgreSQL and build containers, including after failure,
and prints the PostgreSQL container name. Follow the isolated-test cleanup rules
in [runtime acceptance](../../docs/acceptance.md) after inspecting the result.

## Implemented path

The independent server enrollment receiver
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
   native device identity metadata is removed, no native fingerprint executor is used.
   Claude OAuth inference retains its required opening system block before
   Mikka's host instructions; omitting it returns 429 even with quota available.
   Errors, retries, cancellation and revocation fail closed without paid fallback.
7. Task claims pin the selected native binding and machine authority to the run.
   Under [Alex's #1505 decision](../../docs/design/decisions/2026-11-06-1800-machine-is-the-execution-boundary.md),
   the initial claim prepares a real short-lived subscription access lease for
   the assigned machine. Official Claude Code and Codex use it directly with
   their providers, with normal cloud HOME/environment/Git and no extra Docker,
   placeholder, provider proxy or per-call remote authorization. CPA remains
   the refresh-grant custodian; natural renewal happens in the background.

The worker is permanently scoped to one owner connection. No global tenant store
switch or account pool is used. Refresh claims serialize across processes;
routine rotation preserves bot bindings, reconnect/disconnect advance the epoch.
New turns refuse unavailable publications. Native refresh waits recognize their
own transient publication while still enforcing owner, epoch and binding.

## Backend credential boundary

Custody children acquire/refresh grants and publish two immutable artifacts: the
full grant and an independently validated access-only projection. Both references
publish in one Postgres transaction. Execution children receive access-only
reader credentials or an authorized access snapshot, depending on launcher
configuration. They cannot invoke custody methods or fall back to full bundles.
A trusted prepare call handles refresh and upgrades legacy projections without
another login. Go checks the owner/workspace/consumer/binding/route/model/revision
context of the authorized custody operation, not only the TypeScript caller.
Native Agent requests then go directly to their provider; they do not invoke
this worker for a permission check before every call. Quota HTTP stays in Go and
returns a numeric/boolean projection without bearer tokens or raw diagnostics.

`lib/subscription-runtime.ts` configures separate grant and access paths with
`MIKKA_BYOS_INFISICAL_PATH` and `MIKKA_BYOS_ACCESS_INFISICAL_PATH`. Custody needs
read/create/delete access on the required paths. The launcher supports separate
static tokens or Universal Auth identities for custody and access-only execution.
For the existing shared custody identity, `MIKKA_BYOS_SHARED_CUSTODY_IDENTITY=1`
uses authorized access snapshots for execution children. The custody identity
stays with the trusted launcher. `MIKKA_BYOS_ACCESS_INFISICAL_PROJECT` can locate
the projection in its configured access project. Check the launcher's validation
and [Infisical setup](../../docs/infisical-cloud.md) for the supported combination.
Source checks establish these code paths. Effective IAM and credential delivery
require evidence from the deployment being tested.

Production `nativeAuth` may return the access-only lease when the trusted
launcher explicitly sets `exportAccessLease: true` for an owner-bound run with
its frozen model and machine authority. The initial native task claim uses this
path. Ordinary RPC configurations, execution-only children and requests without
that explicit grant cannot export it. The provider refresh grant remains in
the custody worker and has no field in the native response. Metadata and
server-side model operations retain their ordinary authenticated interfaces;
they are not a mandatory proxy for the assigned machine's provider traffic.
Real official CLI/subscription execution and production timing remain distinct
release evidence; synthetic tests do not establish either.

## Credential deletion

An owner-bound durable artifact journal is written before any secret create.
Disconnect advances the epoch and clears live references before deletion.
Cleanup protects current/recoverable artifacts, tracks late writes and reports
pending/failed/uncertain creation states. Unknown remote commits remain queued
after 404 rather than being declared permanently deleted. Per-artifact and
per-connection retries rotate fairly. The authenticated BYOS cron drains bounded
batches through `/api/cron/subscriptions`, called hourly by the minute Worker.
Preparing another task also drains its connection. See
[the scheduler source](../../cloudflare/suggestions-cron/src/index.mjs) for
delivery configuration.

Enrollment source copies have their own path-aware journal. Canonical publication
records evidence atomically; before that point the sole recovery copy is protected
unless explicit disconnect/reconnect advances the epoch. Fresh global claim and
database identity checks prevent a losing preview from deleting the shared source.
Source-only failures are eligible for the same bounded cron. The acceptance flag
`MIKKA_BYOS_ACCEPTANCE_RETAIN_SOURCES=1` holds test-source deletion and reports
`deletion_not_authorized` only when `VERCEL_ENV=preview`; Mikka's branches have
no Vercel Preview, so it is inert today. Production ignores that flag and normal owner-requested cleanup/retries remain.
Separate approval applies to our real-vault test cleanup; callback handoff never needs a global
operator/vault key in the browser or Mac. Token-free immutable
claims remain for replay protection; unknown/uncertain creates stay pending after
404 to catch late commits. Status exposes missing configuration, ownership proof
and deletion failures. Cleanup/status/disconnect custody works without an inference
reader; execution children receive none of the enrollment paths.

Provider revocation is explicitly `not_implemented`. Historical artifacts whose
references were already lost before the journal cannot be attributed/deleted
automatically. Known prior references are
backfilled by the additive migration. Real deletion permission and API operation
require deployment-bound acceptance. Record logical stop and physical deletion
as separate outcomes.

## Private process boundary

The production executable reads one trusted configuration frame over stdin,
then private RPC. It opens no HTTP listener and reads no local provider credentials.
Status APIs contain metadata only; connection ceremony responses additionally
contain the public authorization URL, opaque attempt handle and device user code.
Native access material is returned by the explicitly authorized production
access-lease path described above, as well as the corresponding test capability.
A generic model RPC cannot enable native export or select custody methods.
Refresh grants and Infisical workload credentials stay in the custody service;
the assigned CLI receives the real provider access token, not a placeholder.

Three small original bridge files are installed in the ignored pinned upstream
checkout: data/converter aliases, a plain Codex HTTP constructor, and a plain
Claude constructor/exchange. No tracked upstream source is modified. The MIT
license is preserved; no Comma source is copied. Built-in cloaking/fingerprint
model executors are never registered.

The fixture executable requires its explicit build tag and a loopback test
database. It is not a mode or registry flag in the production worker.

## Release evidence

HTTP/OAuth, streaming, and private launcher wiring have source implementations.
For the revision being released, record provider client/redirect compatibility,
actual token/native CLI execution, provider billing controls, effective Infisical
workload delivery, and E2B owner isolation under
[runtime acceptance](../../docs/acceptance.md). This README's source review does
not determine a deployment's acceptance status. Required subscription/model paths
and independent-path handling follow [AGENTS.md](../../AGENTS.md).

Codex uses CPA device authorization with its provider-owned callback. Claude
preserves CPA loopback redirect with explicit owner/session/state/PKCE-bound URL
handoff in the Mikka form. Arbitrary Mikka HTTPS redirects are not supported.
The protocol is defined by the source in this package.

One task owns one E2B VM, which is the execution boundary. The selected CLI's
model/subscription authentication and authorized GitHub credential use ordinary
native runtime files. Reusable templates contain no task credentials. Revocation
persists and pushes a stop or reclaims the VM, while local stops preserve
unrelated work. Provider refresh grants and the custody workload identity stay
with the trusted service.

Other task Secrets use a separate delivery policy. In
`lib/secrets/{runtime,delivery,task-access}.ts`, ordinary environment configuration
and explicitly approved direct Secrets enter task environment values. Protected
Secrets require a configured HTTP policy and a run-bound capability. Missing or
unsupported policies produce an unavailable result. Legacy metadata defaults to
protected delivery. See the
[credential exposure decision](../../docs/design/decisions/2026-11-08-0240-credential-exposure-boundary.md).
These are source contracts. Effective protection on a deployed task requires
runtime evidence for that revision and environment.

Provider revocation and pre-journal orphan discovery remain implementation gaps.
The durable known-artifact cleanup tests exercise local fakes. Verify real-vault
deletion permission, workload-token delivery/renewal, and cleanup results in the
authorized deployment. Disconnect fences Mikka use immediately. Provider-side
revocation and requests already transmitted have separate outcomes.
