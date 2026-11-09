# Native 025118 original acceptance evidence

## Exact source and original execution

CI **42573554116** completed Native job **129018381654** and UI policy (strict) job **129023603140** successfully, without rerun or cancellation. Native completed at 2026-11-09T06:54:34Z; UI strict completed at 06:54:45Z.

Native's own checkout log at 06:38:39.1499480Z identifies **0b2b8a5296fa9ccda2a7f9921c26c2ff9b93ba02**. Its exact Git commit API tree is **6da320a6f476624ba2e61ca7a1f5c704a3fdae25**, identical to public head **025118ed953ab80803ac3ba9548c3a309c5c69b4**. Parents are main **927260894305e066e15a4ad50114abce433e6001** and that head. Every applicable original artifact revision and renderer revision agrees. This does not validate a later combined source.

The workflow, lifecycle driver, query-window driver and acceptance entry point are byte-identical to prior actual f8864eb83055504ac445e07e8d94a0e8eabedee9. The complete login, original first startup pair and all original boundaries remain unchanged.

## Complete original SQL budgets

| Original window | SQL queries | Original phase decomposition |
| --- | ---: | --- |
| Native login | 361 | 19 email + 13 complete PKCE/automatic renderer + 329 workspace selection to usable |
| Web login | 412 | 19 email + 0 navigation to DOM content loaded + 393 workspace selection to usable |
| Bundled first startup, pair 1 | 179 | Original launch to usable |
| Hosted first startup, pair 1 | 201 | Original launch to usable |

Both original budgets pass: **361 <= 412** and **179 <= 201**. No background, denied request, authentication or PKCE query was subtracted, moved or sampled. All 12 checkpoints, 8 segment deltas and 4 total deltas reconcile field by field. In all 24 records, 17 operation buckets sum to queryCalls and 78 source buckets sum to the nested unattributed bucket. Counter unknownReadings remains 0.

All **1,153** query ordinals in the four original windows are present exactly once with matching scope buckets; overflow is false. Request/statement diagnostics remain **incomplete**, with original unknown counts retained:

| Window | Unknown context | Unknown statement |
| --- | ---: | ---: |
| Native login | 91 | 118 |
| Web login | 87 | 139 |
| Bundled startup | 53 | 70 |
| Hosted startup | 48 | 79 |

## Actual RPC actions and boundary crossings

Native login has **14 physical / 36 logical starts**, while Web has **35 / 35**. Native has 13 physical and 35 logical completions inside the window; one issues.syncIssueList request crosses the original end and is subsequently observed with HTTP 200. It is retained explicitly, not subtracted or relabeled as an absent completion.

First startup has bundled **6 physical / 19 logical starts** and hosted **18 / 18**. Hosted has one coordinator.syncCoordinatorChat request crossing the original end and subsequently returning 200. There are no unobserved or unmatched completions in the final receipts.

Compared with prior actual f886, Native logical starts change from 41 to 36: coordinator.pollBotChatSummaries, coordinator.syncCoordinatorChat, task-runs.pollTaskRuns and task-runs.syncThreadList each change from 4 to 3; the prior null-action HTTP 401 record is absent in this run. Web actions are unchanged; bundled logical starts remain 19; hosted task-runs.pollTaskRuns changes from 2 to 1. The full action/segment/status comparison is preserved. This is not a fixed-action-count experiment and these differences are not attributed solely to a source change.

## Functional checks, baseline state and cleanup

Lifecycle 8 checks and smoke 10 checks pass. Parity passes 100 captures across 50 required screens and two themes, with no page errors. Three independent packaged crypto processes pass and use the same immutable signed package. Five alternating cold-start pairs report bundled median 1970.81 ms and hosted median 2144.56 ms; SQL acceptance continues to use the original first pair.

The following original booleans are deliberately separate:

| Original report | workspaceNameCleanup.restored | Owner/peer sealed baseline before | Owner/peer sealed baseline after |
| --- | --- | --- | --- |
| lifecycle | false | false / false | true / true |
| smoke | false | true / true | true / true |
| parity | true | See original workspace receipt | true / true |

All recorded cleanup stages pass, native resources report cleaned, and lifecycle/smoke leases report released. A passing final sealed baseline does not turn either false restored field into true. The original five JSON streams remain unchanged.

The observed installed daemon is **0.0.551**, protocol **3**, revision **facb389f6cc06c453e9135bb60ada1b0f302e0d9** in bundled, hosted and parity environments. This is an original service observation, not inferred from the application revision.

## Byte preservation, privacy screening and resources

Native ZIP artifact **13654599951** is **14649873 bytes**, SHA256 **da4219f1ae87ea0ada64c38e51e14c198d0d8bbcc253d12d228798da287dc9c0**. Package ZIP artifact **13655540757** is **1595 bytes**, SHA256 **58b95d7d87ffec04c29d339c37a7ed911c42d4d0ec6ad611fd18e3bf5f3292c8**. Both match the API digest and byte count, and both pass ZIP integrity checking. The manifest retains all **308 + 2** extracted paths with bytes, SHA256 and Git blob hash.

Each owned job log and each necessary GitHub ZIP was fetched once. Existing file references were materialized once, without refreshing or downloading prior artifacts. Both original log strings retain their original UTF-8 BOM and ANSI bytes. Public files were screened for credential and email shapes, with findings reported by category/location rather than values. Raw ZIPs, signed URLs and private platform/tool metadata are excluded from this public payload; their official artifact identities and integrity evidence remain recorded.

One restricted, nonpersistent 1-vCPU/2-GiB Vercel VM only decoded original artifacts. All public bytes were recovered to RAM through a deterministic gzip bundle and verified before the VM was stopped. It stopped at **2026-11-09T06:59:28.913Z**, after **219102 ms** elapsed and **8798 ms** active CPU, with **14946886 B ingress / 361965 B egress**. Deletion succeeded and the exact same named sandbox with resume=false returned **404 not_found**. There was no timeout extension, application rerun, browser/model invocation or new CI. Resource cost was not calculated.

This package records original CI Native acceptance. It does **not** assert production/ACME/PostHog backend trace acceptance, actual Replay playback, or closure of issue #1512. Earlier failed and passed runs remain separate evidence.
