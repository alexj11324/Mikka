# Native 1ffa original evidence: first startup SQL budget RED

## Result and exact source

**Original first-pair SQL acceptance fails: bundled 183 > hosted 139.** Complete login passes: Native 394 <= Web 412. The successful Native workflow job is not an issue #1512 SQL acceptance pass.

CI **42580506632** ran Native job **129040252138** to natural success at 2026-11-09T07:56:45Z. UI policy (strict), job **129044355119**, naturally failed at 07:56:56Z. Its own original log records EXPECT_IMAGE=true and IMAGE=failure while selected Core, Integration, Source, Daemon, Desktop and Analytics results are success. The failed aggregate step exits 1. No whole-CI success is asserted, and no image job log was downloaded by this reader.

Native's own checkout log at 07:45:01.6915360Z identifies **c3b547d0e4d20692643fc95a5194b7ee8cf7f5c0**. Exact Git commit API tree **bc4d584fa651385886e79dc6359b1b43324425d1** equals public head **1ffa581f16319381054e0636ae41e6292719a1fe**. Parents are main **89eae89e9e79422e0a8b4b1346aa1c7fb6470016** and that head. All applicable original artifact and renderer revisions agree.

Four original measurement contract files are byte-identical to previous actual 0b2b8a5296fa9ccda2a7f9921c26c2ff9b93ba02: desktop workflow, lifecycle driver, query-window driver and acceptance entry point. New main application/parity changes remain part of this new source; prior Native results are not substituted.

## Unchanged original windows

| Original window | SQL queries | Original phases |
| --- | ---: | --- |
| Native full login | 394 | 19 email + 13 complete PKCE/automatic renderer + 362 workspace selection to usable |
| Web full login | 412 | 19 email + 0 navigation to DOM content loaded + 393 workspace selection to usable |
| Bundled startup, pair 1 | 183 | Original launch to usable |
| Hosted startup, pair 1 | 139 | Original launch to usable |

The first pair remains the acceptance sample. No second pair, median, changed duration, extra wait, excluded background work or rerun replaces its RED result. All original email, auth, PKCE, navigation and concurrent background query traffic is retained.

All 12 checkpoints, 8 segment deltas and 4 total deltas reconcile field by field. In all 24 records, 17 operation buckets sum to queryCalls and 78 source buckets sum to the nested unattributed bucket. Counter unknownReadings is 0. All **1,128** in-window query ordinals are present exactly once and match scope buckets; no diagnostic overflow occurred.

The verifier's verified=true refers to integrity and conservation. Its arithmetic output and budget-verdict.safe.json explicitly retain firstPairBudgetPassed=false and nativeSqlAcceptancePassed=false.

## Same-pair difference and actual requests

Bundled has **44 more SQL queries**, despite the original query window being **1590 ms** versus hosted **1925 ms**. These times are observations, not a reason to resize either window.

Native first startup has **7 physical / 18 logical RPC starts**; hosted has **12 / 12**. All complete inside their respective original window, with no boundary crossings or unobserved completions. Six actions occur twice in Native and once in hosted: bots.pollBots, coordinator.pollBotChatSummaries, coordinator.syncCoordinatorChat, issues.syncIssueList, team-relations.listProjectTeams and teams.listTeams. task-runs.syncThreadList occurs twice on each side; the other observed logical actions occur once on each side.

Operation deltas (Native minus hosted) are auth -2, desktop RPC +35, web RPC -31, workspace +5, coordinator poll +19, summaries +1, threads poll -2, issues poll +4, projects -1 and unattributed +16. The unattributed source difference is conversations +5, approved-writes +10 and pending-actions +1. Every zero and nonzero bucket, original timestamp, RPC action/status and known query-context projection is preserved in first-pair-difference.safe.json. Unknown contexts are never reassigned from a scope label or completion timing.

These differences do not by themselves establish duplicate business execution or a causal explanation. Full login has Native **16 physical / 40 logical starts** versus Web **35 / 35**, all completed inside the original windows. The comparison against the preceding actual 025 run is preserved separately.

Diagnostics remain **incomplete** and retain original unknowns:

| Window | Unknown context | Unknown statement |
| --- | ---: | ---: |
| Native login | 91 | 134 |
| Web login | 87 | 139 |
| Bundled startup | 53 | 73 |
| Hosted startup | 37 | 55 |

## Functional checks and distinct cleanup fields

Lifecycle 8 checks, smoke 10 checks, 100 parity captures across 50 screens and two themes, and three independent packaged crypto processes pass. No page errors are reported. Crypto uses one immutable signed package.

Five alternating cold-start pairs report bundled median 1793.22 ms and hosted median 1923.5 ms. Those timing medians do not replace first-pair SQL acceptance.

| Original report | workspaceNameCleanup.restored | Owner/peer baseline before | Owner/peer baseline after |
| --- | --- | --- | --- |
| lifecycle | false | false / false | true / true |
| smoke | false | true / true | true / true |
| parity | true | See original workspace receipt | true / true |

All recorded cleanup stages pass, native resources report cleaned, and lifecycle/smoke leases report released. Final baseline success does not change either restored=false field. Five original JSON byte streams remain unmodified.

The observed installed daemon is **0.0.551**, protocol **3**, revision **facb389f6cc06c453e9135bb60ada1b0f302e0d9**, in bundled, hosted and parity environments. Installed source is an original observation rather than an inference from the application revision.

## Preservation, reads and resource termination

Native ZIP **13657811860**: **14614350 B**, SHA256 **f4ca5fb4cdef086c098c36dc05a37c04d887d775b0800cf9a665a21897ef18b5**.
Package ZIP **13657866747**: **1594 B**, SHA256 **5e5922c34d756870641a6de10b2f3e6a37cb859e102e68c5aed59d05c518f0b2**.

Both ZIPs match official API bytes/digest and pass ZIP integrity checking. All **308 + 2** extracted paths have bytes/SHA256/Git blob hashes. Five JSON originals and both decoded original log strings are retained; log BOM and ANSI bytes are preserved. Credential/email shape screening has no unresolved findings. Raw ZIPs, signed URLs and private platform/tool metadata are excluded from the public payload.

The read ledger records bounded metadata observations and exactly one fetch of each owned terminal log and one download of each required ZIP. It records no old artifact download, selection/other job log fetch, CI rerun, source write or ref update.

One restricted 1-vCPU/2-GiB nonpersistent VM only decoded original artifacts. All public bytes were recovered and their hashes verified before shutdown. It stopped at **2026-11-09T08:01:36.999Z**, after **206431 ms** elapsed and **7284 ms** active CPU, with **14970638 B ingress / 401035 B egress**. Deletion succeeded and exact named resume=false GET returned **404 not_found**. There was no timeout extension, extra VM, application/browser/model invocation or new CI. Resource cost was not calculated.

The package preserves a genuine first-pair SQL RED and a failed aggregate gate. It asserts no production/ACME/PostHog backend acceptance, Replay playback or issue closure.
