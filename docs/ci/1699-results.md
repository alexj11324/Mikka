# Incremental CI evidence (#1699)

Nx Core 24.0.5 is merged in [#1702](https://github.com/alexj11324/Mikka/pull/1702),
commit `3c32675c99d32f9c84a9b5e4bc48e59231baa4d8`. Five actual synthetic PR
scenarios passed using the trusted main selector. **The 5-minute p50 / 10-minute
p95 direction is not met.** Task and runner consumption fell substantially in
several scenarios, while queueing and required Desktop acceptance remain material.
No browser E2E was added/restored, Nx Cloud enabled, paid resource created, or
security/release gate weakened.

## Method and limits

Collected from the GitHub Actions runs/jobs API on 2026-11-08 UTC using
`node scripts/ci/timings.mjs <run IDs>`. Wall time is last active job completion
minus workflow creation, including queueing. Runner-minutes sum active job
durations including setup/teardown; they are not billed cost and do not include
OS multipliers. First runner queue is separate; subsequent job queues remain
in wall time. Parallel job walls are never added to represent PR waiting.

The five after PRs started together from the same merged main at 02:35 UTC,
on shared public GitHub runners, alongside other repository CI. Except for a
separately recorded deliberate DB fault, they add harmless comments to the
paths below. They were closed without merging, and their remote branches removed.
Before samples are successful historical PRs, with different patches, dependency
sets, runner images and queue load; these are scenario comparisons, not identical
paired counterfactuals or a stable service SLO. Failed/cancelled/superseded runs
are excluded from successful percentiles. Five-sample p95 uses nearest rank
(the maximum); p50 uses the same convention. External GitGuardian timing is
not included in Actions runner totals.

## Five measured scenarios

The CI-only table preserves the original workflow boundary. Before, Desktop,
Docker and Analytics ran separately; after, selected specialties are inside CI.
Use the following all-PR table for the broader resource/wait comparison.

| Scenario | Before CI | After CI | Wall seconds | First queue seconds | Runner-minutes |
| --- | --- | --- | ---: | ---: | ---: |
| mobile | [42421455904](https://github.com/alexj11324/Mikka/actions/runs/42421455904) | [42439194866](https://github.com/alexj11324/Mikka/actions/runs/42439194866) | 1184 → 507 | 324 → 192 | 34.08 → 6.72 |
| web | [42424234483](https://github.com/alexj11324/Mikka/actions/runs/42424234483) | [42439196351](https://github.com/alexj11324/Mikka/actions/runs/42439196351) | 980 → 1720 | 119 → 24 | 39.75 → 32.48 |
| daemon | [42429196573](https://github.com/alexj11324/Mikka/actions/runs/42429196573) | [42439198782](https://github.com/alexj11324/Mikka/actions/runs/42439198782) | 855 → 1984 | 274 → 241 | 36.05 → 34.83 |
| database | [42418130484](https://github.com/alexj11324/Mikka/actions/runs/42418130484) | [42439816990](https://github.com/alexj11324/Mikka/actions/runs/42439816990) | 646 → 672 | 54 → 260 | 37.65 → 9.00 |
| docs | [42427614962](https://github.com/alexj11324/Mikka/actions/runs/42427614962) | [42439201513](https://github.com/alexj11324/Mikka/actions/runs/42439201513) | 535 → 373 | 210 → 133 | 0.28 → 1.10 |

All-PR totals include **every pull_request Actions workflow on the exact
source head**: min workflow creation to max active job completion, and summed
runner-minutes once per job. This includes unchanged auxiliary workflows such
as Node 22/SSH/community settings evidence; specialty jobs nested in CI are not
double-counted. Raw run membership and SHA receipts appear below.

| Scenario / synthetic PR | Before all-PR wall s | After all-PR wall s | Before runner-min | After runner-min |
| --- | ---: | ---: | ---: | ---: |
| mobile / [#1706](https://github.com/alexj11324/Mikka/pull/1706) | 1185 | 507 | 55.62 | 9.32 |
| web / [#1707](https://github.com/alexj11324/Mikka/pull/1707) | 1627 | 1720 | 85.27 | 34.10 |
| daemon / [#1708](https://github.com/alexj11324/Mikka/pull/1708) | 855 | 1984 | 81.28 | 64.63 |
| database / [#1709](https://github.com/alexj11324/Mikka/pull/1709) | 909 | 672 | 57.05 | 9.05 |
| docs / [#1710](https://github.com/alexj11324/Mikka/pull/1710) | 1607 | 373 | 14.83 | 1.13 |

| Sample / boundary | Before p50 / p95 minutes | After p50 / p95 minutes |
| --- | ---: | ---: |
| All five, CI | 14.25 / 19.73 | 11.20 / 33.07 |
| All five, all PR Actions | 19.75 / 27.12 | 11.20 / 33.07 |
| Four non-docs, CI | 14.25 / 19.73 | 11.20 / 33.07 |
| Four non-docs, all PR Actions | 15.15 / 27.12 | 11.20 / 33.07 |

Clean before contexts: Mobile #1685 changes mobile push/layout/tests plus its
README; Web #1679 changes usage UI/slots plus overlay glue and messages;
DB #1663 changes workspace-name source/unit and personal-first DB tests.
Daemon #1698 and docs #1670 are the other references. The original mixed
Factory+package-script, Mobile+workflow, main and CI/config receipts remain in
[1699-baseline.json](1699-baseline.json) and the initial specialty snapshot in
[1699-special-baseline.json](1699-special-baseline.json). The broader seven-class
baseline had no clean successful Protocol-only or Migration-only sample; that
gap is not replaced with guessed numbers. The final supplemental receipts below
include the previously unfinished historical Desktop workflow.

## Selection and execution reconciliation

Every trusted selection validates the complete 70-suite DB inventory, including
docs. Core/Integration logs were compared by exact `nx run ci-tasks:<target>` set
against the emitted unit IDs. All four non-doc scenarios matched, with
`--skip-nx-cache`; no test success was obtained from result caching.

| Scenario | Changed path | Selected / executed unit commands | DB suites / shards | Selected specialty |
| --- | --- | ---: | ---: | --- |
| mobile | `apps/mobile/lib/theme.ts` | 14 / 14 | 0 / 0 | none |
| web | `components/settings/settings-view.tsx` | 16 / 16 | 0 / 0 | desktop |
| daemon | `packages/daemon/src/adapters/codex.ts` | 18 / 18 | 8 / 1 | daemon, desktop |
| database | `lib/factory/check-independence.db.test.ts` | 14 / 14 | 6 / 1 | none |
| docs | `docs/ci/1699-results.md` | 0 / 0 | 0 / 0 | none |

Mobile selects its affected unit consumers and mandatory policies, with no DB,
Daemon, Desktop, Docker or Analytics. Web reaches Desktop through workspace
settings; Daemon's adapter reaches its package/runtime consumers and Desktop.
These real downstream checks are retained. DB after is an enrolled Factory test
change, not a claim that every Factory/API source change selects only six suites.
For example, Factory store currently reaches 63/70 suites, including account
teardown through thread-machines; that conservative dependency is not pruned to
hit a timing target. Config/lockfile/Protocol/security/schema/migration/unknown,
deletion/rename/mode changes and invalid graphs expand/full-cover as documented
in [incremental.md](incremental.md). Positive/negative trust and scope regressions
cover fork PR, main, merge_group, empty inputs, poison candidate plugin, glob,
aliases and unselected inventory corruption. The final workflow change itself
requires full validation.

The actual Daemon eight-suite and DB six-suite runs each matched their selection
and finished with zero fail/cancelled/skipped/todo for every suite. PG17 clones,
template-bound approved-writes, bootstrap, TAP summary checks and inventory are
preserved. Daemon used seven clones plus the template-bound suite; DB used five
clones plus its template-bound suite. Full/shadow implementation PR CI
[42437038362](https://github.com/alexj11324/Mikka/actions/runs/42437038362) passed
all four PG17 shards and all selected specialties at head `25e50ba1`; merged-main
CI [42439132838](https://github.com/alexj11324/Mikka/actions/runs/42439132838)
also passed (456s, 33.62 runner-min). Local pinned-runtime pnpm check passed;
72 focused regression tests, actionlint, lint and typecheck passed.

## Required-gate failure proof

Temporary DB PR #1709 first used head
`5c4215a2259d83fe9b0856dff30060db1a5f5c5d` with a deliberate top-level
`ISSUE_1699_SELECTED_DB_FAILURE_PROBE` throw in its selected Factory DB test.
[Run 42439200091](https://github.com/alexj11324/Mikka/actions/runs/42439200091)
completed **failure**: [PG17 job 128605107768](https://github.com/alexj11324/Mikka/actions/runs/42439200091/job/128605107768)
logged that exact marker; the historically required
[Production build and browser interactions](https://github.com/alexj11324/Mikka/actions/runs/42439200091/job/128605696576)
logged `DB_RESULT=failure` and exited 1. Source, Core, Integration and UI policy
passed, isolating the selected DB failure. The throw was removed and restored
head `732f6482484108d0c52436ef8dff4e4e4a5c75c9` passed the measured run.
The failed run is not a performance success sample. These DB job names do not
mean browser E2E ran.

The PR was BLOCKED and Draft. Branch Protection API access returned 403, so no
claim is made about reading/changing the settings or attempting a real merge of
the failing branch. Stable gate names plus GitGuardian were observed on the PRs;
selected failure/skip/cancel behavior is also regression-tested. OIDC and exact
source/release pairing are unchanged.

That fault found a timing-only defect: after the gate assertion failed, default
success-only checkout was skipped, so the always-run timing step lacked its
script. The closing patch includes the two `always()` checkout conditions from
[#1713](https://github.com/alexj11324/Mikka/pull/1713). Gate assertions remain
unchanged and red on failure. Its separate in-flight CI is superseded by the
combined closing PR's full latest-head CI; it is not counted as performance
acceptance.

## Remaining bottlenecks and next data

- mobile: first queue 192s; longest job `Source checks` 166s.
- web: first queue 24s; longest job `desktop-checks / Apple Silicon packaged acceptance and ad-hoc Mikka Dev` 1042s.
- daemon: first queue 241s; longest job `desktop-checks / Apple Silicon packaged acceptance and ad-hoc Mikka Dev` 748s.
- database: first queue 260s; longest job `Source checks` 182s.
- docs: first queue 133s; longest job `changes / Changed files` 50s.

## Recorded job and install timings

The table includes active jobs in each primary CI run, including all setup/teardown. Install seconds sum explicitly named pnpm/dependency install steps; `—` means no separately named install step (the trusted selector bundles installation and classification). Detailed historical steps also remain in the baseline JSON.

| Phase / scenario | Job | Job seconds | Named dependency install seconds |
| --- | --- | ---: | ---: |
| before / mobile | Changed files | 13 | — |
| before / mobile | Integration unit checks | 402 | 55 |
| before / mobile | Source checks | 169 | 40 |
| before / mobile | Database checks (1/4) | 216 | 49 |
| before / mobile | Database checks (2/4) | 230 | 48 |
| before / mobile | Daemon checks | 161 | 43 |
| before / mobile | Core unit checks | 426 | 52 |
| before / mobile | Database checks (3/4) | 209 | 39 |
| before / mobile | Database checks (4/4) | 213 | 46 |
| before / mobile | Production build and browser interactions | 3 | — |
| before / mobile | UI policy (strict) | 3 | — |
| after / mobile | changes / Changed files | 41 | — |
| after / mobile | Core unit checks | 101 | 52 |
| after / mobile | Integration unit checks | 78 | 60 |
| after / mobile | Source checks | 166 | 52 |
| after / mobile | Production build and browser interactions | 9 | — |
| after / mobile | UI policy (strict) | 8 | — |
| before / web | Changed files | 13 | — |
| before / web | Source checks | 167 | 50 |
| before / web | Integration unit checks | 426 | 41 |
| before / web | Database checks (2/4) | 236 | 43 |
| before / web | Database checks (4/4) | 230 | 69 |
| before / web | Core unit checks | 503 | 37 |
| before / web | Daemon checks | 215 | 48 |
| before / web | Database checks (3/4) | 299 | 61 |
| before / web | Database checks (1/4) | 291 | 49 |
| before / web | Production build and browser interactions | 2 | — |
| before / web | UI policy (strict) | 3 | — |
| after / web | changes / Changed files | 60 | — |
| after / web | Core unit checks | 211 | 45 |
| after / web | Source checks | 131 | 41 |
| after / web | Integration unit checks | 60 | 39 |
| after / web | Production build and browser interactions | 6 | — |
| after / web | desktop-checks / changes / Changed files | 48 | — |
| after / web | desktop-checks / checks | 138 | 34 |
| after / web | desktop-checks / icon | 22 | — |
| after / web | desktop-checks / smoke | 223 | 47 |
| after / web | desktop-checks / Apple Silicon packaged acceptance and ad-hoc Mikka Dev | 1042 | 155 |
| after / web | UI policy (strict) | 8 | — |
| before / daemon | Changed files | 15 | — |
| before / daemon | Core unit checks | 468 | 57 |
| before / daemon | Daemon checks | 193 | 40 |
| before / daemon | Integration unit checks | 422 | 50 |
| before / daemon | Database checks (1/4) | 265 | 57 |
| before / daemon | Database checks (4/4) | 186 | 43 |
| before / daemon | Source checks | 151 | 49 |
| before / daemon | Database checks (3/4) | 225 | 44 |
| before / daemon | Database checks (2/4) | 233 | 51 |
| before / daemon | Production build and browser interactions | 3 | — |
| before / daemon | UI policy (strict) | 2 | — |
| after / daemon | changes / Changed files | 43 | — |
| after / daemon | Daemon checks | 221 | 45 |
| after / daemon | Integration unit checks | 95 | 44 |
| after / daemon | Source checks | 188 | 40 |
| after / daemon | Database checks (1/1) | 222 | 59 |
| after / daemon | Core unit checks | 127 | 48 |
| after / daemon | desktop-checks / changes / Changed files | 39 | — |
| after / daemon | desktop-checks / checks | 114 | 15 |
| after / daemon | desktop-checks / icon | 22 | — |
| after / daemon | desktop-checks / smoke | 256 | 33 |
| after / daemon | Production build and browser interactions | 7 | — |
| after / daemon | desktop-checks / Apple Silicon packaged acceptance and ad-hoc Mikka Dev | 748 | 71 |
| after / daemon | UI policy (strict) | 8 | — |
| before / database | Changed files | 14 | — |
| before / database | Core unit checks | 501 | 41 |
| before / database | Daemon checks | 158 | 40 |
| before / database | Database checks (2/4) | 194 | 40 |
| before / database | Database checks (4/4) | 201 | 42 |
| before / database | Source checks | 173 | 42 |
| before / database | Database checks (3/4) | 319 | 47 |
| before / database | Database checks (1/4) | 275 | 44 |
| before / database | Integration unit checks | 416 | 37 |
| before / database | Production build and browser interactions | 4 | — |
| before / database | UI policy (strict) | 4 | — |
| after / database | changes / Changed files | 48 | — |
| after / database | Integration unit checks | 90 | 41 |
| after / database | Source checks | 182 | 51 |
| after / database | Database checks (1/1) | 110 | 44 |
| after / database | Core unit checks | 92 | 49 |
| after / database | Production build and browser interactions | 9 | — |
| after / database | UI policy (strict) | 9 | — |
| before / docs | Changed files | 12 | — |
| before / docs | UI policy (strict) | 2 | — |
| before / docs | Production build and browser interactions | 3 | — |
| after / docs | changes / Changed files | 50 | — |
| after / docs | UI policy (strict) | 8 | — |
| after / docs | Production build and browser interactions | 8 | — |

Native Desktop includes dependency installation, a production ARM64 API build,
packaging, real Keychain/native acceptance and cache teardown. Web/Daemon's
transitive Desktop coverage, inter-job queues, repeated dependency setup and
unconditional source policies dominate their wall time after unit reduction.
In the DB probe the PG17 job was 110s and its slowest selected Suite 16.4s;
first queue alone was 260s. In docs the total 373s included 133s first queue and
additional aggregate-job queue delays. Adding concurrent job durations would
hide these bottlenecks.

Next measurements should use a longer sequential real-PR cohort to separate
normal queue load from this concurrent synthetic batch, then profile repeated
trusted-selector/dependency setup and Desktop teardown/build steps. Evaluate
deduplicated installs and narrowly scoped deterministic build artifacts against
exact source/lock/runtime keys, with untrusted PR writes excluded from privileged
release consumption. Any finer Desktop target partition must first prove the
same selected downstream contracts; do not skip native/security gates to report
an apparent p95 win. No such unverified cache or gate reduction is enabled here.

## Production observation and rollback

[Web deploy 42439132695](https://github.com/alexj11324/Mikka/actions/runs/42439132695) succeeded. Vercel `dpl_JD8eA3istpCmCT41n3pWnbkT3bpv` was `READY` for source `3c32675c99d32f9c84a9b5e4bc48e59231baa4d8`. At 2026-11-08T03:06:17.100946+00:00, `https://app.aspectlylabs.com/mikka/api/version` served that exact `build` and overlay `0aef26958544fb9579c4d2b01dd1d34cfa22c051`. Existing E2B release sequencing is observed before the closing merge; final combined-head CI/merge/deploy receipts are recorded on [#1699](https://github.com/alexj11324/Mikka/issues/1699). No production credentials, settings, data or deployment entrypoint were changed.

Reverting #1702 restores the former full execution; reverting the closing
patch restores its previous timing/report behavior. No schema/settings migration
is required. Full workflow_dispatch and weekly full regression remain available.

## Supplemental raw receipts

Each metadata receipt is reproducible from its linked run's runs/jobs endpoints.
Install and individual step durations remain in the collector output/API; the
tables above intentionally include setup/teardown, not just test bodies.

```json
[
{"scope":"before","id":42427615095,"sha":"22ca15d6c2a2ab7c0b1fcfe59b059f8c2d91d87e","attempt":1,"conclusion":"success","created_at":"2026-11-07T23:58:23Z","first_started_at":"2026-11-08T00:00:14Z","last_completed_at":"2026-11-08T00:01:31Z","first_queue_seconds":111,"wall_seconds":188,"runner_minutes":0.2833},
{"scope":"before","id":42427614962,"sha":"22ca15d6c2a2ab7c0b1fcfe59b059f8c2d91d87e","attempt":1,"conclusion":"success","created_at":"2026-11-07T23:58:23Z","first_started_at":"2026-11-08T00:01:53Z","last_completed_at":"2026-11-08T00:07:18Z","first_queue_seconds":210,"wall_seconds":535,"runner_minutes":0.2833},
{"scope":"before","id":42427615152,"sha":"22ca15d6c2a2ab7c0b1fcfe59b059f8c2d91d87e","attempt":1,"conclusion":"success","created_at":"2026-11-07T23:58:23Z","first_started_at":"2026-11-08T00:05:16Z","last_completed_at":"2026-11-08T00:05:18Z","first_queue_seconds":413,"wall_seconds":415,"runner_minutes":0.0333},
{"scope":"before","id":42427614964,"sha":"22ca15d6c2a2ab7c0b1fcfe59b059f8c2d91d87e","attempt":1,"conclusion":"success","created_at":"2026-11-07T23:58:23Z","first_started_at":"2026-11-08T00:10:56Z","last_completed_at":"2026-11-08T00:25:10Z","first_queue_seconds":753,"wall_seconds":1607,"runner_minutes":14.2333},
{"scope":"before","id":42429196566,"sha":"253c2d454264058194b05ce508b6770f9cea593e","attempt":1,"conclusion":"success","created_at":"2026-11-08T00:19:05Z","first_started_at":"2026-11-08T00:20:44Z","last_completed_at":"2026-11-08T00:22:48Z","first_queue_seconds":99,"wall_seconds":223,"runner_minutes":2.0667},
{"scope":"before","id":42429196611,"sha":"253c2d454264058194b05ce508b6770f9cea593e","attempt":1,"conclusion":"success","created_at":"2026-11-08T00:19:05Z","first_started_at":"2026-11-08T00:22:59Z","last_completed_at":"2026-11-08T00:23:11Z","first_queue_seconds":234,"wall_seconds":246,"runner_minutes":0.2},
{"scope":"before","id":42429196581,"sha":"253c2d454264058194b05ce508b6770f9cea593e","attempt":1,"conclusion":"success","created_at":"2026-11-08T00:19:05Z","first_started_at":"2026-11-08T00:23:35Z","last_completed_at":"2026-11-08T00:23:37Z","first_queue_seconds":270,"wall_seconds":272,"runner_minutes":0.0333},
{"scope":"before","id":42429196557,"sha":"253c2d454264058194b05ce508b6770f9cea593e","attempt":1,"conclusion":"success","created_at":"2026-11-08T00:19:05Z","first_started_at":"2026-11-08T00:19:56Z","last_completed_at":"2026-11-08T00:24:34Z","first_queue_seconds":51,"wall_seconds":329,"runner_minutes":4.6333},
{"scope":"before","id":42429196569,"sha":"253c2d454264058194b05ce508b6770f9cea593e","attempt":1,"conclusion":"success","created_at":"2026-11-08T00:19:05Z","first_started_at":"2026-11-08T00:19:14Z","last_completed_at":"2026-11-08T00:24:53Z","first_queue_seconds":9,"wall_seconds":348,"runner_minutes":5.65},
{"scope":"before","id":42429196549,"sha":"253c2d454264058194b05ce508b6770f9cea593e","attempt":1,"conclusion":"success","created_at":"2026-11-08T00:19:05Z","first_started_at":"2026-11-08T00:20:17Z","last_completed_at":"2026-11-08T00:26:03Z","first_queue_seconds":72,"wall_seconds":418,"runner_minutes":3.55},
{"scope":"before","id":42429196560,"sha":"253c2d454264058194b05ce508b6770f9cea593e","attempt":1,"conclusion":"success","created_at":"2026-11-08T00:19:05Z","first_started_at":"2026-11-08T00:20:51Z","last_completed_at":"2026-11-08T00:29:28Z","first_queue_seconds":106,"wall_seconds":623,"runner_minutes":5.0333},
{"scope":"before","id":42429196556,"sha":"253c2d454264058194b05ce508b6770f9cea593e","attempt":1,"conclusion":"success","created_at":"2026-11-08T00:19:05Z","first_started_at":"2026-11-08T00:22:49Z","last_completed_at":"2026-11-08T00:33:14Z","first_queue_seconds":224,"wall_seconds":849,"runner_minutes":11.3167},
{"scope":"before","id":42429196544,"sha":"253c2d454264058194b05ce508b6770f9cea593e","attempt":1,"conclusion":"success","created_at":"2026-11-08T00:19:05Z","first_started_at":"2026-11-08T00:20:23Z","last_completed_at":"2026-11-08T00:33:08Z","first_queue_seconds":78,"wall_seconds":843,"runner_minutes":12.75},
{"scope":"before","id":42429196573,"sha":"253c2d454264058194b05ce508b6770f9cea593e","attempt":1,"conclusion":"success","created_at":"2026-11-08T00:19:05Z","first_started_at":"2026-11-08T00:23:39Z","last_completed_at":"2026-11-08T00:33:20Z","first_queue_seconds":274,"wall_seconds":855,"runner_minutes":36.05},
{"scope":"before","id":42424234492,"sha":"518093a955d79e115445cff5a877700e5e759de7","attempt":1,"conclusion":"success","created_at":"2026-11-07T23:13:08Z","first_started_at":"2026-11-07T23:16:11Z","last_completed_at":"2026-11-07T23:24:40Z","first_queue_seconds":183,"wall_seconds":692,"runner_minutes":4.4333},
{"scope":"before","id":42424234829,"sha":"518093a955d79e115445cff5a877700e5e759de7","attempt":1,"conclusion":"success","created_at":"2026-11-07T23:13:08Z","first_started_at":"2026-11-07T23:15:25Z","last_completed_at":"2026-11-07T23:28:04Z","first_queue_seconds":137,"wall_seconds":896,"runner_minutes":12.65},
{"scope":"before","id":42424234483,"sha":"518093a955d79e115445cff5a877700e5e759de7","attempt":1,"conclusion":"success","created_at":"2026-11-07T23:13:08Z","first_started_at":"2026-11-07T23:15:07Z","last_completed_at":"2026-11-07T23:29:28Z","first_queue_seconds":119,"wall_seconds":980,"runner_minutes":39.75},
{"scope":"before","id":42424234475,"sha":"518093a955d79e115445cff5a877700e5e759de7","attempt":1,"conclusion":"success","created_at":"2026-11-07T23:13:08Z","first_started_at":"2026-11-07T23:14:35Z","last_completed_at":"2026-11-07T23:14:37Z","first_queue_seconds":87,"wall_seconds":89,"runner_minutes":0.0333},
{"scope":"before","id":42424234633,"sha":"518093a955d79e115445cff5a877700e5e759de7","attempt":1,"conclusion":"success","created_at":"2026-11-07T23:13:08Z","first_started_at":"2026-11-07T23:13:40Z","last_completed_at":"2026-11-07T23:15:29Z","first_queue_seconds":32,"wall_seconds":141,"runner_minutes":1.8167},
{"scope":"before","id":42424234470,"sha":"518093a955d79e115445cff5a877700e5e759de7","attempt":1,"conclusion":"success","created_at":"2026-11-07T23:13:08Z","first_started_at":"2026-11-07T23:14:18Z","last_completed_at":"2026-11-07T23:40:15Z","first_queue_seconds":70,"wall_seconds":1627,"runner_minutes":26.5833},
{"scope":"before","id":42418130419,"sha":"dfa13fcc2035637a0a6d27058d60cf76869f9dfe","attempt":1,"conclusion":"success","created_at":"2026-11-07T21:55:16Z","first_started_at":"2026-11-07T21:56:05Z","last_completed_at":"2026-11-07T21:56:08Z","first_queue_seconds":49,"wall_seconds":52,"runner_minutes":0.05},
{"scope":"before","id":42418130405,"sha":"dfa13fcc2035637a0a6d27058d60cf76869f9dfe","attempt":1,"conclusion":"success","created_at":"2026-11-07T21:55:16Z","first_started_at":"2026-11-07T21:56:08Z","last_completed_at":"2026-11-07T22:01:09Z","first_queue_seconds":52,"wall_seconds":353,"runner_minutes":4.9667},
{"scope":"before","id":42418130484,"sha":"dfa13fcc2035637a0a6d27058d60cf76869f9dfe","attempt":1,"conclusion":"success","created_at":"2026-11-07T21:55:16Z","first_started_at":"2026-11-07T21:56:10Z","last_completed_at":"2026-11-07T22:06:02Z","first_queue_seconds":54,"wall_seconds":646,"runner_minutes":37.65},
{"scope":"before","id":42418130485,"sha":"dfa13fcc2035637a0a6d27058d60cf76869f9dfe","attempt":1,"conclusion":"success","created_at":"2026-11-07T21:55:16Z","first_started_at":"2026-11-07T21:56:02Z","last_completed_at":"2026-11-07T22:10:25Z","first_queue_seconds":46,"wall_seconds":909,"runner_minutes":14.3833},
{"scope":"before","id":42421455880,"sha":"47c0d17fcb6311d7f2f5037a988d39422d4b3a83","attempt":1,"conclusion":"success","created_at":"2026-11-07T22:37:09Z","first_started_at":"2026-11-07T22:39:59Z","last_completed_at":"2026-11-07T22:40:02Z","first_queue_seconds":170,"wall_seconds":173,"runner_minutes":0.05},
{"scope":"before","id":42421455904,"sha":"47c0d17fcb6311d7f2f5037a988d39422d4b3a83","attempt":1,"conclusion":"success","created_at":"2026-11-07T22:37:09Z","first_started_at":"2026-11-07T22:42:33Z","last_completed_at":"2026-11-07T22:56:53Z","first_queue_seconds":324,"wall_seconds":1184,"runner_minutes":34.0833},
{"scope":"before","id":42421455747,"sha":"47c0d17fcb6311d7f2f5037a988d39422d4b3a83","attempt":1,"conclusion":"success","created_at":"2026-11-07T22:37:08Z","first_started_at":"2026-11-07T22:40:03Z","last_completed_at":"2026-11-07T22:42:41Z","first_queue_seconds":175,"wall_seconds":333,"runner_minutes":2.6333},
{"scope":"before","id":42421455731,"sha":"47c0d17fcb6311d7f2f5037a988d39422d4b3a83","attempt":1,"conclusion":"success","created_at":"2026-11-07T22:37:08Z","first_started_at":"2026-11-07T22:37:57Z","last_completed_at":"2026-11-07T22:52:16Z","first_queue_seconds":49,"wall_seconds":908,"runner_minutes":14.3167},
{"scope":"before","id":42421455681,"sha":"47c0d17fcb6311d7f2f5037a988d39422d4b3a83","attempt":1,"conclusion":"success","created_at":"2026-11-07T22:37:08Z","first_started_at":"2026-11-07T22:40:46Z","last_completed_at":"2026-11-07T22:53:55Z","first_queue_seconds":218,"wall_seconds":1007,"runner_minutes":4.5333},
{"scope":"after","id":42439194812,"sha":"226782706eb4935574d32d747b5e64ed0c0601db","attempt":1,"conclusion":"success","created_at":"2026-11-08T02:35:27Z","first_started_at":"2026-11-08T02:37:00Z","last_completed_at":"2026-11-08T02:37:03Z","first_queue_seconds":93,"wall_seconds":96,"runner_minutes":0.05},
{"scope":"after","id":42439194813,"sha":"226782706eb4935574d32d747b5e64ed0c0601db","attempt":1,"conclusion":"success","created_at":"2026-11-08T02:35:27Z","first_started_at":"2026-11-08T02:35:48Z","last_completed_at":"2026-11-08T02:38:21Z","first_queue_seconds":21,"wall_seconds":174,"runner_minutes":2.55},
{"scope":"after","id":42439194866,"sha":"226782706eb4935574d32d747b5e64ed0c0601db","attempt":1,"conclusion":"success","created_at":"2026-11-08T02:35:27Z","first_started_at":"2026-11-08T02:38:39Z","last_completed_at":"2026-11-08T02:43:54Z","first_queue_seconds":192,"wall_seconds":507,"runner_minutes":6.7167},
{"scope":"after","id":42439196331,"sha":"172212d7a37fb9906a64cb3e3685221132ee6c7e","attempt":1,"conclusion":"success","created_at":"2026-11-08T02:35:28Z","first_started_at":"2026-11-08T02:35:30Z","last_completed_at":"2026-11-08T02:37:03Z","first_queue_seconds":2,"wall_seconds":95,"runner_minutes":1.55},
{"scope":"after","id":42439196323,"sha":"172212d7a37fb9906a64cb3e3685221132ee6c7e","attempt":1,"conclusion":"success","created_at":"2026-11-08T02:35:28Z","first_started_at":"2026-11-08T02:36:54Z","last_completed_at":"2026-11-08T02:36:58Z","first_queue_seconds":86,"wall_seconds":90,"runner_minutes":0.0667},
{"scope":"after","id":42439196351,"sha":"172212d7a37fb9906a64cb3e3685221132ee6c7e","attempt":1,"conclusion":"success","created_at":"2026-11-08T02:35:28Z","first_started_at":"2026-11-08T02:35:52Z","last_completed_at":"2026-11-08T03:04:08Z","first_queue_seconds":24,"wall_seconds":1720,"runner_minutes":32.4833},
{"scope":"after","id":42439198975,"sha":"81b70c1e7f09e74d3fc289e5ed368759a1dd6eec","attempt":1,"conclusion":"success","created_at":"2026-11-08T02:35:30Z","first_started_at":"2026-11-08T02:38:17Z","last_completed_at":"2026-11-08T02:38:35Z","first_queue_seconds":167,"wall_seconds":185,"runner_minutes":0.3},
{"scope":"after","id":42439198802,"sha":"81b70c1e7f09e74d3fc289e5ed368759a1dd6eec","attempt":1,"conclusion":"success","created_at":"2026-11-08T02:35:30Z","first_started_at":"2026-11-08T02:39:08Z","last_completed_at":"2026-11-08T02:39:10Z","first_queue_seconds":218,"wall_seconds":220,"runner_minutes":0.0333},
{"scope":"after","id":42439198738,"sha":"81b70c1e7f09e74d3fc289e5ed368759a1dd6eec","attempt":1,"conclusion":"success","created_at":"2026-11-08T02:35:30Z","first_started_at":"2026-11-08T02:36:52Z","last_completed_at":"2026-11-08T02:39:26Z","first_queue_seconds":82,"wall_seconds":236,"runner_minutes":2.5667},
{"scope":"after","id":42439198887,"sha":"81b70c1e7f09e74d3fc289e5ed368759a1dd6eec","attempt":1,"conclusion":"success","created_at":"2026-11-08T02:35:30Z","first_started_at":"2026-11-08T02:37:16Z","last_completed_at":"2026-11-08T02:41:02Z","first_queue_seconds":106,"wall_seconds":332,"runner_minutes":3.7667},
{"scope":"after","id":42439198749,"sha":"81b70c1e7f09e74d3fc289e5ed368759a1dd6eec","attempt":1,"conclusion":"success","created_at":"2026-11-08T02:35:30Z","first_started_at":"2026-11-08T02:37:40Z","last_completed_at":"2026-11-08T02:41:51Z","first_queue_seconds":130,"wall_seconds":381,"runner_minutes":3.8},
{"scope":"after","id":42439198855,"sha":"81b70c1e7f09e74d3fc289e5ed368759a1dd6eec","attempt":1,"conclusion":"success","created_at":"2026-11-08T02:35:30Z","first_started_at":"2026-11-08T02:38:22Z","last_completed_at":"2026-11-08T02:43:55Z","first_queue_seconds":172,"wall_seconds":505,"runner_minutes":5.55},
{"scope":"after","id":42439198767,"sha":"81b70c1e7f09e74d3fc289e5ed368759a1dd6eec","attempt":1,"conclusion":"success","created_at":"2026-11-08T02:35:30Z","first_started_at":"2026-11-08T02:38:14Z","last_completed_at":"2026-11-08T02:46:23Z","first_queue_seconds":164,"wall_seconds":653,"runner_minutes":13.7833},
{"scope":"after","id":42439198782,"sha":"81b70c1e7f09e74d3fc289e5ed368759a1dd6eec","attempt":1,"conclusion":"success","created_at":"2026-11-08T02:35:30Z","first_started_at":"2026-11-08T02:39:31Z","last_completed_at":"2026-11-08T03:08:34Z","first_queue_seconds":241,"wall_seconds":1984,"runner_minutes":34.8333},
{"scope":"after","id":42439816990,"sha":"732f6482484108d0c52436ef8dff4e4e4a5c75c9","attempt":1,"conclusion":"success","created_at":"2026-11-08T02:44:44Z","first_started_at":"2026-11-08T02:49:04Z","last_completed_at":"2026-11-08T02:55:56Z","first_queue_seconds":260,"wall_seconds":672,"runner_minutes":9},
{"scope":"after","id":42439817026,"sha":"732f6482484108d0c52436ef8dff4e4e4a5c75c9","attempt":1,"conclusion":"success","created_at":"2026-11-08T02:44:44Z","first_started_at":"2026-11-08T02:46:15Z","last_completed_at":"2026-11-08T02:46:18Z","first_queue_seconds":91,"wall_seconds":94,"runner_minutes":0.05},
{"scope":"after","id":42439201572,"sha":"dfc17701c863efc07c9811e0e47752edb37b8316","attempt":1,"conclusion":"success","created_at":"2026-11-08T02:35:32Z","first_started_at":"2026-11-08T02:38:10Z","last_completed_at":"2026-11-08T02:38:12Z","first_queue_seconds":158,"wall_seconds":160,"runner_minutes":0.0333},
{"scope":"after","id":42439201513,"sha":"dfc17701c863efc07c9811e0e47752edb37b8316","attempt":1,"conclusion":"success","created_at":"2026-11-08T02:35:32Z","first_started_at":"2026-11-08T02:37:45Z","last_completed_at":"2026-11-08T02:41:45Z","first_queue_seconds":133,"wall_seconds":373,"runner_minutes":1.1}
]
```

```json
{
  "membership": [
    {
      "scenario": "mobile",
      "pr": 1706,
      "head": "226782706eb4935574d32d747b5e64ed0c0601db",
      "before_all": {
        "wall_seconds": 1185,
        "runner_minutes": 55.61666666666666,
        "ids": [
          42421455880,
          42421455904,
          42421455747,
          42421455731,
          42421455681
        ]
      },
      "after_all": {
        "wall_seconds": 507,
        "runner_minutes": 9.316666666666668,
        "ids": [
          42439194812,
          42439194813,
          42439194866
        ]
      }
    },
    {
      "scenario": "web",
      "pr": 1707,
      "head": "172212d7a37fb9906a64cb3e3685221132ee6c7e",
      "before_all": {
        "wall_seconds": 1627,
        "runner_minutes": 85.26666666666667,
        "ids": [
          42424234492,
          42424234829,
          42424234483,
          42424234475,
          42424234633,
          42424234470
        ]
      },
      "after_all": {
        "wall_seconds": 1720,
        "runner_minutes": 34.1,
        "ids": [
          42439196331,
          42439196323,
          42439196351
        ]
      }
    },
    {
      "scenario": "daemon",
      "pr": 1708,
      "head": "81b70c1e7f09e74d3fc289e5ed368759a1dd6eec",
      "before_all": {
        "wall_seconds": 855,
        "runner_minutes": 81.28333333333333,
        "ids": [
          42429196566,
          42429196611,
          42429196581,
          42429196557,
          42429196569,
          42429196549,
          42429196560,
          42429196556,
          42429196544,
          42429196573
        ]
      },
      "after_all": {
        "wall_seconds": 1984,
        "runner_minutes": 64.63333333333334,
        "ids": [
          42439198975,
          42439198802,
          42439198738,
          42439198887,
          42439198749,
          42439198855,
          42439198767,
          42439198782
        ]
      }
    },
    {
      "scenario": "database",
      "pr": 1709,
      "head": "732f6482484108d0c52436ef8dff4e4e4a5c75c9",
      "before_all": {
        "wall_seconds": 909,
        "runner_minutes": 57.050000000000004,
        "ids": [
          42418130419,
          42418130405,
          42418130484,
          42418130485
        ]
      },
      "after_all": {
        "wall_seconds": 672,
        "runner_minutes": 9.05,
        "ids": [
          42439816990,
          42439817026
        ]
      }
    },
    {
      "scenario": "docs",
      "pr": 1710,
      "head": "dfc17701c863efc07c9811e0e47752edb37b8316",
      "before_all": {
        "wall_seconds": 1607,
        "runner_minutes": 14.833333333333332,
        "ids": [
          42427615095,
          42427614962,
          42427615152,
          42427614964
        ]
      },
      "after_all": {
        "wall_seconds": 373,
        "runner_minutes": 1.1333333333333335,
        "ids": [
          42439201572,
          42439201513
        ]
      }
    }
  ]
}
```
