# Native evidence: c0e94 / CI 42590712093

## Fixed source and scope

The Apple Silicon job 129074068433 completed successfully at 2026-11-09T09:31:15Z. Its own unmodified log records checkout `9d8aab6986e474ea2df8f62091d97dc5aa992420`. The exact commit API reports tree `3e09885ffb34a9c04fc8a7ac5b8b88e3415f7325`, with parents `0415e5e0aabcd91b51e99ee73c41f6b6abb75ce6` and published head `c0e94d594f1ecf4f5edc25904912702e61fce86b`. The tree is identical to the candidate head tree. Lifecycle, query-source, renderer, package and parity revisions agree.

This package records CI Native acceptance. It does not claim production acceptance, observed PostHog traces/replays, or the status of other CI jobs. No source, ref, budget or measurement window was changed while reading this run.

## Original measurements

| Original window | SQL calls | Physical / logical RPC starts |
| --- | ---: | ---: |
| Full Native login | 398 = 19 + 15 + 364 | 18 / 41 |
| Full Web login | 412 = 19 + 0 + 393 | 35 / 35 |
| First startup pair: bundled Native | 181 | 8 / 19 |
| First startup pair: hosted | 206 | 19 / 19 |

Both SQL comparisons pass on this original run. The login windows retain ordinary email authentication, real Native PKCE, navigation and all concurrent primary API background work. The startup comparison uses pair 1 from the unchanged alternating five-pair sequence. No later pair replaces it, no query is subtracted, and no requests are removed at a boundary.

The first Native window is 09:29:40.745Z–09:29:43.949Z (3,204 ms); the first hosted window is 09:29:44.745Z–09:29:47.927Z (3,182 ms). Native has one `task-runs.pollTaskRuns` request crossing the end: physical starts/completions 8/7 and logical starts/completions 19/18. Completion is observed after the boundary and remains in the RPC receipts.

The preceding different-source run remains 394/412 full-login and 183/139 first-pair (first-pair RED). Current Native and hosted first-pair actions each include two calls for the major live lists; these counts do not prove that a source change eliminated all earlier second reads. `budget-and-first-pair.safe.json` reports observed differences without assigning unsupported causality.

## Arithmetic and attribution

All 24 records (12 checkpoints, 8 segments and 4 totals) reconcile. Every record's 17 operation buckets sum to its query-call count; all 78 source buckets sum to the unattributed operation bucket. Segment deltas, total deltas, original boundaries and globally monotonic counters reconcile.

All 1,197 captured query ordinals are continuous within their original windows, with exact scope-to-bucket conservation. Capture overflow is false; query-protocol unknown readings are {"webLogin":0,"nativeLogin":0,"startup-bundled":0,"startup-hosted":0}. Diagnostic status remains `incomplete`; unknown context/statement counts are preserved:

| Window | Unknown context | Unknown statement shape |
| --- | ---: | ---: |
| Native login | 94 | 135 |
| Web login | 87 | 139 |
| First Native startup | 48 | 73 |
| First hosted startup | 48 | 82 |

No raw SQL text or bound values are added. Physical and logical RPC actions, segments, boundary crossings and status counts are in `rpc-diagnostics.safe.json` and the original lifecycle JSON.

## Cleanup and package identity

The original cleanup fields remain distinct:

- Lifecycle: `workspaceNameCleanup.restored=false`; owner and peer observation baselines before are false/false, and after are true/true.
- Smoke: `workspaceNameCleanup.restored=false`; owner and peer baselines before and after are true/true.
- Parity: `workspaceNameCleanup.restored=true`; final owner/peer sealed-baseline matches are true.
- Native cleanup reports cleaned, the six recorded cleanup stages pass, and account observations end released. These facts do not change either false workspace-name restoration field.

Package integrity, strict/deep signature checks and three independent Keychain processes pass. Both loading modes observe installed daemon 0.0.551, protocol 3, installed revision `facb389f6cc06c453e9135bb60ada1b0f302e0d9`; that installed revision is not inferred from the application revision. Parity has 100 passed screen entries, and pageErrors is empty.

## Original-byte and publication boundary

Five JSON files under `original/` are byte-for-byte copies of the source artifacts. The manifest indexes all 308 Native and 2 package member paths with byte count, SHA-256 and Git blob SHA-1. The full ZIPs and screenshot contents are not rehosted in this public payload.

- Native artifact 13661983991: 14,613,678 bytes; SHA-256 `4ed58db955b96a6008fb841ac0d8b5f831285744714c4337dd244f46a8b9f43a`.
- Package artifact 13661654841: 1,599 bytes; SHA-256 `504be051626e9379911892549d076aad7fc734b0f41194a9fd989eb46092c447`.
- Each artifact download tool was called once, each returned reference was materialized once, and API bytes/digests plus ZIP integrity passed. No reference refresh was needed.
- The sole Native log preserves its original UTF-8 BOM and ANSI bytes. Credential-shape/email scanning found no matches in the public payload; scan scope and hashes are retained. No SAS URL, auth secret or private platform response is published.

The source-contract receipt captures a static pre-terminal comparison; actual execution/source binding is in `source-and-worker.safe.json`. The verification scripts operate on already-produced originals and do not execute Native or models.

## Bounded extraction resource

One nonpersistent 1-vCPU/2-GiB Linux sandbox was used solely to extract and verify existing artifacts. All selected public payload bytes were recovered and hash-verified before shutdown. It stopped at 09:35:00.590Z, was deleted, and an exact named GET with resume=false returned 404/not_found. Actual duration was 168,192 ms, active CPU 5,200 ms, ingress 14,924,015 bytes and egress 394,975 bytes. No extension or zero-cost claim is made; there are no active owned resources.
