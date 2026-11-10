# CP59 — corrected Native early-live validation

The isolated G2 validation completed successfully at 2026-11-10 06:39:48 UTC. This checkpoint preserves the exact admitted source, controls, complete original command streams, actual results, database cleanup, and closure. It does not declare the packaged Native query budget or either production trace scenario passed.

This checkpoint was assembled at 2026-11-10 06:57:30 UTC from already frozen Git objects. The original job-log owner fetched the Actions log once and froze it before parsing. The assembler did not read Actions logs or artifact ZIP endpoints, start compute, move refs, or modify product files.

## Source and execution identity

| Item | Exact identity |
| --- | --- |
| Corrected source G2 | 0b3b0f69b901b46e9d25da7e619e04f2c09c4c9e |
| G2 tree | a9e6c067fbceb7c49143b9f5d1110971c2e535a1 |
| G2 single parent, first failed source G | ff385bfd91edcd40c3b3ee398b4b93098e5becbb |
| G tree | 7b1f2dcafc18918611938cba3716a4237d8a1f64 |
| Isolated actual run / attempt / job | 42769641000 / 1 / 129674158815 |
| Actual admission head | 4c7270ebfdf828f368cac066ffc8589d8b522d5e |
| Admission tree | 406b95198812b9c5fd46e8e60e97614067c262a7 |
| Actual runtime | Node v24.22.1, pnpm 10.34.3, Linux x64 |
| PostgreSQL | Independent run-owned postgres:17, actual server version 170011 |
| Evidence parent | dacb94026c1fab78f3fd6efb422264e1b554fd13 |
| Evidence parent tree | 7a8496ec1f6687f696aad10c0c63d002199c69b8 |
| Evidence branch | refs/heads/evidence/1512-observability |

G2 is an ordinary child of G. The four-file correction and the original failure are preserved in [CP58](../native-early-live-first-validation-20261110/README.md). Root's [integration proof](reviews/root-integration.json) records exactly four changed paths from G and 21 from the merged base M. The [final independent review](reviews/independent-final-binding.json) verifies the complete M, G2, admission and closed trees, the 43 declared source/common bindings, and 40 scoped historical reuse inputs.

The original pre-execution manifests and reviews retain their historical PENDING wording. Their bytes were not rewritten after the run; actual success is recorded by the later originals and verification files in this checkpoint.

## What actually ran

All 12 commanded processes exited 0. The 24 exact stdout/stderr streams total 70,828 bytes, and every stderr stream is empty. The assembler recomputed every archived original blob SHA, byte length and SHA-256, then reparsed the five TAP streams with the frozen strict parser. No test was skipped, cancelled or marked TODO.

| Actual G2 group | Executed | Passed | Evidence |
| --- | ---: | ---: | --- |
| Live registry regressions | 22 | 22 | [TAP](actual/streams/live-routing-regressions-stdout.log) |
| Real SessionApplication / workspace app fixture | 13 | 13 | [TAP](actual/streams/workspace-app-stdout.log) |
| Cloud startup validators with required tsx loader | 88 | 88 | [TAP](actual/streams/cloud-startup-stdout.log) |
| **Actual unit subtotal** | **123** | **123** | Three groups above |
| Real PostgreSQL cache-scope / live-hint cases | 15 | 15 | [TAP](actual/streams/cache-scope-pg-stdout.log) |
| Empty-database migration bootstrap | 2 | 2 | [TAP](actual/streams/migration-bootstrap-stdout.log) |
| Type checks | 3 commands | 3 exited 0 | Root, frontend and desktop renderer streams |
| Lint | 2 commands | 2 exited 0 | Changed root files and desktop source streams |
| Disposable E2E setup and environment bind | 2 commands | 2 exited 0 | Complete streams preserved |

