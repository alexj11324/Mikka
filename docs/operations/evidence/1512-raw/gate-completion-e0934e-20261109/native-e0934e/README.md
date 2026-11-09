# Native evidence — e0934e, CI attempt 1

## Result

The actual Apple Silicon packaged acceptance job completed successfully. The unchanged full-login SQL budget is **RED**: Native **451** > Web **427** (+24). The original **FIRST pair 1** startup comparison is **205 <= 207**. No second pair replaces it; no background, PKCE, unknown, or crossing traffic is subtracted.

| Original window | Query calls | Original segments | Unknown context | Unknown statement |
| --- | ---: | --- | ---: | ---: |
| Web full login | 427 | 19 + 0 + 408 | 87 | 128 |
| Native full login | 451 | 19 + 15 + 417 | 91 | 138 |
| FIRST bundled startup | 205 | 205 | 53 | 75 |
| FIRST hosted startup | 207 | 207 | 53 | 68 |

All 24 records, 12 checkpoints, 8 segments, 2,280 operation/source bucket cells and 1,290 window ordinal rows reconcile. The canonical verifier retains one budget error: Native full-window exceeds Web. Fine attribution remains incomplete; every window has zero uncaptured queries. Capture overflow=false and droppedQueries=0. The original hosted FIRST window has one syncCoordinatorChat completion crossing its end; it is not moved or deducted.

## Exact source and originals

- Head: e0934eb89f972d44ef6cffec6e27c16b4ed203bf
- Actual own Native log / JSON checkout: 114d370f807c465c0f6fe1be47e941aa19adf62a
- Tree: 0a0e2a40d82cbcb18963584e7d54f834a3af54fb
- CI: 42678180995 / attempt 1; Native job: 129369462586.
- Native job ran 19:01:46–19:29:56 UTC on 2026-11-09; actual Node v24.22.2, darwin/arm64.
- Package artifact 13702593301: 1,592 bytes, SHA256 277e26d52569290c37b9c3b4943b99996aceeab6867801f64c23c5de31ad9b1d.
- Native artifact 13702368863: 14,612,748 bytes, SHA256 d58b545aebcd383ffee74e01dae19c6f4e478463096a0276026d04ceb722e193.
- Both original ZIPs matched their GitHub API digests, CRC checks and path safety checks. The full 310-entry hash index is retained. Five selected original JSON files are preserved byte for byte.
- Lifecycle original: blob 028b012e7b284b08dd52412680237986e5c093e9, 714,837 bytes, SHA256 315abc8b4dc7e9fd66a833a8e038d6e91ebfaf9ca2ebf9574615ea2f7905c093.
- Installed daemon is independently reported as 0.0.564, revision 8db16095f46be955df22f42914e0f89b6e5f3d11; it is separate from the app checkout.
- Standalone package report has no revision field. Its full package object matches the three-process crypto report and CDHash.

## Original boundaries and cleanup

Measurements include all pg.Client.query calls and protocol bytes in the primary API process, with concurrent background traffic. Existing separate-harness fixture/lease SQL and connection-handshake/TCP/TLS exclusions remain unchanged. Protocol bytes are not a whole-network measurement.

Lifecycle workspaceNameCleanup.restored is **false**, phase **unchanged**. Its owner and peer sealed-baseline observations are each before=false, after=true. These are different fields and are not collapsed into an all-cleanup-pass claim. Smoke has its own before=true/after=true baseline and restored=true. Parity restored=true is recorded separately. Resource cleanup stages and native cleanup counts remain in their exact original reports.

Parity reports 100 captures covering 50 required screens in light/dark themes, 159 changed pixels / 129,600,000 compared, maximum observed ratio 0.000030092592592592593 under the original 0.001 limit and color threshold 0. Three independent Keychain processes passed and exited with zero observed lookup failures. These are original measured reports; no new pixel inspection or production signed-build claim is made.

Five-pair median latency is 4,086.66 ms bundled and 4,163.67 ms hosted. It is descriptive, introduces no threshold, and does not replace FIRST-pair SQL.

## CI and read ledger

All returned pages close: 10 workflows = 9 success + 1 failure; 40 workflow jobs = 31 success + 8 skipped + 1 failure; 41 head checks = 32 success + 8 skipped + 1 failure, including the independent GitGuardian check. Main CI and final strict succeeded. E2B test failure remains an actual failure. The job named Production build and browser interactions is only the DB gate/summary in this source; it is not claimed as a separate build/browser run.

This reader fetched the Native job log once and each selected artifact once. Other job original logs were not read. Root independently recalculated the same five Git originals; its proof is 3d878fd46861c3847954f005bbd23e0178ea3d49.

## Temporary recovery resource

One 1-vCPU / 2-GiB VM restored the existing artifact references only. It ran for 171,893 ms with 6,206 ms active CPU, 14,925,385 ingress bytes and 347,288 egress bytes. It was stopped at 19:32:54.357 UTC, deleted, and exact same-project/name GET with resume=false returned 404 not_found. The 15-minute deadline was not extended. Actual currency cost is unknown, not asserted zero.

No Native rerun, new business/model execution, source/ref mutation, or production acceptance occurred. Signed download URLs and unrelated private platform fields are excluded. Original unknowns, false fields, failures and source distinctions remain intact.
