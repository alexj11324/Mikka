# Checkpoint 24 — current 1ffa CI failure and original Native first-pair failure

This checkpoint preserves the complete terminal evidence for PR #1799 head `1ffa581f16319381054e0636ae41e6292719a1fe`, actual GitHub checkout `c3b547d0e4d20692643fc95a5194b7ee8cf7f5c0`, shared tree `bc4d584fa651385886e79dc6359b1b43324425d1`. Source construction and complete selection remain in checkpoint 23 (`35f0d803cd50e7736281bab0ebe0120868042046`).

## Current result

**Not merge-ready. CI failed and the original Native first-startup query budget failed. ACME production cases accepted: zero. Issue #1512 remains open.**

- All 43 head checks are terminal: 34 success, 2 failure, 7 original conditional skips. Main CI run 42580506632 failed. Nine companion workflows completed successfully within their documented scopes.
- Image job 129038569886 failed in the normal Docker frozen install: ffmpeg-static 5.3.0 attempted its official b6.1.1 Linux asset and received HTTP 504. Its app, synthetic interactions, daemon and Desktop stages did not execute. The strict UI aggregate failed because IMAGE failed; an additional UI defect is not inferred.
- Source generator/typecheck/lint passed. Core57 and Integration29 actual targets match the full selection. Required PostgreSQL: 72 suites, 91 Node summaries, 3,789 tests passed, zero failed/skipped/cancelled/todo. Daemon: 1,577 passed, two original skips (139 files passed, one disabled file).
- The database aggregate's display name “Production build and browser interactions” does not mean it built or drove a browser; its actual steps only aggregate DB results/timings.

## Original Native measurement

Native packaged job 129040252138 itself reported success. The stricter issue-specific query acceptance is independently **RED**:

| Original window | Native/bundled | Web/hosted | Result |
| --- | ---: | ---: | --- |
| Complete email/auth/PKCE/automatic navigation/selection-to-usable login | 394 = 19 + 13 + 362 | 412 = 19 + 0 + 393 | Pass |
| Original first startup pair, launch-to-usable | 183 | 139 | Fail, +44 |

No later startup pair replaces pair1. No window was moved or truncated; no authentication, background, unknown or cross-boundary contribution was subtracted. Both startup windows and their original durations are retained. Separate renderer/main clock origins are not normalized or combined.

Two independent readers reconciled the same original lifecycle: 12 checkpoints + 8 segments + 4 totals, 17 operation buckets, 78 nested source buckets, and all 1,128 continuous query ordinals. All arithmetic conserves; unknownReadings is zero and diagnostic overflow is false. Diagnostic attribution remains incomplete: Native login has 91 unknown-context /134 unknown-statement queries, Web87/139, bundled53/73, hosted37/55. These remain in the totals.

The original first pair contains 7 physical/18 logical Native reads versus 12/12 hosted reads. Six repeated RPC actions account for 37 second-call SQL queries; three additional API second reads account for16, while Native's first batch saves9: 37+16−9=44. No /v1/devices/* query scope appears in these two windows. These observations locate the difference but do not establish the client-side cause.

Source review explicitly rejects treating only a bootstrap Provider workspace hint as a proven fix: the actual owner-list hooks pass an explicit unresolved scope until matching data establishes their home. The original evidence does not contain client readBoundary, effective-scope or Live ready timestamps. Watch-gap protection, current authorization and revision freshness must remain intact in any subsequent repair.

## Evidence and fidelity

`index.safe.json` enumerates every payload with UTF-8 byte size, SHA-256 and Git blob identity. Included are:

- Root-owned non-PG CI logs and image failure.
- All four PG shard originals and the aggregate; complete72-suite execution ledger, privacy classification, independent root arithmetic.
- Fourteen original companion logs, complete execution/cleanup review and privacy classification.
- Both original Native/UI-strict logs, five original JSON artifact files, complete ZIP entry manifest, original-window/RPC diagnostics, independent arithmetic, source bindings and recovery receipts.
- Unchanged root independent Native verifier and its actual RED result. One initial caller used the wrong metadata field name; only that invocation was corrected, never the verifier or artifact.
- Exact-source backend/bootstrap/frontend diagnosis with explicit unknowns, without claiming an unexecuted repair.

Each assigned original job log and each Native ZIP was acquired once. Subsequent independent arithmetic uses frozen Git blobs rather than another Actions download. Ten public PostHog capture-key occurrences were redacted from the Analytics log with original/public byte hashes retained; other original decoded logs retain BOM/ANSI and were not normalized. The public logs and isolated synthetic fixtures were reviewed for known sensitive patterns; this is not a universal proof of absence.

## Cleanup and limits

The sole artifact-recovery VM `sbx_Wz7odbCTP5bW88FCQfwmRkxXzIwu` was stopped, deleted and its exact name read back with resume=false returned404. Actual lifetime206431ms, active CPU7284ms, ingress14970638B and egress401035B are preserved; cost is unknown. It only decoded completed artifacts and was not the Native execution host.

Four PG containers and four networks were removed. Companion cleanup records retain missing independent finalizer outcomes. Native lifecycle/smoke workspaceNameCleanup.restored remain false while both sealed owner/peer names match afterward; parity.restored is true. These are separate facts.

No production model, PostHog Replay playback, native PostHog PNG or end-to-end production acceptance is claimed. This checkpoint changes only the evidence branch; it does not fix product code, trigger a rerun, merge the PR, acquire a main/account window or close the issue. The prior passing025 measurement remains historical.