[VERDICT](actual/emitted/VERDICT.json), [mechanical verification](reviews/actual-mechanical-verification.json) and [Root's actual-result review](reviews/root-actual-result-review.json) bind these results to the source. The driver records 26 source proofs: before install, before and after every command, and at the end. All 26 contain the exact G2 head/tree and the same 33 measured file blob/length/hash records. The additional 10 common blobs are bound by the manifest and source checks.

The PostgreSQL output compares the two current, same-source APIs: the cache scope and bootstrap each execute two statements. This establishes the tested no-extra-query property. It does not establish zero added response bytes relative to older source. The new membership projection and bootstrap hint have a nonzero wire cost, which remains relevant to the complete Native byte report.

## Historical results retained separately

Exactly 157 already executed PASS cases from the first G run are reused under the scoped source and dependency comparison. They were not executed again in G2. The prior overall run remains FAIL.

| Reused file / group | Prior actual PASS |
| --- | ---: |
| lib/live/channel.test.ts | 59 |
| apps/desktop/src/renderer/workspace-live.test.ts | 14 |
| lib/desktop-rpc/wire.test.ts | 5 |
| apps/desktop/scripts/renderer-startup.test.mjs | 17 |
| apps/desktop/scripts/installed-workspace.test.mjs | 3 |
| apps/frontend/scripts/auth-only-bootstrap.test.mjs | 21 |
| scripts/e2b/validate-template-subscriptions.test.mjs | 38 |
| **Historical subtotal** | **157** |

The [reuse proof](reviews/prior-157-reuse-proof.json) and [per-case index](reviews/prior-157-case-index.json) retain every original TAP start/result line and the exact source basis. The underlying first-G TAP originals remain reachable in CP58. None of the first-G App or registry results are included in the reused subtotal; both corrected files ran in full in G2.

Thus the evidence consists of 123 unit cases executed in G2 plus 157 separately justified historical PASS cases. It is not a claim that 280 unit cases ran together.

The UI/runtime policy command also belongs to first G. Its original exit 0 is retained with a narrow review of the four-file correction. The policy enumerates repository sources, so its entire input set was not byte-identical. G2 did not execute that policy command. The actual new lint commands above are distinct checks.

## Corrections and retained failures

The four corrected source copies and exact diffs are inherited from CP58's pending-G2 directory:

1. The registry tests now advance the original 100 ms debounce in all four freshness scenarios and assert that one refresh actually occurred. Their business-read expectations remain 1 / 2 / 2 / 1. The empty-array assertion avoids TypeScript never-array narrowing.
2. The App test resolves real SWR with the ESM import condition. The actual App and behavioral assertions remain unchanged.
3. The subagent hook uses the structural LiveChannelRegistry type in three erased annotations. Reversing those identifiers exactly restores G; runtime statements did not change.
4. The PG fixture asserts existing SQLSTATE 23514 personal-membership and immutable-kind rejection instead of attempting illegal setup. The original 5,971-byte test prefix, 15 registrations and query assertions remain.

The G2 controller also loads cloud startup tests with their required tsx loader. The 88 tests did not execute in G's failed child process; G2 contains their first actual result for this validation sequence. This executor change does not alter the product or test assertions.

[CP58](../native-early-live-first-validation-20261110/README.md) retains G's 100 / 98 PASS / 2 FAIL TS result, 54 / 47 PASS / 7 FAIL renderer result, startup parent failure with its 88 child cases unstarted, PG parent failure with its 12 new children unstarted, and three failed type checks. They are not relabelled by this success.

## Admission, resource cleanup and closure

Root admitted the one fixed G2 run at 06:36:25 UTC, then closed its entry at 06:37:14 UTC while that admitted run finished. The [closed manifest](controls/closed-manifest.json) has enabled=false and the [closed workflow](controls/closed-workflow.yml.txt) has an always-false job guard. Its retained active workflow identity is historical admission metadata; the actual closed tree uses the closed workflow blob.

| Closure item | Actual value |
| --- | --- |
| Closed commit | 996693d35b80a37b2e418bdde645e13368e6ae90 |
| Closed tree | 329ad540cc3f737cbbe57046ef470fb234285879 |
| Closed parent | 4c7270ebfdf828f368cac066ffc8589d8b522d5e |
| Closure run / attempt | 42769731455 / 1 |
| Closure job | 129674451777 |
| Closure conclusion | skipped |
| Runner / steps | null / [] |
| Actual closed diff | Only manifest and workflow |

The [Root closure/publication bundle](actual/root-closure-and-formal-publication.json) contains the original CAS receipts, exact times, closure run/jobs responses, two-path diff, and synthetic PR commit response. The assembler used those frozen originals without another Actions read.

[CLEANUP](actual/emitted/CLEANUP.json) records the admitted run's exact owned container, anonymous volume and network. The container was stopped and removed, its one volume removed, and its network removed, with errors=[]. Cleanup completed at 06:39:40.252 UTC. This is the actual resource result, separate from the later entry's skipped job.

## Original preservation and file map

[The original index](actual/original-index.json) names every captured original. This directory contains:

- The complete original job-log tool response and decoded job log.
- All 24 stdout/stderr files, including zero-byte streams.
- The four exact JSON payloads emitted in the log: CONTROL, DATABASE_STARTED, VERDICT and CLEANUP.
- Terminal job metadata and artifact metadata.
- Active and closed controls, Root's approval, source/count reviews, final independent binding, scoped reuse proofs and the actual-result verification.

The four emitted JSON payloads are preserved exactly as logged; they are not claimed byte-identical to members of an undownloaded artifact ZIP. Artifact 13741286841 was observed through metadata only. Its name, size, digest and expiry are retained, but no archive member was downloaded or parsed.

Source/script/workflow copies use .txt suffixes to avoid test discovery or executable workflow registration. [index.json](index.json) lists every new leaf with byte length, SHA-256 and Git blob SHA, plus exact references to inherited CP58 source and original evidence. Its own hash is intentionally outside its payload inventory; the final commit/tree handoff records it.

## Formal Native and production boundaries

Root advanced the formal PR branch to G2 at 06:40:52 UTC. The actual synthetic PR commit is 767f4f612af2c3e794031fba46d1f302ee2efab3, with parents main ab2d00a43a79d35380b4d2db9014a3792fea63ca and G2, and a tree exactly equal to G2.

The [Native contract source review](preparation/formal-native-measurement-contract.json) compares 152 measurement, build, main/preload and workflow files to H and records exact blob equality. The original read observer, RPC transport, read batch and startup sources also match. No temporary R/Q/D/C diagnostic overlay was merged. The ordinary PR CI run is 42770147727; its Native job is 129678250257. This preparation record contains metadata observed while that job was running, not a result.

The two existing hard comparisons remain:

- Full ordinary nativeLogin.queryCalls <= webLogin.queryCalls.
- First-pair startup-bundled.queryCalls <= startup-hosted.queryCalls.

The four original counter windows, same owner/workspace, complete PKCE cost, all primary-API background traffic, and unchanged five-pair launch sequence remain in force. PostgreSQL receive and send bytes must be fully reported with stage/ordinal conservation and Native-Web differences. The issue's existing instruction supplies no separate receive/send or sum byte threshold, so none is added here. Cold-start latency has no pass/fail threshold. Existing screenshot parity still requires at most 0.1% changed pixels with identical dynamic-mask geometry, in both themes.

The lifecycle fixture records query totals without directly enforcing the two SQL comparisons. A successful Actions job alone is insufficient. Historical formal H login remains 441 Native versus 331 Web, FAIL, until a complete new formal result establishes otherwise. Production trace scenarios remain 0 / 2, and issue #1512 remains open.

## Bounded supporting reviews

The PR-body review and input snapshot record that the current description keeps actual/reused results and open gates separate. The historical overhead applicability proof preserves the original measured source, the two earlier unmeasured differences and the limited probe call graph; it is not a new benchmark and does not cover the new Native early connection.

The [PostHog configuration readback](preparation/posthog-existing-alert-safe-projection.json) is an allowlisted metadata projection, not an unmodified original response. It records a 06:53:06 UTC read of an existing insight and alert, with the live SQL exactly matching G2 source. Private user fields and query results are excluded. No query, simulation, Scout, write or production trace test occurred. This only confirms existing configuration parity.

No additional source, runtime or production claims are made by this checkpoint.
