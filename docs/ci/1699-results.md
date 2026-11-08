# Incremental CI evidence (#1699)

Baseline collected from the GitHub Actions jobs API on 2026-11-08 UTC.
The table measures the **CI workflow**, not the sum of concurrent workflows or billing multipliers.
Wall time is `last active job completed_at - workflow created_at`; runner-minutes
sum active job durations (including setup/teardown). First queue is separately
reported; later inter-job queue delays remain in wall time. Cancelled/superseded
runs are not counted as successful samples. See [raw receipts](1699-baseline.json).

| Scenario | Run | Wall (s) | First queue (s) | Runner-min |
| --- | --- | ---: | ---: | ---: |
| Mobile (+ workflow) | [42428417796](https://github.com/alexj11324/Mikka/actions/runs/42428417796) | 1209 | 153 | 37.82 |
| Web UI | [42429635332](https://github.com/alexj11324/Mikka/actions/runs/42429635332) | 706 | 122 | 37.25 |
| Daemon | [42429196573](https://github.com/alexj11324/Mikka/actions/runs/42429196573) | 855 | 274 | 36.05 |
| Factory + DB (+ package script) | [42427042266](https://github.com/alexj11324/Mikka/actions/runs/42427042266) | 859 | 2 | 36.35 |
| Main push | [42427210166](https://github.com/alexj11324/Mikka/actions/runs/42427210166) | 929 | 2 | 37.23 |
| Docs | [42427614962](https://github.com/alexj11324/Mikka/actions/runs/42427614962) | 535 | 210 | 0.28 |
| Issue reference | [42422244966](https://github.com/alexj11324/Mikka/actions/runs/42422244966) | 1071 | 245 | 37.92 |
| CI/config | [42427343956](https://github.com/alexj11324/Mikka/actions/runs/42427343956) | 1278 | 107 | 39.25 |

The sample set has no clean Protocol-only or Migration-only successful example.
Mobile and Factory examples include configuration/script changes; these are
conservative global inputs in the new policy and therefore cannot demonstrate
a selective speedup. Five clean synthetic/real after scenarios are still needed.
A five-sample empirical p95 is descriptive, not a stable service percentile.

Core and integration unit commands, each serialized in the old workflow, take
approximately 6–8.5 minutes per lane. DB shard setup and four PostgreSQL runners
consume most of the remaining runner time. Queue delays are significant even
for docs: the docs sample spent 535 s wall time for 17 s of job execution.

For superseded attempts, compare the adjacent cancelled runs 42429290220,
42428556411, 42428173095 and 42427639437 with their successful replacements.
Those cancellations are saved work, not proof of faster checks.

## Specialized workflows

[Bounded receipts](1699-special-baseline.json) from the same source heads show
why CI-only wall time understates the problem:

| Scenario | Workflow run | Wall (s) | Runner-min | Conclusion |
| --- | --- | ---: | ---: | --- |
| dc625757 | [42429635352](https://github.com/alexj11324/Mikka/actions/runs/42429635352) | 901 | 13.98 | success |
| dc625757 | [42429635327](https://github.com/alexj11324/Mikka/actions/runs/42429635327) | 333 | 5.02 | success |
| 253c2d45 | [42429196544](https://github.com/alexj11324/Mikka/actions/runs/42429196544) | 843 | 12.75 | success |
| c99e4a57 | [42428417772](https://github.com/alexj11324/Mikka/actions/runs/42428417772) | 737 | 11.88 | failure |
| 22ca15d6 | [42427614964](https://github.com/alexj11324/Mikka/actions/runs/42427614964) | 1607 | 14.23 | success |

The docs-only head still built the self-hosted image: 1,607 s wall / 14.23
runner-min, while its source CI used 0.28 runner-min. The Mobile image failure
is retained as a failure, not treated as successful acceptance. The Desktop
sample was still running when collected and is excluded from completed timings.

## After

Pending actual Actions evidence; local selection counts are not timings.

<!-- Issue #1699 synthetic docs-only performance probe; never merge. -->
