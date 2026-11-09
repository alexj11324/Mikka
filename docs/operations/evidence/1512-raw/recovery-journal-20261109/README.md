# #1512 checkpoint 34 — bounded recovery metadata and cost provenance

## Outcome and scope

This checkpoint preserves an unmerged four-file candidate on feature f3466ba479ef51918790f521a288feaef5160e44: the acceptance driver, its existing test file, the exact artifact upload list, and one factual paragraph in docs/operations/tracing.md. It does not change product APIs, query templates, polling, credentials or acceptance criteria. No source ref, main merge, production task or new CI result is claimed here. Production accepted cases remain 0 and issue #1512 remains open.

The driver writes a metadata-only recovery snapshot before configuration changes. An acknowledged write followed by a journal failure still runs the existing guarded cleanup. Original model fields, actual implicit binding receipts and profile versions/digests remain recoverable without storing private profile definitions. CLI writes use a fixed 0600 file, fsync and atomic rename. Existing identity, ownRunsStopped, ownerIdle, value comparison, version/digest and implicit CAS protections remain.

## Original tests and independent review

The unchanged original 63 executed tests are retained byte-for-byte. The first real RED ran the old driver with 10 new behavior tests: 63 passed and 10 failed. Its stdout is complete; the original child exit code was not separately persisted and remains unknown. A real shared API-key menu shape then exposed one candidate compatibility defect; its focused counterexample failed before the narrow fix. The exact final driver104075/test2e3c/workflowebbf passed 74/74 with 0 skipped, exit0 on actual Node v24.22.1. Earlier candidate green logs remain bound to their own source. A superseded derived ledger's heading-parsing mistake is preserved and explicitly excluded from pass claims.

Root read the stored original outputs, matched every old test name once in the final output, verified all eight execution source hashes, applied and reversed the exact final patch independently, and inspected the final source changes. The independent source reviewer found the shared-identifier mismatch and verified its correction; its review does not claim test execution.

## Resource closure

One no-credential 1vCPU/2GiB Vercel sandbox ran from 14:15:04.275 to 14:27:42.881 UTC, a duration of758606ms with16360ms active CPU. It was stopped and deleted; an exact same-project/name GET with resume=false returned404. No resources remain owned by this step. No account, model API, application/database or package install was used. Actual dollar charges were not returned and are unknown.

## Cost documentation

The existing query categories already distinguish application-captured amounts, catalogue/custom API-equivalent estimates and unknown provenance. A single documentation paragraph incorrectly grouped ZeroCat with real provider cost receipts. The corrected paragraph states that Gateway amounts come from provider metadata and ZeroCat computes a configured-token-price estimate; passthrough alone proves no actual subscription cash charge. Missing costs remain unknown. No historical usage is allocated over generations and no telemetry data is changed.

## Conditional source proof

The complete leaf index and root binary Git hashing independently reproduce actual111/f346/486/765 and three possible union trees. Main765 contributes six paths; Native486 contributes eight; f346 contributes57. The only shared path between Native and f346 is package.json, where two independent test-script lines combine byte-exactly. These conditional trees do not include the recovery/doc overlay, are not created or tested whole-source releases, and expire if any pinned source changes. PR1827 remains owned and merged by its original owner.

## Limits

Local persistence and product API writes are not one atomic transaction. Lost acknowledgements or SIGKILL can leave only intent; receipts are never invented. The journal cannot bypass concurrent changes, replace missing artifact upload after runner loss, or provide a general resume engine. Its safe identifier grammar is narrower than arbitrary custom model strings. The existing finite/non-atomic owner inventory and non-CAS explicit picker/fallback boundaries remain.

See index.safe.json for all immutable blobs, byte counts and SHA-256 digests. Later source publication, whole-candidate CI, real PostHog ingestion, native PNG pixels, Replay rendering and production resource cleanup must be recorded separately.
