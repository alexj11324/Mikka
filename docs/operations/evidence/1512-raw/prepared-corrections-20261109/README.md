# Checkpoint 27 — prepared corrections and fixed P0 merge evidence

Published PR #1799 remains `c0e94d594f1ecf4f5edc25904912702e61fce86b`. Checkpoint 26 retains its complete CI and original Native acceptance. This checkpoint records prepared, unpublished changes; it does not claim a production or future combined-source pass.

## Prepared source

- Installer credential scope: donor `30e54e5f9e97ed059bb9121edeeb20fa2578e286`, exact 11-file delta only. Incorporation commit `deded5b133bd11d8612c46c38464393a55165d81`, parent c0e, tree `4bd3ea710ac25e1794b2fcc2580810df9fad3ba8`. The shared action defaults to an empty explicit input. Sixteen opted-in call sites are API-read-only; the image/screenshots write callers remain anonymous for the downloader. Read-only credentials, when explicitly passed, remain visible to that install process tree; no process-isolation claim.
- Acceptance driver: two files in commit `0c35e2005fc7c92872229ef895a6ef9aa95bef44`, sole parent deded, tree `c450c8245fd1ae6815b43cb43fe6dd0fb0042b25`. All Factory requests including cleanup pin the verified Personal Workspace. Preparation/restoration scan every authorized Workspace through existing readers with a 32-scope, <200-row-per-reader, 30-second bound and repeat inventory check. Reports remain limited to the original 30-day window and explicitly non-atomic.
- Fixed P0 premerge: six candidate contents and two unchanged executable fake files combine c0e with P0 `61f359952fbc8a18de4160926632c58cba2cb432`. They are not applied to the above candidate tree and do not import all P0 changes. The P0 owner still must close the separately confirmed normal Factory default-selection issue and publish its new source. Current observed main is `76df3935c8be5af480485c52e445d389e85d8a35`.

## Verification and original failures

Driver executed with Node v24.22.2: original 37/37; initial new-test syntax failure retained separately; corrected same tests against old driver yielded 1 pass/13 failures across 14 new groups; final complete 51/51 with zero skips. These are real Node/HTTP-fixture tests, not a real P0 service or production account. Root independently checked raw outputs, exact source hashes and all 220 original assert-method lines plus the preserved existing expectations.

The original driver evidence patch serialized the terminal split-newline sentinel as real context/addition in its final test hunk. Root retained that original patch and subindex, created `candidate.corrected.patch`, and verified both directions against complete source bytes. No executable source changed and no test rerun was used to repair this evidence-format issue.

Root independently replayed both directions of all six fixed P0 content patches, checked all 41 heartbeat assertion-containing lines and the six-plus-two script changes, and matched all 24 actual route source hashes. Generated union has 243 routes/315 methods with only 22 P0 plus 2 own source hashes changed. This V8 text proof did not execute filesystem traversal, TypeScript AST checking, compilation, PG, or Native. Actual c0e CI invoked `node apps/api/scripts/generate-routes.mjs --check`; the script has no --check branch. No canonical execution claim is made for the unpublished union.

All source-tree leaves in the two unpublished incorporation commits were compared by path/mode/type/blob: installer changes exactly 11/6762 leaves; driver changes exactly 2/6762 leaves. Neither commit updated a ref or triggered CI.

## Current prepared driver and upstream gate

The first driver candidate above is superseded by the strict profile404 correction in **`f0956eb1481cee710efb714ec3635ac66b4b44ec`**, parent0c35, tree **`1431bb492e1a10b282202602e977f15dcfe52246`**. Only two driver lines change beyond the first candidate, and the entire prior51-test file is an unchanged prefix of the final63-test file. The full profile404 evidence and both the discovered finding and independent closure are retained under `driver404/`.

The exact new12 cases on oldeac produce **2PASS/10FAIL**; corrected002b driver with aab test produces **63/63, zero failures/skips/cancellations**. All five refused404 shapes fail both preflight GET and cleanup GET. Only the exact authorized `agentProfileNotFound` string proves absence. The second VM ran134989ms and is stopped/deleted/exact-GET404, with no active resource. The initial upload413 is retained as transport setup failure, never behaviorRED. Root verified original bytes, execution-source hashes and strict patch replay; actual Git apply forward/reverse proof is also included.

