# Native original evidence — reopened CI 42621847483 / attempt 1

This directory records the naturally triggered `pull_request reopened` run. The reader did not rerun, cancel, change source, select a later startup pair, or use prior-run values. Native job 129181846034 completed successfully at 2026-11-09T13:34:01Z.

## Source and actual installed daemon

- PR head: `f3466ba479ef51918790f521a288feaef5160e44`.
- Actual own Native checkout, API build and lifecycle revision: `3b51cf11dffdbb3a6167946a18e7302f3cb6035b`.
- Exact commit API tree: `102bc671b4c5e3cf49fcce54025c71b26f817cf2`; equal to the head tree.
- Synthetic parents: `111a8dfb8b227ac0441324339ff42e4328ea609a`, `f3466ba479ef51918790f521a288feaef5160e44`.
- The Apple job used `macos-26`; the package report records ARM64. The temporary Linux recovery VM is not the Native execution source.
- Both bundled and hosted readiness records report installed daemon **0.0.562**, protocol **3**, installed revision `111a8dfb8b227ac0441324339ff42e4328ea609a`. These are this run's observations, not the earlier daemon version.
- Bundled readiness took 7,282 ms / 23 reads; hosted readiness observed an already-online environment in 35 ms / 1 read. The latter is not a 35 ms fresh daemon installation claim.
- No standalone worker hash was emitted in the retrieved job log.

## Unchanged SQL windows and first pair

| Window | SQL calls | Original segment counts |
| --- | ---: | --- |
| Complete Native login | 431 | 21 + 15 + 395 |
| Complete Web login | 444 | 19 + 0 + 425 |
| First bundled startup | 211 | first pair only |
| First hosted startup | 228 | first pair only |

Both original inequalities pass: **431 <= 444**, **211 <= 228**. Native email authentication really recorded 21 queries and Web recorded 19; neither was normalized to a prior run. The complete email, PKCE/automatic navigation, workspace selection and concurrent primary API background window is retained.

The verifier checked 24 records, 12 checkpoints, 8 segments, every one of 17 operation buckets and 78 source buckets, and all **1,314 projected query ordinals** across the four windows. Window query and protocol-byte boundaries are unchanged; protocol bytes may cross a checkpoint according to the original contract. The original harness's documented separate-process fixture/session exclusions remain as originally stated. No guessed background subtraction was applied.

## RPC and attribution limits

| Window | Physical started/completed | Logical started/completed |
| --- | --- | --- |
| Native login | 16 / 16 | 40 / 40 |
| Web login | 36 / 36 | 36 / 36 |
| First bundled startup | 9 / 9 | 19 / 19 |
| First hosted startup | 19 / 19 | 19 / 19 |

Exact route/action counts are preserved in `rpc-diagnostics.safe.json` and `terminal-review.safe.json`. This run has zero reported crossesStart, crossesEnd, completionNotObserved and completionWithoutStart in all four physical/logical RPC windows. Prior runs' crossing counts are not substituted.

Query diagnostics remain **incomplete**, with no overflow or dropped queries. Unknown context/statement counts are Native login **91 / 130**, Web login **87 / 138**, first bundled **48 / 76**, first hosted **48 / 76**. These unknowns remain in the SQL totals. The separate original protocol `unknownReadings` field is zero in the four windows; it is not a claim of complete context/statement attribution.

Five alternating cold-start pairs remain in the original lifecycle. Their recorded medians are bundled 3,757.55 ms and hosted 3,814.39 ms, with no new timing threshold. The SQL comparison still uses pair 1.

## Cleanup and package boundaries

Lifecycle and smoke cleanup stages passed and their leases are released. Native resources are reported cleaned. The original workspace-name fields are retained distinctly:

- Lifecycle: `workspaceNameCleanup.phase="unchanged"`, `restored=false`. Owner and peer sealed baseline observations are **false before / true after**, with one changed table each.
- Smoke: `workspaceNameCleanup.phase="unchanged"`, `restored=false`. Owner and peer sealed baseline observations are **true before / true after**, with zero changed tables.
- Parity: cleanup passed, `workspaceNameCleanup.restored=true`, owner/peer final sealed baseline matches true.

Thus this archive does not turn `restored=false` into true or call every cleanup field true. Original crypto evidence confirms three distinct processes and the same immutable package; the acceptance package's strict/deep signature audit passed. This is an ad-hoc development acceptance package, not a production signed release.

## Original integrity, access and resource ledger

The two GitHub artifact ZIPs were requested once each and materialized once each. Their exact API bytes, SHA256, ZIP CRC and archive path checks passed. The full 310-file path/bytes/SHA index covers 308 Native files and 2 package files. Five selected JSON files are preserved byte-for-byte under `original/`; their contents were not rewritten.

Lifecycle: 710017 bytes; SHA256 `169ced99b5608e940585b5bcf0fb7425609f49865b41391cc8debab97ff37140`; Git blob `8d3e043be4d640ec1ed3d72a82c37f19b11fe2b2`.

The original ZIPs are referenced by GitHub artifact ID and digest in `artifact-transfer.safe.json`; their temporary VM copies were removed with the sandbox. This public payload does not duplicate private platform metadata, signed download URLs, or every binary/image file. The exact Native job log is retained after credential/email shape scanning. The scanner is a bounded pattern check, not a proof of absence of every possible private datum.

The recovery VM was stopped at **2026-11-09T13:40:07.741Z**, then deleted; an exact same-name GET with `resume=false` returned **404 not_found**. Actual session duration was **307538 ms**, active CPU **7530 ms**, ingress **14943740 bytes**, egress **402061 bytes**. No extension was used, no owned resource remains, and no zero-cost claim is made.

This evidence establishes this Native run's original acceptance and cleanup observations. It does not claim deployed production acceptance, PostHog ingestion, Replay playback or LLM generation reconciliation.
