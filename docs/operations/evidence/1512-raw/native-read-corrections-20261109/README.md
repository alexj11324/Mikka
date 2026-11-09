# CP41 — bounded Native read corrections and actual RED/GREEN

Observed: 2026-11-09 18:51:27 UTC. Issue #1512 remains open; production acceptance is 0/2.

This checkpoint freezes three narrow corrections developed from CP40's genuine budget failures. Base source is head 6414a08ddb4a92962bc82e9e427c391d645cacb2, tree 05b40c13c233d7f3cef989011705cf624b27c507. The prepared ten-file source commit is e7dfd5ae919fe9feba69b2f3ce2ad9558c9ab818 / tree 820a7f6105019ddd18de2ad1961332337904923f, with sole parent6414. It was created without moving the feature ref; later publication is a separate event.

## Changes

A opens a policy observation only around the two foreground chat model-read calls. It shares one workspace policy result within that read, keyed by actual executor and workspace, and clears it in finally. Ordinary authorization, credential reads, execution/wake and after/cron/workflow paths remain fresh. It is not claimed to reduce the previous FIRST chat calls that already had a batch scope.

B introduces a separate revision plan for an already-authorized effective workspace. The plan is closed to issue_list/task_run_list/thread_list for prepared actions; the original Personal-home path is retained. Reads still take conservative revisions before data and return only their own requested keys. Actual executor keys prevent a request proxy from borrowing another database's observation. Missing counters and failures remain missing proof.

C adds teams.listTeams and team-relations.listProjectTeams to the existing complete-snapshot dispatch-proof path. Both are full arrays and workspace_settings remains unversioned; no revision is invented. Existing response proof, SWR commit, scope checks and newer-push re-reads remain required. snapshotReadFetcher returns the original action function, so no promise wrapper or additional Web request is introduced.

The exact final ten files, initial B test versions, strict server patches, independently reviewed source boundaries and test dependency closure are included. All product files keep mode100644. There is no Native measurement, window, FIRST pair, counter, deadline or threshold change.

## Actual verification

Actual executable: Node v24.22.1 in the pinned universal image. The platform session metadata says node22; the executable's reported version is retained separately. Direct dependencies were pinned to the repository lock, including tsx4.23.15, pg8.23.1, React/React-DOM19.3.1 and SWR2.5.1. The isolated npm lock is archived; this is not a claim that the entire canonical CI environment was reproduced.

| Case | Fixed old source with new tests | Candidate |
| --- | --- | --- |
| A, complete personal-policy file | 22 tests:17 pass/5 assertion failures | 22/22 pass |
| B, initial context file | 22 tests:19 pass/3 assertion failures; original16 pass | 22/22 pass |
| B, added independent fixed-counter case | 1 actual assertion failure:3 SQL reads versus expected1, after all3 results matched | Included in final23/23 pass |
| C, seven new React/SWR/LiveChannel/Native scenarios | 7 tests:2 pass/5 assertion failures | 7/7 pass |

No skipped tests or missing-import/export failures produced these RED results. The original test bodies were preserved. A retains each credential read; B returns identical fixed-counter results with one query; C's before-ready dispatch and newer unversioned push remain required re-reads in both old and new implementations. Source and test bytes were verified on upload and all recovered outputs were reconstructed and checked by exact SHA-256.

The initial B RED first failed on its expected conservative revision value before reaching a query-count assertion. It is not mislabeled as an observed3-query run. The separate fixed-counter case provides that direct3-versus1 evidence.

## Explicit remaining verification

The new real PostgreSQL test was not executed in this isolated environment. It must run in the fixed-source canonical CI.

An additional run of the entire existing Live test file was launched at18:39:33.979 UTC. At18:41:29 its completion record did not exist. No terminal original was recovered before the VM's absolute18:42:10 expiry. Subsequent command metadata still had exitCode=null, while its log endpoint returned410 sandbox_stopped. Its outcome is **unknown**, not PASS or FAIL. It is not counted in the table, and the environment was not extended or recreated to obtain a green result. The canonical CI must verify that complete file, including its final404 capability fallback.

Most importantly, the actual CP40 budgets are still RED: fullNative433>Web431 and originalFIRST209>Hosted147. There is no prediction that these helper/UI improvements will make the next full original windows pass. Runtime publication, PostHog trace/log/generation reconciliation, native PostHog PNG viewing, Replay playback and both official model cases remain separate production requirements.

## Resources and originals

One1-vCPU/2GiB VM, fixed900000ms absolute lifetime, persistent=false, no exposed routes, no account/model/DB credentials, registry.npmjs.org-only egress. The platform stopped it at its original deadline; the subsequent stop returned already-stopped status. Duration900306ms, activeCPU44224ms, ingress163363587B, egress930052B. It was deleted and exact project/name resume=false GET returned404. Remaining resources0. Actual USD cost is unknown.

The recovered A/B/C original logs, source manifests, dependency locks and receipts were all saved before expiry. Their bytes are preserved; the first B output used Node's spec reporter despite its temporary .tap filename, and is correctly archived as .original.log. Later outputs use explicit TAP. The missing complete-Live original is explicitly excluded. No GitHub job log or ZIP was re-downloaded for this checkpoint.
