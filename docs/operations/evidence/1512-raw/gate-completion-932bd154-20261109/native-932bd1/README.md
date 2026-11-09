# Native original evidence — head 932bd1, CI 42637270671 / attempt 1

Native job 129231919498 naturally completed successfully at 2026-11-09T15:10:23Z. Its real Apple Silicon acceptance step ran from 14:58:07Z to 15:07:03Z. The reader requested no rerun, cancellation, source mutation or production activity.

## Exact source and installed daemon

- Public head: `932bd1549942bc2a8d040c7281a37fbe851c8eb0`.
- Native's own checkout/build/lifecycle: `86f8f6c1d05719db00de89f2ec3c4adf3b4d4fb3`.
- Exact commit API tree: `3c0cc8bb828788e5817fc62048e46fe978e88dd5`, equal to the expected head tree.
- Synthetic parents: `76537e4c2996f717cbd19589e1efae328028aa4a` and the public head above.
- Original query source is darwin/arm64; the job label is macos-26. The Linux recovery VM did not execute Native acceptance.
- Both current readiness records observed daemon **0.0.562**, protocol **3**, installed revision `111a8dfb8b227ac0441324339ff42e4328ea609a`.
- Bundled readiness took 3,688 ms / 11 reads. Hosted observed the already-online environment in 12 ms / 1 read; that is not a fresh installation timing claim.
- No standalone worker hash was emitted in the retrieved Native log.

## Original full windows and FIRST pair

| Window | SQL queries | Original segments |
| --- | ---: | --- |
| Complete Native login | 433 | 19 + 15 + 399 |
| Complete Web login | 435 | 19 + 0 + 416 |
| FIRST bundled startup | 209 | pair 1 only |
| FIRST hosted startup | 234 | pair 1 only |

The original inequalities are **433 <= 435** and **209 <= 234**. These are this run's own results, not values from CP33 or any prior source. The complete normal email authentication, PKCE/automatic renderer navigation, workspace selection and concurrent primary API background windows are retained. No background query was guessed away or moved across a checkpoint.

The verifier checked **24 records / 12 checkpoints / 8 segments**, all **17 operation + 78 source buckets** per record, and **1,311 projected query ordinals** across the four windows. Original query/protocol-byte boundaries and the documented separate-process harness exclusions remain unchanged. In-flight protocol bytes may cross a checkpoint under the original contract.

## RPC and explicit unknowns

| Window | Physical started/completed | Logical started/completed |
| --- | --- | --- |
| Native login | 15 / 15 | 40 / 40 |
| Web login | 35 / 35 | 35 / 35 |
| FIRST bundled | 6 / 6 | 19 / 19 |
| FIRST hosted | 19 / 19 | 19 / 19 |

Exact routes/actions and segmented receipts are retained. All four windows have zero crossesStart, crossesEnd, completionNotObserved and completionWithoutStart in the original physical/logical RPC projection.

Query diagnostics remain **incomplete**: unknown context/statement counts are Native login **94 / 133**, Web login **87 / 132**, first bundled **53 / 75**, first hosted **53 / 79**. The capture reports **0 dropped queries**, **overflow=false**, and 177 complete invocation receipts. Unknowns remain in the SQL totals. Original protocol `unknownReadings=0` in the four windows does not imply complete request/statement attribution.

All five alternating cold-start pairs remain in the original lifecycle. Bundled median **2,194.50 ms** is slower than hosted **2,129.91 ms** by **64.59 ms**; the original report has `bundledFaster=false`. The original contract has no timing threshold. This archive does not relabel the timing result or replace the SQL FIRST pair with another pair.

## Cleanup and package evidence

- Lifecycle: `workspaceNameCleanup.phase="unchanged"`, `restored=false`. Owner and peer sealed baseline are **before=false / after=true**, one changed table each.
- Smoke: `phase="restored"`, `restored=true`, `onlyGeneratedNameDifference=true`. Owner and peer sealed baseline are **before=true / after=true**, zero changed tables.
- Parity: cleanup passed, `restored=true`, final owner/peer sealed baseline matches true.

Lifecycle and smoke stages passed, leases are released, and Native resource cleanup is recorded. The differing `restored` and sealed-baseline fields are preserved independently; no blanket all-fields-true statement is made.

Parity contains 100 passed screenshots for 50 required screens across two themes and no page errors. Original crypto verifies three independent processes against the same immutable package. Strict/deep signature audit passed for the ARM64 ad-hoc development acceptance package; this is not a production signed release claim.

## Original bytes and recovery scope

Both current GitHub artifact ZIPs were requested once and materialized once. Exact API bytes/SHA256, ZIP CRC and archive-path/symlink checks passed. The complete hash index covers **308 Native files + 2 package files**. Five selected JSON originals are byte-for-byte under `original/`; no original content was rewritten.

Lifecycle: **703638 bytes**, SHA256 `71a3af6ff1cd5d55bb30853185f42e2fdd4eab63e214bc0a331eab81eb03b4c5`, Git blob `6faded5bdfab689789efaa592a14796204ac577e`.

Artifact IDs, ZIP digests, all 310 paths, transfer hashes and verification scripts are included. Temporary ZIPs were destroyed with the recovery sandbox; the original GitHub artifacts and selected immutable Git blobs remain the recorded sources. This public payload excludes signed file-reference URLs, private platform runner metadata and unselected image/binary contents.

The credential/email scanner found no shape hits in public payloads, and selected credential field names were absent from the five JSON originals. This bounded scan does not claim universal privacy detection. Only fixed archive paths were adapted in the reused Python verifier; no budget, phase, assertion or window was changed.

## Resource closure and acceptance boundary

The sole recovery VM stopped at **2026-11-09T15:16:07.282Z**, was deleted, and exact same-name GET with `resume=false` returned **404 not_found**. Actual duration **224638 ms**, active CPU **9143 ms**, ingress **14885640 bytes**, egress **368489 bytes**. No extension was used; no owned resource remains. Actual dollar cost is unknown, not asserted to be zero.

The read ledger also preserves one connector-rejected metadata endpoint request and the ordinary supported collection fallback. It did not cause any duplicate original log/artifact read.

This archive establishes this exact Native run's original counters and cleanup. It does not establish whole-CI success, deployed production acceptance, PostHog ingestion, Session Replay playback or LLM generation reconciliation.
