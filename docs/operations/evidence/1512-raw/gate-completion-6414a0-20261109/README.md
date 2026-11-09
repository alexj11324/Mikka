# CP40 — 6414 functional CI complete; original Native SQL budgets RED

Observed: 2026-11-09 18:18:53 UTC. Issue #1512 / PR #1799 remain open. Production acceptance: **0 of 2**.

## Fixed source

Feature head `6414a08ddb4a92962bc82e9e427c391d645cacb2`; tree `05b40c13c233d7f3cef989011705cf624b27c507`.
Actual CI checkout `576c903cd6ede14520a79111d2b71154968ad910`, ordered parents [`5ba1f9e2359ce714d83cd16fc040f2567c40a6d0`, feature head], with the same tree.
Main CI `42663994959`, attempt 1; Native job `129327506300`.
This checkpoint follows CP39 `bfa05daedfdbcd65433a5cabbd3e415c9707bb16` without rewriting its earlier pending status.

## Actual verdict

Nine workflows completed successfully. The 38 unique Actions jobs are 31 success and 7 original conditional skips. Including the external GitGuardian check, 39 checks are 32 success and 7 skips. Root independently matched every Actions job to its check and suite: no coverage or conclusion discrepancies.

Core actually ran 57 selected targets, with the 74 production-driver test names each passing once. Source printed 361/361 passing tests. Integration completed all 29 original targets; its team-import subprocess completed in 8182.342052 ms within the unchanged 15000 ms limit. PR E2B unit/syntax checks include 34 official-file tests; its six release jobs are conditional skips, not a production release. Strict required all seven expected gate results and observed success. All runs were attempt 1, without reruns or changed deadlines.

These functional gates do not enforce the two manual Native SQL budgets required by #1512. Both failed:

| Original window | Native | Web / Hosted | Verdict |
| --- | ---: | ---: | --- |
| Full auth/email/PKCE/navigation/background | 433 = 19 + 15 + 399 | 431 = 19 + 0 + 412 | RED: +2 |
| FIRST startup, original pair 1 | 209 | 147 | RED: +62 |

Root independently recomputed the original five JSON files: 24 records, 12 checkpoints, 8 segments, 2280 bucket cells and 1220 ordinal rows. There are no arithmetic or conservation errors; the verifier's exactly two errors are the two comparisons above. Every shared result field agrees with the assigned reader's independent verification.

All unknown and background traffic remains counted. The original checkpoint boundaries and original first pair remain unchanged. Hosted FIRST has four requests crossing its end; their later completion does not authorize extending the window or adding later SQL. Native FIRST decreased from 213 to 209; Hosted decreased from 220 to 147. The +62 comparison is not a claim that Native added 62 queries.

## Differential findings and limits

The previous 6cc full Native count was 425 = 19 + 15 + 391. The current +8 is entirely in the workspace segment; PKCE stayed 15. Five increments have known statement structures: fresh workspace membership choices +2, subscription policy +1, revision reads +2. The revision arguments were not exported, so a matching structural fingerprint does not prove duplicate refs. Three extra issue reads remain unknown.

The former five-action batch shared one membership query. In this run summaries and chat became independent requests, each correctly performing a fresh authorization read. The independent chat also queried the same workspace subscription policy twice within one normal read, whereas the batch context had shared it once. Narrow request-local improvements are candidates; no cross-request permission caching is justified.

The source analysis identifies a separate possible plan for list revisions in an already-authorized Team. Personal authorization is not interchangeable with Team authorization. Arbitrary bot-chat entities must not be prefetched. No candidate patch or test execution is included in this checkpoint.

Transport review proves result-delivery head-of-line waiting, not serial server execution. In the first batch, early items wait up to 145 ms for the complete envelope; chat itself finishes last. Existing whole-batch 401, identity scope and actual-response proof contracts prevent treating incremental streaming as a trivial change. The evidence contains no runtime action arguments or actual bot URL, so a default-to-selected-bot hypothesis is not attributed to this run.

The installed native daemon changed from 0.0.562 / 111a… to 0.0.564 / 8db16095…; the app six-file union is not the sole controlled variable. Its version does not prove the cloud worker version.

## Cleanup and visual boundary

The lifecycle workspace-name receipt says phase=unchanged and restored=false. Its sealed owner/peer baseline starts false and ends true. Smoke and parity restored=true are separate observations and do not overwrite lifecycle's values.

Original parity metrics cover 100 screens and 129600000 compared pixels; root has not viewed their PNG pixels. Three independent Keychain processes and package checks passed. Median cold durations are Native 3167.33 ms and Hosted 3183.79 ms; the marginal difference cannot offset SQL budget failure.

The sole artifact-extraction VM was stopped and deleted, with exact resume=false GET returning 404. There are no remaining manually created resources for this step. Actual USD cost was not returned and remains unknown.

## Evidence handling

Every original job log and ZIP had one assigned original reader. Root and other reviewers reused immutable Git blobs. Original decoded UTF-8 logs retain warnings, masking, ANSI and any BOM; derived parsing never replaces originals. The original artifact ZIPs were each downloaded once. Native files, manifests, hashes, metadata, RPC ledgers, privacy scans and cleanup receipts are preserved.

The top index records exact byte counts, SHA-256 and Git blob IDs. Source and Native reader indexes retain their original scope limitations. Root verification, differential diagnosis and transport analysis are separately named. This evidence archive does not modify product code, CI, measurement harnesses, windows, thresholds or provider policy. It does not certify runtime publication, actual PostHog ingestion, native PostHog PNG pixels, Replay playback or either official production model case.
