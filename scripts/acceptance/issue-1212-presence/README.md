# #1212 owner-device presence acceptance

This driver has not been executed in production. It sends no model prompt, installs no daemon and claims no task. It uses the normal ACME owner session, one nonce-marked temporary device, one normal HTTP heartbeat, native device/live WebSockets and three independent workers. Signed tickets, grants, raw device credentials and cookies remain in memory; report data contains counters, state transitions and fixture IDs only.

## Exact source and execution

The after source is PR #1538 `e93d84b196cc58f4c81abd12fd0fa2146ec98b09`, stacked on #1531. `presence-source-hashes.json` pins every actual core module and its hook/component provenance. Node 24 strips TypeScript and adds relative `.mjs` import suffixes; no product algorithm is rewritten. A final merge commit with identical pinned blobs is valid.

Required inputs are the existing `ACME_DEMO_EMAIL` / `ACME_DEMO_PASSWORD`, `MIKKA_ACCEPTANCE_SHA` (exact serving application commit), `MIKKA_PRESENCE_RUN_KEY` (unique lowercase nonce, at most 33 characters), `MIKKA_PRESENCE_SOURCE_ROOT` (checkout containing the pinned sources), and optionally `MIKKA_PRESENCE_REPORT_DIR`. `MIKKA_PRESENCE_MODE` is `baseline` or `after` (default). The runner uses the existing formal OIDC/Infisical path. Never copy secrets into these scripts, receipts or shell output.

```sh
node scripts/acceptance/issue-1212-presence/presence-production.mjs
```

The existing `alex-session.mjs` and its `production-session.mjs` decoder are required siblings. The application origin is fixed to `https://app.aspectlylabs.com/mikka`; normal session identity and build are verified before fixture work and the build is checked again after cleanup.

## After phases

1. Read existing device and token IDs. Mint a normal one-use enrollment grant, exchange it once, identify exactly one new credential by the complete before/after metadata, and register one unique device with no harnesses or computer capability. Disable scheduling before the single heartbeat.
2. Open the device gateway and keep it healthy only with WS ping/pong. Open three independent native live consumers. Their actual `LiveChannel`, `TabShare` and `PersistentReadCache` use the same owner/home/build/role namespace. Only the parent performs ordinary authenticated `agents.pollDevices` reads.
3. Wait locally until at least **92.5 seconds after the HTTP heartbeat**. Only the already existing heartbeat deadline may cause a setup read. Then count all actual application reads over **65 healthy idle seconds**; the target is zero. Setup, known-deadline and cleanup calls are excluded by explicit phase boundaries, not by subtracting arbitrary calls afterwards.
4. Close the device socket, reconnect it, then stop its pings without closing it. Each state change must deliver both owner-home keys to all three observers and update all three normal read snapshots. Natural expiry must occur at least 88 seconds after the observed last pong with the socket still OPEN (the actual server contract is 90 seconds).
5. Record every actual read and cross-tab adoption. Three old independent consumers are the comparison ceiling per state change; **one read and two adoptions is observed when achieved, not fabricated as a universal guarantee**. There is no artificial HTTP-response delay.
6. Unwatch and close all observers/device sockets, revoke only the positively identified new credential, verify its 401 rejection, remove only the disabled nonce-marked offline device, preserve original devices/tokens, and sign out. Lost registration responses reconcile by the exact nonce without replaying registration. An uncertain or ambiguous outcome is reported as incomplete cleanup instead of revoking an arbitrary token.

## Evidence limits

This is API/core/transport acceptance, not a production React render or an installed daemon. The React/SWR regression suite is separate. Internal DO alarm deletion is covered by source/Miniflare tests; the public API does not expose it, so this driver records real unwatch/close and does not claim to have queried an alarm.

The isolated offline suite validates identity boundaries, no raw credential reporting, exact fixture cleanup, lost registration responses, receipt-bound re-enrollment, actual three-worker core state/reads, rejection of support-only readiness, and three actual old consumers each reading once on a virtual minute. Its WebSocket/clock fixtures cannot stand in for production evidence. The frozen manifest records the actual final test count.

