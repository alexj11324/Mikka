# SDLC remediation evidence for #2984

This report records observed engineering results, with the original run,
attempt, source and sample denominator. The live execution record remains the
single [#2984 progress comment](https://github.com/alexj11324/Mikka/issues/2984#issuecomment-7050779093).
The operating procedure is [development workflow § 5](../dev-workflow.md#5-ownership-and-merging),
with its [delivery decision](../design/decisions/2026-11-20-1640-sdlc-delivery.md).
This document is evidence, not another validation system or release authority.

## Scope and measurement boundaries

The baseline was refreshed from GitHub on 2026-11-20, rather than taking an old
issue SHA as current main. Its detailed capture time, original URLs and all
sampled job timestamps are in [2984-baseline.json](2984-baseline.json).

| Repository | Examined scope | Necessary exclusions and existing owner |
| --- | --- | --- |
| Public Mikka | Main `c5a5871d3e4c471005c3f4f02eaadae6db27b052` at baseline; 54 workflows, 113 job templates; PRs, source/build declarations, local bootstrap, CI tools and active engineering instructions | Product changes under #2891/#2912/#2956 and deployments under #2897/#1954 retain their owners |
| Private hosted UI | Exact current main verified; 27 open PRs, no repository workflow files; paired official builds and actual chat acceptance inspected | No private UI implementation copied, no independent builder introduced; chat/slot/permission changes remain #2912-owned |
| Private Cloud | Exact current main verified; 14 workflows, 24 job templates; source pins, operations qualification, migration admission and original release receipts | Provider credentials, live databases, deployment, cutover and rollback remain original operations owners; full private source identities stay in the private PR/evidence |

The later inventory snapshot contains 59 public, 27 UI and 6 Cloud open PRs,
including PRs opened by this remediation. The earlier 54/27/5 counts are a
different snapshot, not a changed denominator for the CI measurements.

Five public PR heads were selected to cover four active owner epics and a
recent merged delivery. This is a purposive sample, not an estimate of fleet
percentiles. It contains 51 workflow runs and 210 job records; the five primary
CI attempts contain 113 job records, of which 101 executed and 12 were skipped.
Ten original checkout logs bind both the source-check and first-feedback jobs
to their actual synthetic merge commit. `run.head_sha` alone is not presented
as the code checked out by a default PR checkout.

First effective feedback means the first completed job with real source,
protocol, kernel, browser or unit assertions, measured from the first workflow
creation for that head. It excludes the Browser gate echo, classification-only
work and skipped/cancelled jobs. Git push receipt time is unavailable, so this
is not called push-to-feedback latency.

Job queue is `started_at - created_at`; execution is
`completed_at - started_at`. Dependency delay before job creation is separate.
CI wall time is the last job completion minus attempt creation. Parallel job
queues and runner time are never summed and described as elapsed wall time.

## A. Observed delivery baseline

All rows below use attempt 1. Full source SHAs, every job and original timestamps
are retained in the [baseline](2984-baseline.json).

| PR / head prefix | First effective feedback | Feedback run / job | Primary CI run | Initial CI queue | CI wall | Total executed runner time |
| --- | ---: | --- | --- | ---: | ---: | ---: |
| [#2963](https://github.com/alexj11324/Mikka/pull/2963) / `16bee4e2` | 235 s | `44808625868` / `136539083293` | `44808626178` | 827 s | 4,759 s | 6,056 s |
| [#2898](https://github.com/alexj11324/Mikka/pull/2898) / `08a3f37b` | 563 s | `44807427231` / `136534980755` | `44807428185` | 632 s | 4,475 s | 5,958 s |
| [#2917](https://github.com/alexj11324/Mikka/pull/2917) / `0cf4150b` | 151 s | `44799819215` / `136508730071` | `44799819020` | 59 s | 2,205 s | 5,887 s |
| [#2958](https://github.com/alexj11324/Mikka/pull/2958) / `b18c3246` | 507 s | `44806487707` / `136531732160` | `44806487898` | 539 s | 3,872 s | 6,030 s |
| [#2905](https://github.com/alexj11324/Mikka/pull/2905) / `312d307c` | 24 s | `44769779067` / `136404000083` | `44769778347` | 5 s | 1,572 s | 7,545 s |

The feedback jobs actually executed 12 kernel ingress cases, 204 offline
release contracts, 73 source/provenance tests, or scoped runtime/real Chromium
checks as recorded per row. These are useful CI feedback, not chat E2E passes.
Actions success for #2898 also does not erase its separate failed GitGuardian
check. That original Owner retains the security finding.

The branch-history sample covers all 241 returned runs across four selected
branches: 130 success, 62 skipped, 36 cancelled and 13 failures. Original failed
job logs identify five root-cause groups:

| Failure group | Failed runs | Stage and disposition |
| --- | ---: | --- |
| New fake imports omitted from declared service input closure | 5 | Credential-free source contract; #2891/#2963 repaired the declarations; retain the guard |
| Registration assertion omitted the new API version header | 3 | Node compatibility; original #2897 owner reconciled the expected transport contract |
| Archived release fixture unused-variable warnings | 1 | Source lint; original #2897 owner repaired the scope; do not disable deny-warnings |
| Old thread-screen test double omitted the transcript slot | 1 | Core unit tests; #2912 fixed its fixture without lowering title or idle-budget assertions |
| Settings writer's dynamic import broke Eve's authored-module bundle | 3 | Build in three workflows; #2956 fixed one shared cause, not three independent failures |

The baseline links every failed run, head and relevant original fix. Different
commits are not represented as retries of identical inputs. No failure was
rerun repeatedly until it happened to pass.

Seven lifecycle records were examined. Of three merged PRs, two have explicit
Ready events: public #2905 took 6,085 seconds, private UI #257 took 1,480 seconds.
Private Cloud #413 has no observed Ready event, so its Ready-to-Merge interval
is null. Two open Ready PRs are right-censored; two Drafts have never become
Ready. Commit age and `updated_at` do not replace the missing event.

Four original staging artifacts were downloaded and their digests verified.
All four rejected admission; none proves accepted staging or production.
Two can be linked to a merged source and its rejection interval. The denominator
for successful merge-to-staging and merge-to-production measurements is **zero**,
so those durations remain unavailable, not zero seconds. The original release
owner's already-serving version is not relabelled as acceptance of these heads.

## B. Necessary work versus removable duplication

The [54-workflow assessment](2984-baseline.json) classifies every public workflow
in the baseline. Fifty-two retain a distinct contract or trust boundary. Two
contain the confirmed allocations removed below. This classification does not
declare every command in the repository globally optimal.

| Finding | Decision and evidence |
| --- | --- |
| Analytics regression followed by a separate summary-only runner | Remove the extra allocation in #2986; keep the real build, SSR, Chromium checks and parent required gate |
| Site search runs the same full typecheck before a build that repeats it | Remove only the first invocation in #2993; root/API/frontend checks remain inside the build and failure still blocks HTTP acceptance |
| Similar typechecks across Cloud computer, Site, credential and subagent workflows | Retain: independent jobs have different source selections, runner images, Node versions or runtime contracts; no exact-input equivalence supports reuse |
| Daemon/desktop build plus a typecheck | Retain: its esbuild build is not the full typecheck; different commands establish different facts |
| Six service builds and repeated artifact/source checks | Retain the existing #2897 content-addressed reuse; checks before credentials, before publication and at deployment establish different trust/time boundaries |
| Main/PR/Node 22/Node 24 coverage | Retain supported-version and affected-source contracts; no skipped or stale check is substituted for required coverage |
| Final protected aggregation across multiple selected jobs | Retain the parent gate: it rejects failed/missing selected dependencies. Unlike the removed Analytics summary, it owns a multi-job protection contract |
| Local migration-ready cache beside the migration ledger | Remove the incomplete cache in #2987; use the existing setup runner and ledger |
| Repeated CI timing logic on retries | Correct the existing collector/summary in #2988; no new poller or validator |

Seven original job logs underlying the typecheck comparison are in
[2984-typecheck-assessment.json](2984-typecheck-assessment.json). Identical command
spelling across different environments is not sufficient evidence of duplicate
validation. Existing image reuse remains the single supported build reuse path.

### Measured changes

| Repair | Before | After and limits |
| --- | --- | --- |
| Analytics, #2986 | Two extra summary jobs delayed their result by 489 s and 587 s, including 485/584 s queue and 4/3 s execution | Exact PR run `44821499188/1`, real job `136586911631`, completed build/SSR/Chromium checks; no second summary job exists. Its extra allocation and serial wait are zero. Other CI jobs can still determine total completion time |
| Site search, #2993 | Run `44806487915/1`, job `136531732826`, contains two typecheck calls. First typecheck-to-lint markers span 42.465 s | Run `44823370556/1`, job `136589646398`, has one full typecheck inside build and 8/8 real HTTP checks. Queue 148 s/execution 374 s versus 617/485 s before. n=1 each; Node patch differs, so the total-job difference is not attributed to this change |
| Bootstrap, #2987 | Real helper-only change alters canonical migration execution identity while the second cache stamp remains identical; original regression fails | Original setup is called every time. Exact merged PG17 cold 4.162715 s (n=1), warm 1.627864/1.851708 s (n=2); same 396 ledger rows and timestamps, 368 tables, zero users; 11/11 original DB tests |
| Attempt timing, #2988 | `44798376633/2` mixed original creation and retry, reporting 4,737 s wall and 2,640 s initial queue | Correct current-attempt values are 2,611/514 s. In `44791185503/2`, retained 28 s work remains evidence but is excluded from current 165 s runner time. Two real counterexamples establish accounting correctness, not faster execution |

The original Site logs, source identity and downloaded artifact digest are in
[2984-site-search-after.json](2984-site-search-after.json). Original bootstrap
red/green evidence lives in the
[pre-merge receipt](../operations/evidence/2984-local-bootstrap-migrations.json);
the [post-merge receipt](../operations/evidence/2984-bootstrap-postmerge.json)
records a different, actual merged run. Test counts are not added across these
different versions and described as one run.

## C. Earlier migration diagnosis without deployment authority

The original staging rejection was not merely a pending SQL-file mismatch.
The existing migration identity also includes executor code, imported backfill
helpers, entry points and toolchain. The local bootstrap's separate stamp did
not cover that same boundary, allowing a developer to miss an execution change.

#2987 removes that local false cache. The private
[Cloud #418](https://github.com/alexj11324/mikka-cloud/pull/418) change exposes the
**existing** migration verifier as a read-only, pinned-source CLI. It compares a
candidate with the existing committed bootstrap selection; a published-manifest
environment must still use its original trusted manifest path. It neither
inspects a database nor authorizes deployment. No second migration runner,
publisher, baseline store or credential path is introduced.

The original five facts remain separate: SQL snapshot, execution closure,
backfill behavior, actual historical ledger and actual pending set. Source-only
comparison can establish the first three identities but cannot infer the last
two. See the [single build/release contract](../operations/build-source-of-truth.md).

The fixed-source 514b-to-c5 counterexample rejects
`migration_execution_changed` locally in 6.503 seconds (n=1), with 387→396 SQL
files and 32→34 execution inputs. Its original staging run `44810593322/1`, job
`136545823302`, queued for 698 seconds and rejected 874 seconds after job
creation. These are different environments and workloads: the result demonstrates
an earlier actionable diagnosis, not a causal 867-second CI speedup. The migration
safety rejection is preserved.

The private change passed 13/13 migration contracts and 55/55 related pipeline
contracts. At this checkpoint its exact protected Cloud qualification is still
required. An old successful qualification, including one that legitimately
authorizes an ancestor for existing release operations, is not current-head CI.
The original reader rejects that substitution. Local tests and GitGuardian
success do not complete Cloud #418.

## D. Reproducible environment and real failures

Execution reused an existing Linux cloud computer, isolated worktrees, the
existing pnpm store and PostgreSQL 17. Node 24.22.3 and pinned pnpm 10.34.3 were
recorded. No new paid machine, database branch or production database was used.

The initial root dependency invocation used the system pnpm 11 against a linked
modules directory and failed before tests. A separate offline frozen install
with the repository's pinned pnpm repaired that environment. A broad local
check then reached daemon tests and failed because this execution environment
rejects AF_UNIX socket construction. An independent minimal socket construction
confirmed the capability failure; no application assertion was changed. The
corresponding actual GitHub runner daemon/Node jobs passed at the reviewed heads.

The fixed official fixture from original #2969 was built with its pinned public
source and approved read-only UI overlay. Missing overlay dependencies and the
existing verified FFmpeg package were repaired through their original setup.
The failed complete build remains failed; successful continuation of its
unchanged final packaging stages is recorded separately.

Actual fixture startup exposed a different, deterministic failure. The Eve
child inherits the fixture preload but changes cwd to `.output/eve`. The preload
then resolves `.output/eve/.output/mikka-build.json` and fails. The real version
endpoint returns HTTP 500 until the original 60-second readiness budget expires.
A minimal child invocation reproduces the same missing-file failure without
PostgreSQL or a browser. Original
[#2969 review 5999855363](https://github.com/alexj11324/Mikka/pull/2969#pullrequestreview-5999855363)
contains the fixed source, root cause and reproduction. Its owner retains the fix;
this remediation did not copy a manifest, remove preload or change the budget.

Completed UI→API→DB→new-browser-readback rounds are **0** at this checkpoint.
Two runs of the original seed smoke each passed six scenarios with identical
database snapshots and no duplicate rows, in 1.123749 and 0.867766 seconds.
That proves repeatable seeding, not successful UI acceptance. Full safe evidence,
including cleanup, is in the
[fixture dependency receipt](../operations/evidence/2984-fixture-runtime-dependency.json).

The chat failures also remain distinct. Original #2917 repaired an obsolete
unit-test double that omitted the new transcript slot; real #2913 cold E2E is
2/3 at the refreshed Owner report, with a separate full-title versus 12-character
title contract conflict. The other three original chat scopes remain 0/3.
Their product assertions and private UI changes stay with #2912. Browser gate
success, compilation and screenshots are never counted as those E2E passes.

## E. Independent delivery and exact post-merge evidence

The new policy follows actual dependency edges. Existing #2891's seven Draft
PRs include three explicit stacks. #2956's nine-part batch includes five PRs
based on its registry PR. Those approved batches are preserved. #2912 retains
its paired public/UI source and unfinished real acceptance. #2898's security
failure and #2908's unmet staging admission are concrete blockers, not a reason
to manufacture a new batch of unrelated work.

The independent fixes below use normal merge commits. Their reviewed blobs and
new main parents are verified rather than assuming the final tree equals a
previous PR synthetic merge. Source CI, deployed images, accepted staging and
production promotion remain separate outcomes.

| PR | Actual merge SHA | Exact merged-version proof |
| --- | --- | --- |
| [#2988](https://github.com/alexj11324/Mikka/pull/2988) | `603d1d95f0266827549f858624a872920344034a` | 5/5 original focused timing tests; six reviewed file blobs retained; all 69 files from the intervening original #2991 merge preserved |
| [#2987](https://github.com/alexj11324/Mikka/pull/2987) | `8cddaa7c48c97ce0092c3ea028519fc9d0ff6069` | 2/2 original bootstrap tests, real PG17 cold/warm runs, 11/11 DB tests; four reviewed blobs retained; setup runner unchanged |
| [#2986](https://github.com/alexj11324/Mikka/pull/2986) | `040362591abbcb95d825311e5577bd27caa92b10` | 8/8 original optimization tests, zero skipped; four reviewed file blobs retained; all unrelated first-parent files preserved |
| [#2993](https://github.com/alexj11324/Mikka/pull/2993) | Pending at checkpoint | Real original-head Site acceptance and independent review complete; final applicable CI and exact integration still required |

Detailed current-head runs, Ready events, merge parents and post-merge runs are
in [2984-after.json](2984-after.json), with the root's independent
[Analytics merged-version receipt](2984-analytics-postmerge.json).
#2988's observed Ready-to-Merge duration is 947 seconds (n=1): 751 seconds to
the last applicable CI completion and 196 seconds from there to merge. The API
does not explain the latter interval, so it is not attributed to human approval.
The different pre/post PRs do not establish a project-wide speedup.

Before merging, the current #1752/#1954 windows and actual E2B release state
were read. In the current implementation an E2B `push` run only reports/tests
inputs; its `web-ready` and `release` jobs prohibit `push`. That read-only run
does not itself hold an exact-main release window. A real active publication
or owner-declared window still does. Guard rejections from stale-source
downstream consumers remain failures with their original cause, not release
success or authorization to loosen source guards.

## F. One procedure and remaining acceptance

AGENTS and CONTRIBUTING point to the existing development workflow. The new
decision updates future batching and normal-merge policy; supersession notices
preserve the historical decisions as history. The active instructions remove
retired Web/Vercel queue assumptions, false automatic-production-migration
claims and the contradictory squash permission. The existing operations page
owns build provenance and migration facts. No scheduler, poller, custom status
writer, parallel release process or second account mechanism was added.

Reuse requires the same inputs and surviving prerequisites, under the owning
workflow's existing recovery contract. GitHub's failed-job retry is not a way
to recreate deleted E2B candidates or change a dispatch's original source.
E2B's original cleanup/replacement procedure remains authoritative.

This checkpoint is not closure of #2984. Remaining original-owner dependencies
are the fixture child-start fix and chat acceptance, real staging admission and
production acceptance. This remediation still owns the private #418 exact-head
qualification/merge, the final Site integration, completed protected post-merge
observations and this documentation PR's own review/CI/merge. A newly identified
automatic-E2B consumer event incompatibility is under ownership and security
review; it is not dismissed because earlier repairs have merged. The live
progress comment tracks these without creating a second issue ledger.