Upstream P0 has now published its minimal normal-session default correction at **`521db4799a4a85e1955f7dd86a1ad5ccef143cc8`**, with main76df ancestry. Its owner reports actual targeted PG17 RED11=9PASS/2FAIL and GREEN11/11 in comment6737658473; root has read that report, not those PG originals. Its current CI Source job129098715476 has a real `pnpm test:api` failure at the Nitro dev-tracing `providerStarted` assertion. The owner is investigating. Root has not re-downloaded the owner-read Source log, has requested immutable reuse, and has not labeled it flaky or fixed. No combined CI is launched while this concrete dependency is unresolved.

Root compared the two tracing/node.ts contents: the #1512 delta waits for an already-started export from the existing flush callback. The `startTracing` initialization block, global symbol and settings gate are unchanged. That delta cannot be claimed to solve the observed startup assertion. Final source publication remains after the concrete upstream cause is handled; actual production merges still follow owner order and the active writer boundaries.

Installer actual original RED/GREEN and all11 executed source bindings are now independently reviewed, with the owner nine-file package copied under `installer-30e/owner-original/`. Owner lint stdout and cloud-VM stop/delete404 originals are not in that package; no independent global resource-clear claim is made for the owner's separate environment.

## Release diagnosis

The sole assigned reader fetched E2B0415 await-web job129069965257 once. Its original log records the existing 40-minute timeout. The required latest same-SHA Web dispatch was still Uploading at that deadline and completed Verify about 5.5 seconds later; the older successful push run is not a valid fallback under existing source/tests. Per-loop HTTP/selection payloads were not logged, so they are not reconstructed. Avoid redundant same-SHA overlay-refresh while the future ordinary E2B await gate is active; no timeout/selection change or rerun was made.

## Boundaries and cleanup

The driver VM ran 217979 ms and was stopped, deleted, then verified absent by exact name/project GET with resume=false returning404. Apart from the two explicitly recorded driver VMs, this root's work here was metadata/source reading and immutable Git object creation; the separate installer owner performed its earlier targeted tests. No production login, task, model, native screenshot acceptance, or PostHog ingestion claim is made. ACME accepted cases remain0 and issue1512 remains open. The next combined publication must bind actual P0/main and collect its own required CI and original Native windows.

## Fixed P521 rebinding

`p0-521-rebinding-20261109/` preserves the complete34-path61→521 delta, new from-P521 patch, fixed source binding and direct acceptance-helper review. The six source candidate contents and two executable fake modes remain unchanged; root separately replayed all six patch sections forward and backward against the exact P521 source blobs. The old from-P061 package preimage is stale and must not be reused against P521. All14 frozen SQL template hashes match the normalizer's closed set. These are source/hash proofs, not runtime, canonical-generator, PostHog or Native acceptance.

Main moved to a219 after these fixed objects were prepared. Its finite new source intersection is handled separately; this checkpoint never implies that a future combined tree automatically contains those newer changes. The concrete upstream Nitro failure remains a required gate. No source ref, production writer or account window was acquired for this archive.

## Upstream gate update at 2026-11-09 10:39:52 UTC

The previously blocked Source gate has now completed on the owner's single retry: attempt2 Source job129108256862 is **SUCCESS**, completed2026-11-09T10:38:51Z, with `test:api`, frontend, all three typechecks, audit and cleanup steps successful. Root fetched the current run-jobs metadata directly: all22 jobs are terminal (21success and one original OIDC skip). The exact metadata head is521db4799a4a85e1955f7dd86a1ad5ccef143cc8; actual checkout SHA/tree was not read from the job log and is not inferred from head_sha.

This update supersedes the earlier temporary publication hold. Attempt1 remains a real preserved failure with unknown cause, and no flaky/fixed-cause claim is made. The next normal development-branch union can now be published for its own complete CI and original Native windows; it will contain the prepared installer/driver corrections, fixedP521 and the reviewed actual main. Production/main merge ownership and active acceptance-window rules are unchanged.