```sh
MIKKA_PRESENCE_SOURCE_ROOT=/absolute/candidate/checkout MIKKA_PRESENCE_BASELINE_SOURCE_ROOT=/absolute/old/checkout node --test scripts/acceptance/issue-1212-presence/presence.test.mjs
```

## Known low-risk duplicate read

A captured 50 ms-after-initial-read offline burst produced **2 reads + 1 adoption**, with all three states correct. Existing `minIntervalMs: 2000` and the minimum 100 ms flush delay can spread an unversioned refresh beyond a very fast completed shared read. The old device page made three independent reads. Occurrence 2 × impact 2 = **4**; follow-up issue #1543, no product change is included, per AGENTS. The raw synthetic failure evidence is preserved in `ops/latency-analysis/presence-driver-core-debug.log`. The driver now records the actual counts and requires no increase versus three old consumers; it does not delay HTTP or rerun until a 1-read sample appears.

## Baseline and the same fixture after deployment

The first frozen v1 copy remains after-only. V2 adds an independent baseline source/worker/consumer. Its source manifest pins `2f84230d24f28c6b5d1ef78669f7d6cbaf438bfc` (later commits with the exact same relevant blobs are valid). It runs actual old `LiveChannels` with the old device page's **home live subscription plus a conditional separate null-scope 60-second fallback, without TabShare**. It never substitutes new-core `presence: null` for the old client.

Run `MIKKA_PRESENCE_MODE=baseline` against the exact currently served build, with the old checkout as `MIKKA_PRESENCE_SOURCE_ROOT`. After 92.5 seconds it requires all three original fallback subscriptions to be active and the gateway-only device to be online. The 65-second measured phase must observe at least one real read per old consumer. Setup, heartbeat-deadline and post-window drain calls have separate phases. The result is `baseline_captured`, never a claim that the issue is accepted.

On a successful baseline, the driver closes all sockets and consumers, revokes its short-lived credential and verifies a real 401. It retains exactly the disabled nonce-marked device, with no installed daemon, harness or live connection. The receipt includes its IDs and original-preservation checks; it contains no raw credential.

After the Worker and client are deployed, use `MIKKA_PRESENCE_MODE=after`, the new exact source/build, the same run key, `MIKKA_PRESENCE_FIXTURE_RECEIPT` pointing to that baseline report, and `MIKKA_PRESENCE_RECEIPT_SHA256` from the trusted recorded artifact. The driver verifies the digest, exact receipt shape, marker, device, disabled state and prior revoked token. It obtains a new normal enrollment credential and registers **only that same fixture ID**. After waits past the new registration/heartbeat window again; it cannot produce a zero-read result merely from a fresh HTTP heartbeat. It records both application SHAs and idle counts, then removes the retained device and revokes the new credential. It never borrows a user device or persists a raw token between jobs.
# Baseline transport diagnostics (v3)

The baseline adapter records only fixed failure causes and bounded numeric or
boolean transport evidence: socket open/close times, core-initiated versus
cleanup-initiated close, close code and clean flag, ticket lifetime remaining at
close, and ping/pong counts and times. It never records close reasons, error
messages, frame content, URLs, tickets or credentials. Times ending in `Ms` in a
tab's `transport` object are relative to that worker's start; network timestamps
and failure `observedAtMs` use the parent's monotonic clock. They are not directly
interchangeable.

A socket error, unexpected close or reconnect still fails the finite continuous
health case. Diagnostics do not allow an interrupted connection to pass. If an
idle window fails, `live.phases` retains its completed HTTP read count with
`healthVerified: false` and `completed: false`; the top-level run remains failed.
Ordinary final cleanup is distinguished from a core-initiated close. A normal
ticket renewal is outside this shorter-than-ticket-lifetime acceptance window
and still invalidates its continuous-health claim.

The baseline diagnostics suite uses the exact pinned old `LiveChannels` under a
virtual clock and a test-only socket. It covers 180 seconds of healthy transport,
missing pong, remote close, socket error, ticket expiry and failure-window read
retention. This is local evidence, not a production transport diagnosis.

