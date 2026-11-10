# Issue #1512 checkpoint 55 — formal checks passed, Native full-login budget failed

This checkpoint preserves the exact evidence for formal source `5f3598029033b83ee72c88ea6c49955205eecab2` (tree `b2559ddd822059f1b69fa711d037f654a790fd2a`). It is **not production acceptance**. Issue #1512 and PR #1799 remain open; production is **0/2**.

## Decisive result / 核心结论

| Original complete window | Native SQL | Web/hosted SQL | Result |
| --- | ---: | ---: | --- |
| Full login | 441 | 331 | FAIL: +110 |
| Original first startup pair | 208 | 228 | PASS |

The Native functional Actions job succeeded. That success does not satisfy the separate full-login query budget. The full original windows, email login, Native PKCE, unknown context/statement classifications and all recorded rows remain included.

原始24条记录、12个checkpoint、8个segment、2,280个bucket cell和1,208个连续SQL ordinal均守恒；8个RPC投影完整。完整登录逻辑RPC为40/25，首轮startup为19/19。详见 `native/full-verification.json`、`native/rpc-verification.json` 和五份未修改原JSON。两份原ZIP也保存在本目录，包含全部成员及CRC证据。

Native pending-only workspace-choice sharing is observed in actual receipts: the matching SELECT count fell from43 to33; total Native queries fell448→441. The concurrent Web run fell438→331. Source and receipt evidence identify extra Native read waves; they do not yet prove the exact live/open causal branch. No unsafe cache extension, dropped feature, shifted window or guessed product fix is included.

## Formal checks and Mac

All11 workflow runs are SUCCESS/A1. All40 Actions jobs are terminal:36SUCCESS and4 existing conditional SKIP. With GitGuardian,41 check runs comprise37SUCCESS and4SKIP. The synthetic CI checkout is `c8ebffc19c788fa1db9cc441ac71a09f99dbb4a8`, with exactly the formal source tree.

`node22/` copies the complete37-file formal Node22 archive from `e388da67c8a581d00cdfe465b9d24d691d886b8f`. The real Node22 Mac install/register/online/reconnect passed, and Node18 was refused before npm/enrollment. Package bytes and actual checkouts are bound. The earlier5852 EIO failure remains in preceding checkpoints with unknown cause; this success does not rewrite it.

## Hosted acceptance adapter and actual offline verification

Hosted UI #61 changed the real workspace/search/new-task controls. The prepared browser adapter supports the verified default and hosted contracts, retains exact Personal/Coordinator/Cloud/profile readbacks and one submission, and preserves unknown-result cleanup.

Actual Node24.22.1 results in an isolated1CPU/2GiB cloud VM:

- Old driver + new browser tests:61tests,54PASS/7FAIL. All original43tests passed; all failures are new hosted contract cases.
- New driver + browser and core acceptance tests:135/135PASS.
- One-shot production dispatch controller:37/37PASS.
- All runs have zero cancelled/skipped/todo. Six original output streams, complete result bundle,17 original transport-part responses and independent byte/hash verification are preserved.

The adapter source is prepared, **not pushed to the formal branch**. These are synthetic seam tests, not a real browser/model/Replay acceptance. The Node22 setup refusal happened before any test and is retained. Both temporary VMs were stopped, deleted and observed404. No test assertions were relaxed.

## Main integration and operations

The incremental source check is fixed to main `f5ddb5cda60b57c1006c60fcc997cc3455d771aa`; it does not claim compatibility with later main commits. Its90 changed paths commute with the current52-path feature delta after preserving all three overlapping files. The unreferenced combined tree is `6d5a848b2fbdbee41541e2a535ac06057cf420b1`. All258 canonical inputs and257 routes/345 methods were checked; deterministic serialization is distinguished from a fresh generator execution.

The one-shot Native extractor fetched each original ZIP once, froze it before parsing, checked every member CRC and froze all five JSON members before parsing. Its private directory was removed; the entry was closed and its close/archive runs skipped. No extra VM was used for extraction.

The old production transport has now been normally advanced from `a0dd581` to closed `ca6fe6dc65f9528c10401f17c764d0ff86f36ed2`: old open import/dispatch/cleanup jobs were removed, the replacement has `if:false`, `enabled:false`, and no actions-write/token environment. No production request was dispatched. Actual closure-run metadata is checked separately.

## Integrity and continuing work

`index.json` gives exact source origins, Git blob IDs, byte counts and SHA-256 values. Root re-read every UTF-8 payload and recomputed bytes, Git SHA1 and SHA-256. The two original binary ZIPs retain the exact blob IDs from the source archive tree and the single reader's verified sizes/SHA-256/CRC receipts; Root did not redownload the original artifacts. The compressed offline result was independently assembled and SHA-256 checked before VM cleanup.

Next: a bounded diagnostic-only Native overlay must establish channel/read/catch-up causality across both documents without changing the original windows, budget, authorization or product behavior. Then implement the proven fix, verify the resulting source, merge normally in an available actual window and complete both production model paths with PostHog evidence before closing #1512.
