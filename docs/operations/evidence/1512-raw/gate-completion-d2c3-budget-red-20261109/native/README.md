# Native evidence — d2c3f6, CI attempt 1

## Actual result

The packaged Native functional job succeeded, but the unchanged full-login SQL budget is **RED: Native 424 > Web 358 (+66)**. The original **FIRST pair 1** startup budget passes: **211 <= 221**. There was no rerun, substituted pair, changed threshold, time-normalized count or deduction of unknown/PKCE/queued/background/crossing work.

| Original window | Query calls | Original segments | Unknown context | Unknown statement |
| --- | ---: | --- | ---: | ---: |
| Web full login | 358 | 19 + 0 + 339 | 71 | 107 |
| Native full login | 424 | 19 + 15 + 390 | 91 | 129 |
| FIRST bundled startup | 211 | 211 | 53 | 76 |
| FIRST hosted startup | 221 | 221 | 53 | 71 |

All 24 records, 12 checkpoints, 8 segments, 2,280 operation/source bucket cells and 1,214 window query ordinals reconcile. The canonical verifier retains exactly one budget error: Native full-window exceeds Web. All windows have zero uncaptured queries and crossesEnd=0 in this run. Capture droppedQueries=0 and overflow=false; fine attribution stays incomplete.

RPC physical/logical counts are Native login 16/41, Web login 28/28, FIRST bundled 7/19 and FIRST hosted 19/19. Full per-action and per-segment evidence is retained. window-source-counters.safe.json projects all original checkpoints, segments and totals with their complete operation/source tables, without regrouping.

## Source and exact original bytes

- Head d2c3f63448130443e3e10bb5304417162f585776; tree a311b73945e9846a33a2bbd3ffa54b9e23888b1d.
- Own Native original log and JSON checkout: 3bc095c100537563296186fc3d4cc4d60b59b698.
- Exact commit API independently confirms that tree and ordered parents [1c7698655405b289d7fdbd814713d15e542cc2bb, d2c3f63448130443e3e10bb5304417162f585776].
- CI 42707256422 / attempt 1, Native job 129474527225. Root's terminal metadata records completion at 22:28:28 UTC on 2026-11-09, success.
- Own log confirms Node v24.22.2; crypto report confirms darwin/arm64.
- Parity app and harness revisions match the checkout. This run's harness SHA256 is 3cf8818efdc55a782e839eba45ed9ce252888771758136e51cff108c40b23554.
- Package artifact 13716212399: 1,596 bytes, SHA256 972889ccf4d19cdd662a453d847af614426df3501eca473c91e0fc438d6ee28e.
- Native artifact 13714749727: 15,153,427 bytes, SHA256 3fbc2d4165cb8b1c90042f091466d77860ac8f1473f82c462f2a14afa1e78ce7.
- Both ZIP byte counts/digests match the API; ZIP CRC and path safety checks pass. This run has **316 actual files (314 Native + 2 package)**, not the previous 310.
- Five selected JSON originals are retained byte for byte. Lifecycle is blob d3e17ccdb25193b6da4a6c645c06bc7d140e96d2, 687,054 bytes, SHA256 4a3b01ccf9d3e03175dd666683afa2f45027bfbb3be5c3cc76969cbd083c37a5.
- Actual daemon version is 0.0.564, installed revision 8db16095f46be955df22f42914e0f89b6e5f3d11; it is separate from the app source.
- Standalone package JSON has no revision field; its complete package object matches the three-process crypto report and immutable CDHash.

## Original measurement and cleanup boundaries

Full windows include ordinary email authentication, Native PKCE/automatic renderer navigation, workspace selection and all concurrent primary API background queries. Scope is actual primary-process pg.Client.query calls and PostgreSQL protocol bytes, without sampling. Existing separate-harness fixture/lease SQL and connection-handshake/TCP/TLS exclusions are unchanged. Protocol bytes are not whole-network bytes.

Lifecycle workspaceNameCleanup.restored is **false**, phase **unchanged**. Its owner and peer sealed-baseline observations are separately before=false, after=true. Smoke keeps before=true/after=true and restored=true; parity restored=true is separate. These fields are not collapsed into an all-cleanup-pass claim. All original cleanup stages and native resource counts remain present.

The actual parity report has **102 captures / 51 required screens**, light and dark, 158 changed pixels / 132,192,000 compared pixels, maximum observed ratio 0.000023148148148148147 under the unchanged 0.001 limit and color threshold 0. Three independent Keychain processes passed, exited and reported zero lookup failures. No new pixel inspection or production-signing claim is made.

All five startup timing pairs remain present. Bundled median is 3,358.53 ms and hosted median 4,672.18 ms. This is descriptive and does not replace FIRST-pair SQL or add a latency threshold.

## Historical comparison and ownership

The prior 84ce result remains frozen: full 426 <= 427 and FIRST 198 <= 228. Current-minus-prior totals are Native full -2, Web full -69, FIRST Native +13 and hosted -7. These are observations between distinct whole-source runs, with no cause inferred. Earlier e093 full 451 > 427 RED is also retained; historical results are not overwritten.

This head started 12 workflows, not the former 10. Root owns final whole-head workflow/job/check metadata and the strict original; this Native reader does not duplicate those original reads. Functional CI success does not override the full-login RED.

## Read and resource ledger

Native original log was read once, and each selected artifact ZIP was acquired once. No other job originals were read. Metadata-only waiting was externally interrupted before original reads; resumption used fixed Git helper objects and did not reread an original.

One 1-vCPU / 2-GiB nonpersistent VM restored existing artifact references only. It stopped at 22:34:27.098 UTC after 189,291 ms, with active CPU 6,214 ms, ingress 15,439,402 bytes and egress 327,872 bytes. It was deleted; exact same-project/name GET with resume=false returned 404 not_found. The 15-minute hard deadline was not extended. Actual currency cost is unknown, not claimed zero.

No business/model execution, Native rerun, source/ref mutation or production acceptance occurred in this reader's work. Active owned resources: zero.
