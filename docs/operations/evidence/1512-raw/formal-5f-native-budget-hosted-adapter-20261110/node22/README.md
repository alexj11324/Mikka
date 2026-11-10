# #1512 formal local installer evidence at5f359802

The existing **Local device Node 22** workflow passed once on the repaired formal source `5f3598029033b83ee72c88ea6c49955205eecab2`, tree `b2559ddd822059f1b69fa711d037f654a790fd2a`. This is formal test evidence from the original service and fixture, with no temporary instrumentation overlays.

## Actual formal result

[Run42748069074/A1](https://github.com/alexj11324/Mikka/actions/runs/42748069074) completed successfully at2026-11-10T03:18:02Z.

| Job | ID | Result | Completed UTC |
| --- | --- | --- | --- |
| package | 129604856273 | success | 03:14:57 |
| node22-unit | 129604856233 | success | 03:16:53 |
| macos-arm22.22.1 | 129605200272 | success | 03:17:36 |
| macos-arm18.20.8 | 129605200378 | success | 03:18:01 |

The Mac22 original stdout reports `installed/launchagent/online/reconnect`, runtime22.22.1, npm started, two registrations, two heartbeats and one enrollment. Its installer state sequence reached online for install and reconnect. The original assertions covering the private npm package, actual selected Node binary, data directory and no re-enrollment passed.

The Mac18 original stdout reports runtime18.20.8 and `check/node_required`, with npm not started and zero enrollments, registrations or heartbeats. That negative result was read from its single frozen original job log.

## Source and package association

The package and both Mac jobs' actual `git log -1 --format=%H` output equals the formal head. Immutable Git metadata binds its tree and exact files:

- workflow: `d195f389292e1a84967fd9864063ac536b91bbaf`
- service: `277fae47e47d1ce4a2061838b1f08f457b7b3355`
- fixture: `858b521f583e605340adc7be0685de17de2c60a8`

Linux upload, both Mac downloads and artifact metadata agree on package ZIP SHA256 `8548c14ffc7b10f23f342a21673ef4bf49a9e97620df62a6244ea0d91dd8ba0c`. Npm's package shasum is `9c603b4eb5852ed29b5b3929353c6fede2b2af00`. The tarball and artifact ZIP were not separately downloaded, and the truncated npm SHA512 display is not treated as a complete integrity value.

## One dispatch and closed entry

The short-lived dispatcher [run42748046897/A1](https://github.com/alexj11324/Mikka/actions/runs/42748046897) made exactly one POST to existing workflow409752684, receiving HTTP200 and formal run42748069074. The branch equaled the expected formal head both before and after the request. The returned run's workflow, source, branch, event and attempt were verified.

Normal closing commit `9ddc5bbffb384ca711861dc798028344f33f1ad0` disabled the guard and manifest and removed the job's `actions: write` declaration. Remote readback matched. [Closing run42748159157/A1](https://github.com/alexj11324/Mikka/actions/runs/42748159157) and its only job129605195943 were skipped with no runner assignment and no steps.

## Cleanup and interpretation limits

The unchanged formal fixture's finally block closes its fixture server, restores HOME/PATH and removes its private HOME. Its successful process exit establishes completion of those awaited statements. The original Node22 cleanup suppresses the bootout error, so its exit code remains unknown; there is no independent cleanup receipt or process-absence probe. Cleanup receipts from earlier diagnostics belong to different runners and HOMEs and are not reused here.

The formal5852 bootstrap5 failure remains preserved with cause unknown. The earlier wrapper and in-process diagnostic passes remain bounded diagnostic evidence; this new, materially changed formal head provides independent acceptance. Nothing here establishes why5852 failed or retrospectively turns its failed attempt into a pass. This archive is local installer acceptance, not production tracing acceptance.

## Navigation and reading ledger

- [result.safe.json](result.safe.json): full formal result, dispatcher closure, history and boundaries.
- [formal/derived/source-binding.from-logs.safe.json](formal/derived/source-binding.from-logs.safe.json): actual checkout and same-package witnesses.
- [index.safe.json](index.safe.json): every archived payload's immutable Git blob, byte count, SHA256 and origin.
- `formal/originals/` and `dispatcher/originals/`: original tool responses frozen before parsing, plus exact decoded log strings.
- `formal/derived/` and `dispatcher/derived/`: log-extracted JSON payloads, not downloaded artifact members.
- `source/`, `static/`, `metadata/`, and `closure/` under their respective sections retain exact sources, static review, API observations and closure proof.

This archive's original-log reads are dispatcher1, package1, Mac22=1 and Mac18=1; Node22-unit original logs=0. Artifact ZIP reads=0, workflow reruns=0, extraction VMs=0 and owned active VMs=0. All owned controller/formal jobs are terminal. The earlier macOS diagnostics are preserved under ancestor commit2064a578 and the `macos-inprocess-diagnostic-20261110` evidence directory.
