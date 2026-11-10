# Formal 5852 attempt 1 — CI and owned original evidence

This package binds head `5852aa8832c07fdeef43665dd5e156ce5516e3ea`, actual checkout `9faa0e581b370237fe541ce3087c28a334ddb798`, tree `42d33eb7faf77d7049607523599de9374e065660`, and ordered checkout parents [60401d31fb33b7f272cb0262df58d3d2008280b4, 5852aa8832c07fdeef43665dd5e156ce5516e3ea]. It does not transfer results to a subsequent candidate.

## Result

- All 12 exact-head workflow runs are terminal: 10 success and 2 failure.
- All 41 unique Actions jobs are terminal: 34 success, 3 failure, 4 skipped.
- Complete check pagination returns 42 checks: all 41 job IDs match the exact run/suite/head/attempt, plus one successful GitGuardian check.
- Of 19 suites, six third-party suites remain queued with no checks. They are unknown, not passed.
- Main CI fails on PG shard 4 and its database-summary propagation. The separate Local device Node 22 workflow fails on the Apple Silicon Node 22 reconnect.
- UI strict succeeds with seven EXPECT=true/results=success. It does not aggregate the database result or the separate Local Node22 workflow and does not erase their failures.
- Root reports the Native owner's original numeric result as full login 448 > 438 (+10), FIRST 116 <= 224. This reader did not read or recalculate Native logs/JSON/ZIPs; its final index is attached separately by the owner. Job success alone is not a numeric-budget pass.
- Production remains 0/2. This is not a merge-ready or issue-completion conclusion.

## Executed coverage

The Source log has seven Node test summaries totaling 361 pass, 0 fail, 0 skip (63 are migrations). Daemon Vitest has 1,591 passed tests and 2 skipped tests, with 140 passed files and 1 skipped empty file; the subsequent package test is separately preserved.

Core executed 58 unique selected Nx targets and Integration 29 unique targets, with exact command/footer-set equality and cache disabled. The complete merged `lib/personal-policy.test.ts` is preserved as blob 04c5ed8d4a2f724b6999609dbb9732c53c10ced1. All 24 runtime test titles occur once and pass, including both fresh Organization deny/approval counterexamples. Source-only totals do not substitute for these actual Core executions.

The early source-binding proof intentionally retains its historical 'runtime not yet observed' wording. The later unit-execution proof supplies the completed 24/24 evidence.

## Mac failure and cleanup boundary

Initial installation, enrollment, registration and online state succeeded. Reconnect reached `restartLocal`, then `launchctl bootstrap` failed with I/O error 5 and installer exit 1; the assertion at local-installer-macos.ts:139 observed failed rather than online. No deeper OS cause is inferred. The fixture gateway 404 explicitly entered long-poll fallback and is not assigned as the bootstrap failure.

A daemon-stopped event is observed. The fixture's finally defines best-effort bootout, server closure and fixture removal, but there is no independent final process inventory, successful bootout receipt or post-removal read. Those cleanup facts remain unknown, not silently promoted to confirmed absence.

## Reading boundaries

This lane read exactly six terminal original job logs once each: Source, Core, Integration, Daemon, Local Node22 Mac22, and UI strict. Each unchanged plain log and full tool wrapper is preserved with byte count, SHA-256 and Git blob verification/readback. No Actions original was re-fetched.

PG originals belong to backfill_pg_runner (index a82455dfbc8aeabec77a78bb9f7e99e87086cc36). Native originals belong to native_diag_runner and are separately indexed. This lane read neither owner's original logs nor ZIPs, and did not read Changes or other workflow originals. The check/suite metadata is a closed projection with full IDs, URLs, step states, attempt attribution and pagination counts.

No reruns, cancellation, source edits, ref writes, CI dispatches, VM creation or model calls were performed by this reader. All artifact objects here are unreferenced Git blobs for Root's later archive; no evidence branch was updated.

## Files

The index lists 19 payload files, including this README, plus index.json itself (20 files total). Payload hashes cover their exact original bytes; the index cannot list its own self-referential hash, which is supplied in the delivery receipt.
