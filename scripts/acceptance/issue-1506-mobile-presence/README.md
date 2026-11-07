# Mobile presence API setup adapter

Prepared only; **not run in production**. This is API/core acceptance, not an installed phone or a rendered mobile UI. The actual hook/client request-count tests are in the frozen product patch.

## Integration boundary

Call `checkMobilePresenceSetup` only in the existing **after** presence run, while its disabled owned fixture is gateway-online and before `consumers.quiet(65_000)` starts. Prefer immediately after `openPresenceConsumers` becomes ready, then retain the existing 92.5-second heartbeat wait and `consumers.settle()` before idle. The adapter does not alter those boundaries.

Pass the existing authenticated session, exact deployed application SHA, fixture, initial owned-device response, gateway origin and normal home live-ticket response. Capture one of the existing ticket responses in memory; **do not request another ticket or home read**. The integrated `presence-production.mjs` installs that wrapper only for `mode === 'after'`. It saves a promise before yielding so three simultaneous normal ticket requests still clone exactly one response, returns each original response unconsumed, then clears the captured ticket after the adapter or in the parent's `finally`. A bad/missing clone fails the setup without fetching another ticket. Baseline consumers receive their original session object unchanged.

The adapter adds **exactly three finite ordinary thread GETs in setup**: valid home proof, absent proof, and a scope-tampered proof whose signature is deliberately left unchanged. These reads belong in `report.mobileAPISetup.setupThreadReads` and the parent's total authenticated request count; they are outside the web idle window. The wrong-scope case is malformed routing metadata, not an attempt to borrow another account or acquire access to a guessed workspace. There are no new product-triggered reads, login calls, home/ticket requests, device mutations, model calls, retries or polling.

## Validation and evidence

`source-hashes.json` pins all 11 changed runtime files and five existing dependencies from the explicitly supplied application commit `efb95d951ddbeca1af04bc80d011ccbc2a9f0188`, tree `fd7fb13f41c5a87df865f539d498b32e3a4fb83b`. The loader requires both this exact Git identity and all 16 blob hashes, verified directly against Git objects; this disabled repin output is not production deployment evidence. `source.mjs` transforms the actual product `PresenceScopeCache`, `ApiCache` and closed presence-payload parser; no client algorithm is reimplemented.

The adapter checks the existing normal session's build, owner, owned disabled fixture and real home. The real client proof holder must accept the existing ticket's home receipt. Positive response owner/home, full returned-device set, each device's shown online state and fixture-online state must match the grant payload. Grant expiry must be no later than the home proof and live ticket; at least one minute of original ticket life is required before beginning. Absent/tampered proofs must return ordinary successful data with `live.workspaceId === null` and `live.presence === null`, preserving the same device set.

The adapter has no gateway signing key. It validates the actual server's response and payload bounds; it explicitly records `signatureVerifiedLocally: false` and `workerAcknowledgementChecked: false`. The existing web/native transport acceptance and source/Worker tests establish those separate properties. Do not turn this API-only check into a claim that a mobile watch was acknowledged or that a phone screen rendered.

Reports contain fixed booleans, counts, durations, source hashes and short owner/home/device-set digests. They omit cookies, ticket protocols, signed proofs, raw device IDs/names, thread records and all history content. Errors use closed `presence_mobile_*` codes accepted by the parent driver's existing code allowlist. The source temporary directory and proof cache are always cleared.

## Offline verification

```sh
MIKKA_MOBILE_PRESENCE_SOURCE_ROOT=/absolute/efb95d9-checkout \
  node --test scripts/acceptance/issue-1506-mobile-presence/mobile-api-setup.test.mjs
```

The offline transport uses the actual compiled server signing/verifying helpers with a local fixture key. It proves exact request counts, rejected context before network, rejected wrong/expired receipt without retries, device-set validation, source pinning and white-list-only output. It is not production evidence. The adapter has no automatic CLI execution branch; importing it performs no application request.

The integrated offline suite passed 27/27: the 16 original v3 checks, four new lifecycle/real-worker integration checks, five adapter checks and two exact-source-identity checks. The real-worker integration intentionally stops at the pre-idle boundary and verifies full cleanup; it does not label its virtual transport as a production result. A separate three-case RED log proves the original v3 had no mobile setup or failure gate.
