# #1512 CP43 — empty Coordinator backfill, actual PG regression, and 84ce publication

Recorded 2026-11-09. This checkpoint preserves preparation, real failures, corrections, actual validation, cleanup and source publication. It is **not production acceptance**.

## Current source and actual scope

- Feature: `84ce7f876817f0d73c34a1ef89797fc27ba8661e`.
- Tree: `e7c7c6ad66acd729278393711c10eeed67c6d7ac`.
- Ordered parents: tested candidate `5a0c90774b8c48fc390ea05cf782bbc9cbe79a62`, actual main `7848e79df9c5af67e526aeed1c828858db392066`.
- Root normally CAS-updated only its feature at 20:17:40 UTC. Main was not moved by this action.
- Actual new CI checkout: `197ba2452796ce6d5942309f488009963b7cbc7d`, with the same tree and parents [main7848, feature84ce].
- Coordinator source: `d73e30c36212029a8951a25a692c4e04a2a5b86d`.
- Final test source: `c6c92ea2741174b5baadbd1535fc8b0c62b8275e`.

The ordinary merge preserves actual main's ten changed leaves. Relative to previous feature e093, exactly five files differ: Coordinator source, its tests, and the three already reviewed publisher/test/ADR changes from main. Native harness, windows, deadlines, pair selection, tracing journal and all other leaves are unchanged.

The application change puts a conservative eleven-family EXISTS check into the existing active-owned-Personal read. Only an existing Personal Coordinator plus strict boolean false skips the old ensure/migration transaction. Missing/unknown/unauthorized/nonempty results follow the original path. Existing migration body, locks and original ten-minute freshness interval are retained.

## Real execution and preserved failures

1. **42688581877/A1 — controller startup failure.** Jobs/checks were empty and no PostgreSQL service started. The two plain YAML if scalars contained colon-space; a real js-yaml parse reproduced the error. The corrected folded scalars decode to identical expressions. This is not an application RED.
2. **42689043866/A1 — rejected RED.** Old e093 plus initial new tests produced 47 tests:40 pass/7 fail, zero skip/cancel/todo. Three failures were intended query-count assertions; three were new SQL fixture errors. The strict controller refused to accept them, and GREEN was not allocated.
3. **Fixture-only correction.** A normal child commit 5a0 changes three test hunks (+7/-4): separate text/UUID parameters for copied heads and suggestions, and an atomic task/attempt CTE matching an existing passing fixture. All21 new cases, all assertions, SQL counters, TTL boundaries and the entire old test file remain unchanged.
4. **42690271741/A1 — valid RED and full GREEN.** Old e093 with the corrected tests has exactly four specified ERR_ASSERTION leaves plus the failed parent:47 tests/42 pass/5 fail, zero skip/cancel/todo. Actual counts are26,26,27,29 versus expected1. All25 old children pass. Candidate5a0 then executes the original required-DB runner, original72-suite inventory and selected complete25-file test:bot-threads-db family:375/375 pass, zero fail/skip/cancel/todo. Coordinator children46/46 pass (old25+new21).

Both stages use independent GitHub runners and fresh PostgreSQL17 services; Node24.22.2/pnpm10.34.3. Migration bootstrap, original E2E setup and environment binding execute. No production credentials or account are used. Original8/12 minute job limits and original admission expiry remain unchanged.

The full GREEN output contains the runner's prefixed streaming copy and a complete bare TAP. Root uses only the bare TAP for counts; mirrored lines are not duplicate test executions.

## Originals and resource closure

Each original job log has one assigned reader and was immediately frozen in Git; ZIP reads are zero. All original command stdout/stderr streams, tool responses, job logs and readbacks are retained here, including the unsuccessful controller/test versions. Subsequent reviews read Git originals.

- First PG service stopped20:03:38 and platform-removed with its network20:03:40; GREEN never allocated.
- Final RED stopped20:11:10 and container/network removed20:11:17.
- Final GREEN stopped20:13:54 and container/network removed20:13:56.
- Final Ops normally closed to `215f846817f5a73c88ee37031ab9b91a21268cee`, manifest enabled=false.
- Closing run42691624148 has both jobs actually skipped.
- Remaining owned isolated PostgreSQL services:0.

The root's independent RED and GREEN recomputations are included alongside the operator's original index. Dollar cost is not inferred from elapsed time.

## Remaining actual acceptance

Previous e093 full Native451 versus Web427 remains **RED +24**; its FIRST pair1 was205 versus207. No counterfactual subtraction changes that result. The new84ce canonical CI/Native run42691592260 is still being evaluated at this checkpoint. Unknown/background/cross-window records and original full/FIRST boundaries remain mandatory.

Actual main7848 and final84ce have all18 canonical worker selector objects identical, including the full lock. This is source-input equality, not a newly observed cloud runtime publication. Main7848's R7 and Web deploy were in progress when observed. #1505 holds the actual20:04:10–22:04:10 source/SMOKE segment after #1503's explicit20:02:46 release; #1512 has no production window or reservation.

Formal production cases remain0/2. The readiness review confirms one real NewTask UI click enters the ordinary Coordinator message/turn path. Actual same-trace parentage, all generations, Logs, Replay playback, native PNG and populated timeline still need the two real cases. Factory task UUID and the trace carrier's issue ID must not be mixed.

Historical controlled-failure execution is source1d126/run42552094175, not the earlier ae1504 preparation:20 retained traces/80 spans/40 ERROR logs, including17 initially unsampled traces, with two stable complete backend snapshots. Historical Web memory-exporter baseline is mean+0.344583ms/p95+0.436580ms,600 measurements per condition plus100 warmups, grouped alternating order. It is not a new84ce production or daemon benchmark. The included applicability review identifies unchanged probe dependencies and the serverless flush branch that the old serverless:false probe cannot cover. The saved warm-up/user/action alert SQL was already applied and read back; no unnecessary new model run, alert trigger or OAuth step is introduced.

## File index

index.safe.json enumerates64 payload files by exact path, Git blob, bytes and SHA256. README and index are the two additional metadata files. Earlier preparation manifests are preserved as stage-specific records; use the final source identities and final PG index above for the accepted candidate.
