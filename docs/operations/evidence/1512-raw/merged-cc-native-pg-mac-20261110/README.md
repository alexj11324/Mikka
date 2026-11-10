# #1512 checkpoint 54: cc389 merge, pending-only PostgreSQL proof and Mac diagnostics

Snapshot: 2026-11-10 03:12:18 UTC.

The current formal candidate is **5f3598029033b83ee72c88ea6c49955205eecab2**, tree **b2559ddd822059f1b69fa711d037f654a790fd2a**. Its formal CI is still running; production acceptance remains **0/2**. This checkpoint preserves completed isolated work and original failures, and does not establish complete Native/Web query-budget or production acceptance.

## Source and canonical generation

M `c0fab838` normally merges `907d281` with main `cc389d61`, preserving both sides of the three handwritten overlaps. All 6,950 merged leaves and the 258 canonical generator inputs are bound to the exact source. The recovered route outputs (257 routes /345 methods) exactly match byte count, SHA256 and Git SHA recorded by the real Node generator.

Three temporary VM execution/capture attempts and their cleanup are retained. The earlier real template-unit exit1 is not overwritten. Its minimal 267-file fixture omitted the workflow read by the first unit test; that is a concrete input defect, while the lost complete diagnostics prevent a claim that it was the only failure. The full M checkout later passes the unchanged complete test file.

## Real isolated PostgreSQL and Node verification

Run [42745526739/A1](https://github.com/alexj11324/Mikka/actions/runs/42745526739), job129596578091: Node24.22.1 /pnpm10.34.3 /PG17.11.

| Fixed source | Observed result |
| --- | --- |
| M template unit file | 33/33 pass |
| G Native read-batch unit file | 30/30 pass |
| RED f5d208 | 25 tests /22 pass/3 fail: exactly the specified 5-versus-1 and 4-versus-2 query assertions, plus their parent |
| GREEN a5027 | 25/25 pass |

No skipped/todo/cancelled cases. Security/freshness counterexamples pass in both phases. GREEN receives a fresh database, OID16384 to32429. All20 original command stdout/stderr streams are preserved with byte/hash checks. Owned container, volume and network removal completed with errors=[]; the execution entry was closed and its closing run skipped. ZIP member validation was not performed: the proof uses complete original command bytes recovered from the sole job-log read.

## Mac original failure and two diagnostics

The formal5852 restart bootstrap EIO5 remains a failure of unknown cause. Wrapper diagnostic42739939984 succeeded but added70ms between commands. The lower-perturbation diagnostic42745131850 also succeeded: reconnect bootout0/bootstrap0 and a0.002ms command gap. Its old daemon stopped1ms before observed bootout completion. These observations do not establish the original failure's cause or a product fix.

The temporary package was formal5852 plus the documented diagnostic service overlay. It never entered the formal product branch. Both diagnostic entry guards were closed, and exact fixture HOME/private control cleanup is recorded. Independent process absence remains unprobed. No ZIP or extraction VM was needed for this Mac diagnosis.

## G formal lint failure and comment-only repair

G's formal Source and site-search jobs both failed on the deliberately thenable Drizzle test fixture. The complete original logs and corrected final inventory are retained. G's remaining CI terminated or was cancelled when the repaired head was published; cancelled work is not counted as a pass.

5f359 adds exactly one documented next-line `unicorn/no-thenable` exception. Removing that134-byte comment reproduces the prior test file byte-for-byte; product code, thenable structure and every assertion are unchanged. Actual repaired-head lint and the remaining formal gates are still pending at this checkpoint.

## Evidence interpretation

[The index](index.json) lists every payload's Git blob, UTF-8 byte count and SHA256. Root read and recomputed every listed frozen Git payload before constructing this checkpoint. No Actions original was downloaded again for this archive. The original Mac and PG indexes retain their original archive paths and source bindings.

Historical warm Web HTTP/PG overhead remains attributed to its original run. The unchanged20 probe dependencies and lockfile permit bounded reuse; this does not measure new Native queue cost, collector network, daemon/CLI, cold startup or production concurrency.

Next: finish the exact repaired-head CI and original Native windows, accept the unmodified formal Node22 workflow, then merge and verify the actual production app/runtime before the two independent official subscription cases and full PostHog trace/AI/Logs/Replay evidence.
