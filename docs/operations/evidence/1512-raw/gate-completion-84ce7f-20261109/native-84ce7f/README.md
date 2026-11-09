# Native evidence — 84ce7f, CI attempt 1

## Result from this exact source

Both unchanged SQL budgets pass in the original windows: **full Native 426 <= Web 427** and **FIRST pair 1 bundled 198 <= hosted 228**. There was one actual Native execution, no rerun, no substituted pair and no deduction of unknown, PKCE, background or crossing traffic.

| Original window | Query calls | Original segments | Unknown context | Unknown statement |
| --- | ---: | --- | ---: | ---: |
| Web full login | 427 | 19 + 0 + 408 | 87 | 128 |
| Native full login | 426 | 19 + 15 + 392 | 94 | 130 |
| FIRST bundled startup | 198 | 198 | 53 | 69 |
| FIRST hosted startup | 228 | 228 | 53 | 75 |

All 24 records, 12 checkpoints, 8 segments, 2,280 operation/source bucket cells and 1,279 window query ordinals reconcile, with zero verifier errors. Each window has zero uncaptured queries. Capture overflow=false and droppedQueries=0. Fine attribution remains explicitly incomplete. All four windows have crossesEnd=0 in this run; no prior run's crossing value is inherited.

RPC physical/logical counts are Native login 14/40, Web login 35/35, FIRST bundled 6/19 and FIRST hosted 19/19. Exact per-action and per-segment tables remain in rpc-diagnostics.safe.json and the original lifecycle.

## Source and immutable originals

- Head: 84ce7f876817f0d73c34a1ef89797fc27ba8661e
- Actual own Native log and JSON checkout: 197ba2452796ce6d5942309f488009963b7cbc7d
- Tree: e7c7c6ad66acd729278393711c10eeed67c6d7ac
- CI 42691592260, attempt 1; Native job 129416680401.
- Native job: 20:25:27–20:42:40 UTC on 2026-11-09, success; actual Node v24.22.2 and darwin/arm64.
- Parity app and harness revisions both match the actual checkout; harness SHA256 is 595f222d7ad053d785068fe632a842e5a0e10217a6b65352e0b5bc581149c061.
- Package artifact 13709281641: 1,599 bytes, SHA256 7d715ceed1216616b46461754e40d0093b12329eeb824e5be79b50fd3b90912f.
- Native artifact 13709126888: 14,611,543 bytes, SHA256 ef3ffd37d80eca1ba21eba33281fd489ee6e414ceb45f004af938406f63cd09f.
- Both ZIPs matched API digests, ZIP CRC and path safety checks. The full 310-file hash index and five byte-exact selected JSON originals are retained.
- Lifecycle: blob 9da2b3d883389e803771c44ac439e14c7ca0ae8c; 707,067 bytes; SHA256 7a04a083e4b442eef7cb73656b55862af00b386bbdb7bf080185012449aaa314.
- Actual installed daemon: 0.0.564, revision 8db16095f46be955df22f42914e0f89b6e5f3d11. This is distinct from the app revision.
- The standalone package JSON has no revision field; its full object matches the three-process crypto report and immutable package CDHash.

## Measurement and cleanup boundaries

The original full windows include ordinary email authentication, Native PKCE/automatic renderer navigation, workspace selection and all concurrent primary API background traffic. Scope is actual pg.Client.query calls and PostgreSQL protocol bytes in the primary API process, without sampling. Existing exclusions remain separate harness fixture/lease SQL and connection-handshake/TCP/TLS overhead. Protocol bytes are not whole-network traffic.

Lifecycle workspaceNameCleanup.restored is **false**, phase **unchanged**. Lifecycle owner and peer sealed-baseline observations are separately before=false, after=true. Smoke keeps its own before=true/after=true baseline and restored=true; parity restored=true is separate. These are not collapsed into an all-cleanup-pass label. Original cleanup stage and resource count reports remain intact.

Parity reports 100 captures for 50 required screens in light/dark, 263 changed pixels out of 129,600,000, maximum observed ratio 0.00003935185185185185 under the original 0.001 threshold and color threshold 0. Three independent packaged Keychain processes passed and exited, with zero observed lookup failures. No new pixel inspection or production-signed-build claim is made.

All five latency pairs remain present. Bundled median is 2,560.78 ms and hosted median 3,264.78 ms; this is descriptive, introduces no threshold and does not replace FIRST-pair SQL.

## Historical comparison

The prior e093 original remains frozen at 028b012e7b284b08dd52412680237986e5c093e9: full **451 > 427 RED**, FIRST **205 <= 207**. Current-minus-historical counts are Native full -25, Web full 0, FIRST Native -7 and hosted +21. These are observed differences between distinct whole-source runs, not a claim that every delta belongs exclusively to one fix. Historical RED is not rewritten.

## Metadata and resource ledger

Final metadata closes all returned pages and job/check IDs: 10 workflows all success; 40 workflow jobs = 32 success + 8 skipped; 41 head checks = 33 success + 8 skipped, including GitGuardian. Skipped remains separate from success. This reader fetched only the Native original log once and each selected ZIP once; all other job originals belong to root/peer readers.

One 1-vCPU, 2-GiB nonpersistent VM restored existing artifact references only. Actual duration was 147,716 ms, active CPU 6,633 ms, ingress 14,895,575 bytes, egress 331,447 bytes. It stopped at 20:46:49.340 UTC, was deleted, and exact same-project/name GET with resume=false returned 404 not_found. Its 15-minute hard deadline was not extended. Actual currency cost is unknown, not claimed zero.

The external interruption happened before any original log/ZIP read or VM creation. Fixed code and terminal metadata were restored from immutable Git objects; originals were not reread. There was no business/model run, source/ref mutation, CI rerun or production acceptance by this reader. Active owned resources: zero.
