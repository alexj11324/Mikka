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
Two can be linked to a merged source and its rejection interval. In this baseline,
the successful merge-to-staging and merge-to-production denominators are **zero**;
those durations are unavailable, not zero seconds. Later observations below
separately record real service staging/HTTP smoke completion, a failed session
phase and automatic pipeline rejections. A partial phase or the release owner's
already-serving version is not relabelled as full acceptance of a new head.

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
| Automatic runtime producer emits `workflow_run`, but three consumers admit only older event types | Repair eight existing event checks in #2995; preserve fixed workflow identity, repository/source/attempt/receipt checks and pre-credential revalidation |
| Runtime publication history recognizes the retired `subscriptions` job and equates workflow head with published source | #3000 repairs the existing reader and shared artifact binding: real historical ZIP/source counterexample, original Node RED and independent61/61 GREEN; exact protected CI/merge remain pending. No paid rebuild is triggered for measurement |

Seven original job logs underlying the typecheck comparison are in
[2984-typecheck-assessment.json](2984-typecheck-assessment.json). Identical command
spelling across different environments is not sufficient evidence of duplicate
validation. Existing image reuse remains the single supported build reuse path.

### Measured changes

| Repair | Before | After and limits |
| --- | --- | --- |
| Analytics, #2986 | Two extra summary jobs delayed their result by 489 s and 587 s, including 485/584 s queue and 4/3 s execution | Exact PR run `44821499188/1`, real job `136586911631`, completed build/SSR/Chromium checks; no second summary job exists. Its extra allocation and serial wait are zero. Other CI jobs can still determine total completion time |
| Site search, #2993 | Run `44806487915/1`, job `136531732826`, contains two typecheck calls. First typecheck-to-lint markers span 42.465 s | Initial run `44823370556/1` has one full typecheck and8/8 HTTP cases. Final integrated run `44826359781/1`, job `136599858303`, independently passes one full typecheck and8/8 HTTP cases with two PG17 services: queue81 s, execution506 s, build330 s, HTTP25 s. Initial after execution374 s versus before485 s; changed sources/Node versions prevent causal whole-job speedup claims |
| Bootstrap, #2987 | Real helper-only change alters canonical migration execution identity while the second cache stamp remains identical; original regression fails | Original setup is called every time. Exact merged PG17 cold 4.162715 s (n=1), warm 1.627864/1.851708 s (n=2); same 396 ledger rows and timestamps, 368 tables, zero users; 11/11 original DB tests |
| Attempt timing, #2988 | `44798376633/2` mixed original creation and retry, reporting 4,737 s wall and 2,640 s initial queue | Correct current-attempt values are 2,611/514 s. In `44791185503/2`, retained 28 s work remains evidence but is excluded from current 165 s runner time. Two real counterexamples establish accounting correctness, not faster execution |

Runtime consumers #2995 added four counterexamples to the existing inline/shared
guard suites: original64 pass/4 fail, corrected68/68, and exact merged68/68 with
zero skips. Original enrolled suites pass200/200 and164/164; their overlapping
coverage is not summed. Negative identity, event-mismatch, stale-source and
attempt cases remain enforced. No model/VM acceptance or wall-time saving is
inferred from those offline contracts.

The original Site logs, source identity and downloaded artifact digest are in
[2984-site-search-after.json](2984-site-search-after.json). The exact integrated
Site observation is retained in the [after evidence](2984-after.json). Original bootstrap
red/green evidence lives in the
[pre-merge receipt](../operations/evidence/2984-local-bootstrap-migrations.json);
the [post-merge receipt](../operations/evidence/2984-bootstrap-postmerge.json)
records a different, actual merged run. Test counts are not added across these
different versions and described as one run.

## B1. Fixed-source local feedback before final CI

The [local-feedback evidence](2984-b1-local-feedback.json) records three real
problems: two independently executed old/new source replays and one original
Owner runtime report. The replays occurred after the historical failures and
repairs. They prove a cheap deterministic entry point existed; they do not
rewrite the original developer chronology or claim that queue differences were
actually saved. The restored Linux computer used Node24.22.3 and the pinned
TypeScript5.9.3 for the original route generator.

| Problem / Owner | Original local entry point and fixed-source result | Native CI and limits |
| --- | --- | --- |
| Generated route source hash, #2973 / #2956 | Original `node apps/api/scripts/generate-routes.mjs --check`: old67199ca7 rejects stale output in0.664650439 s; fixed45144ea3 passes twice in0.631379609/0.714444750 s,395routes/522methods. Generated files and output hashes remain unchanged | Original Site44811835977/1,job136550118390 queued831 s and printed the first error947.0578911 s after creation. Fixed Site44815741395/1 passed, while primaryCI44815741718/1 failed unrelated original contracts. The original batch is unmerged |
| Fixture preload uses the child cwd, #2969 / #2891 | Original preload in`.output/eve`: oldbf605701 reproduces nested-manifest ENOENT in0.032093036 s; fixedd30f6ec4 passes twice in0.035802252/0.034687927 s. Original guard/proxy/bundle suites pass6/6 at old source and7/7 at new source | Minimal explicitly synthetic manifest only. DB/LiteLLM URLs are parsed, not connected; original proxy tests use isolated loopback fixtures. No actual Eve/productHTTP/UI journey is claimed. The original Draft remains unmerged and itsCI44833174357/1 selector failed |
| Empty native sessions.create body, #2996 / #2869 | [Original Owner report](https://github.com/aspectly-labs/Mikka/pull/2996#issuecomment-7052767951) binds09e694c3 to LinuxNode24/PG17/loopback-model execution: zero-byte creation, first text, Stop1.748 s, and a separate request settling13synthetic microdollars once | PRCI44831511577/1 failed a port-in-use case; failed-job retry/2 passed at the same source. Normal merge9bbe245ca19d4ac3863cfc75dd47d072ebba1d33 has mainCI44834869958/1 failure from old Draft-policy documentation/test contracts. Original localRED command/duration and a complete rawHTTP receipt are unknown; no independent rerun or exact merged runtime pass is invented |

The replay denominator is two problems, each with one RED and two GREEN
invocations, plus two original test-suite runs. Complete UI→API→DB→new-browser
readback remains zero. Synthetic manifests were removed; four fixed-source
worktrees retained unchanged tracked files. Original commands, exits, UTC
boundaries, source/tree/blob hashes, sample denominators and full limitations
are retained in the JSON.

The refreshed main also exposed three genuine test-integration failures after
accepted#2998 added a Draft rejection step and explicit PR event types. On
this documentation branch's66fa2b9235784e26656ed293d0842d7a3578aca2 tree,
the three original entries actually run51 tests:48pass/3fail/0skip in
11.153068534 s. The failing tests assume an exact old trigger string, use
`steps[0]` for the final Analytics gate, or take the first`run` block as the
final selected-work gate. They now select the deliberate Draft rejection step.
Missing-dependency attempts are separately recorded and do not count as that
51-case RED. The Ready phrase is present in this PR's existing procedure;
this does not erase the failures observed at an earlier main.

A fresh ownership check found that original [PR#2994](https://github.com/aspectly-labs/Mikka/pull/2994)
head40571ce6c780d4044f3c664099e060c857085879 already repairs those same three
locators/contracts, preserving the negative result matrix and explicitly
checking Draft refusal. No parallel fix or copied unmerged Owner code was
made. Original#3001 also updates its own Ready/local-first instructions.
Final integration waits for the original repairs to land normally; queued or
failed current-main checks are not described as green. This dependency does
not complete B1, the fixture journey, or either original product epic.

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
comparison establishes SQL, executor and backfill **code identity**. It cannot
prove backfill business safety or results, inspect the historical database
ledger, or infer a database's actual pending set. See the
[single build/release contract](../operations/build-source-of-truth.md).

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
success do not complete Cloud #418. The available connector has no workflow
dispatch operation and the CLI has no authenticated session. The secure browser
login request was aborted by the user. No new login request, borrowed token,
new trigger, source substitution or permission change bypasses that boundary.
The original protected qualification, normal merge and exact merged validation
remain required.

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
contains the original fixed source, root cause and reproduction. Fresh readback
of the Owner's later head `d30f6ec4a4a1b66278587442e7fd91676ab2f709` finds the
preload now resolves its root from `import.meta.url`, independent of child cwd.
That is an original-owner code correction, still on the unmerged Draft at this
observation. It has not been relabelled as a new runtime or browser pass; the
old failure remains attached to its old source. The B1 replay above verifies the repaired preload against a minimal synthetic
manifest. It does not move/copy an actual build manifest as a startup workaround,
remove preload, change the readiness budget or take over that branch.

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

The separate Site search post-merge run at `128cf2776e1d00c664ac7c3e5b3dc0b78a0aea87`
passed the original optimization suite9/9 and both PG17 setup commands. Its
subsequent full build/HTTP execution was blocked by automatic approval review
after an HTTPS request to `ai-gateway.vercel.sh`. That run was not retried or
resumed and is not recorded as successful build or HTTP acceptance. Read-only
inspection of pinned Eve1.0.0-rc.9 identifies a build-time public catalog
`GET /v1/models/catalog`, with no explicit body, authorization or cookie; static
code does not prove the exact rejected request. The observed execution namespace
contains no matching live wrapper or PG process, but retained PID files and a
missing finally/stop receipt prevent a claim of orderly shutdown. The
[partial post-merge receipt](2984-site-search-postmerge.json) preserves these
limits alongside the independently successful real GitHub Site job.

The shared execution environment subsequently became unavailable. Uncommitted
documentation patches were recovered against their original remote files using
the authorized GitHub interface; existing branches, PRs and the single ledger
were retained. The supplied Docker fallback was searched in available tools and
the plugin directory; no callable Docker entry was returned. No paid substitute,
new CI workflow or test-result simulation was introduced. The existing cloud computer was later restored with a fresh filesystem. The
original pushed branches were recovered through Git and normally integrated
with main; new local results above are separately source-bound. The same public
repository ID1427517699 is now`aspectly-labs/Mikka`. Historical receipt URLs
are preserved. No new identity or permission grant was required to resume
standard GitHub code writes.

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
| [#2993](https://github.com/alexj11324/Mikka/pull/2993) | `128cf2776e1d00c664ac7c3e5b3dc0b78a0aea87` | Exact merged9/9 optimization; actual tree `7d191de777d02d601b71b18b42f46050f6093312` equals successfully tested synthetic integration `67131743edad025e929babca836d35e4d20c270a`; full local post-merge build/HTTP blocked as recorded above, not passed |
| [#2995](https://github.com/alexj11324/Mikka/pull/2995) | `ee36d52f3ee391ddd529f1135ff86fa8f55bd99d` | Exact merged68/68 focused guard contracts,0skip,6.674282523 s; all nine changed blobs equal reviewed `9731a9bc279b40be0b1ddfd2e83a7bb74fed2d90`; parents128cf277+9731a9bc |

Detailed current-head runs, Ready events, merge parents and post-merge runs are
in [2984-after.json](2984-after.json), with the root's independent
[Analytics merged-version receipt](2984-analytics-postmerge.json) and
[runtime-consumer merged-version receipt](2984-runtime-consumers-postmerge.json).

| Delivered PR | Ready to merge | Ready to last applicable CI completion | Remaining interval |
| --- | ---: | ---: | ---: |
| #2988 |947 s|751 s|196 s|
| #2987 |1371 s|1179 s|192 s|
| #2986 |1519 s|1319 s|200 s|
| #2993 |3329 s|2974 s|355 s|
| #2995 |540 s|89 s|451 s|

Each row is n=1, with original Ready/merge/check timestamps retained. The API
does not explain the final interval, so it is not attributed to human approval.
The different pre/post PRs do not establish a project-wide speedup. Exact merged
main CI completed for603d (`44824191022/1`),8cdd (`44825168243/1`) and040
(`44825529454/1`),1952/2091/2277 seconds after their respective merges.
The exact128 main CI `44831162195/1` completed its last job at22:56:23Z,
827 seconds after merge; ee36 main CI `44832752510/1` completed its last
job at23:05:26Z,648 seconds after merge. These five observed post-merge CI
intervals are not staging/production acceptance measurements.

Actual release observations preserve phase boundaries:

- Original Owner manual `44829080930/1`, job136609101593, ran the later workflow
  head040 but deployed source603d. Its stage-all completed at
  `2026-11-20T22:34:07.762734Z`,2474.762734 seconds after that source merged (n=1).
  Actual API and Web smoke each passed20 HTTP200 samples with zero failures.
  There is no uploaded artifact for this phase; the original job/log is the
  evidence. Later stage-sessions44830107947 failed `EVE_STAGE_FIXTURES`.
- Original automatic pipeline44829416787 for8cdd was superseded. Automatic
  44829567603/1 for040 passed migration admission, then failed the original
  `existing-resources` stage. Its digest-verified artifact records no staging
  acceptance or production promotion.
- Exact128 producer44831162043/1 successfully reused all six existing service
  contexts and published release-manifest artifact14677660031. This is six reused
  inputs, not six new builds or a deployment. Its automatic consumer44831644045
  failed during read-only candidate/baseline selection
  (`pipeline_selection_failed`), before a writer; no unique predicate is
  inferred from the safe error code.

The ee36 service producer `44832752350/1` also succeeded, while its automatic
deployment `44833144472/1` rejected read-only selection before a writer.
Task VM consumer `44832859206/1`, job136621977781, passed initial metadata
authorization but failed its pre-credential live-Web revalidation with
`guard_failed`; E2B key, VM and subscription steps did not execute. No unique
underlying predicate is inferred from that safe error code.

Complete staging/session qualification and production acceptance therefore
still have a successful denominator of zero in these observations. The manual
stage-all measurement is retained as its narrower real result.

Before merging, the current #1752/#1954 windows and actual E2B release state
were read. In the current implementation an E2B `push` run only reports/tests
inputs; its `web-ready` and `release` jobs prohibit `push`. That read-only run
does not itself hold an exact-main release window. Accepted
[#2699](https://github.com/alexj11324/Mikka/pull/2699) and the current
`cloudflare-promoted-web.mjs` distinguish initial automatic runtime selection
(served source equals current main and the triggering source) from subsequent
publication checks (the fixed live-serving receipt/source remains valid and
the source remains in main's history). Later unrelated merges do not themselves
void that publication. Explicit #1752/#1954 Owner windows still apply; they are
not replaced by a blanket main freeze inferred from a running E2B workflow.
Individual downstream stale-source refusals retain their original cause and
are not authorization to loosen a guard.

## F. One procedure and remaining acceptance

AGENTS and CONTRIBUTING point to the existing development workflow. The new
decision updates future batching and normal-merge policy; supersession notices
preserve the historical decisions as history. The separately owned #2997/#2998 change merged during execution. Its local-first
and explicitly failing Draft aggregate policy is preserved during normal
integration; neither its implementation nor its performance is attributed to
#2984. The active instructions remove
retired Web/Vercel queue assumptions, false automatic-production-migration
claims, loose-protection advice, the pre-merge production acceptance cycle and
the contradictory squash permission. The current E2B procedure follows accepted
[#2789](https://github.com/alexj11324/Mikka/pull/2789): build-time checks and
conservation/publication receipts remain; the removed live dual-subscription
gate is not reintroduced through documentation. User-owned subscription business
acceptance is a separate fact. The existing operations page
owns build provenance and migration facts. No scheduler, poller, custom status
writer, parallel release process or second account mechanism was added.

Reuse requires the same inputs and surviving prerequisites, under the owning
workflow's existing recovery contract. GitHub's failed-job retry is not a way
to recreate deleted E2B candidates or change a dispatch's original source.
E2B's original cleanup/replacement procedure remains authoritative.

This checkpoint is not closure of #2984. Remaining original-owner dependencies
are the fixture child-start fix and chat acceptance, real staging admission and
production acceptance. This remediation still owns the private #418 exact-head
qualification/merge, completed protected post-merge observations and this
documentation PR's own review/CI/merge. The automatic-E2B event contract repair
is merged and independently verified at its merge source; live publication is
not claimed. The publication-history job/source mismatch is implemented in#3000 at
head275cf937d8de19da2baa761aa3567930b880fe84, with independent61/61 original
Node cases and the actual46376-byte historical ZIP digest verified. Its
[fixed-source evidence](https://github.com/aspectly-labs/Mikka/blob/275cf937d8de19da2baa761aa3567930b880fe84/docs/ci/2984-runtime-reuse.json)
keeps original metadata, closed-adapter transport and true archive-byte checks
separate. It still requires protectedCI, normal merge and exact merged-source
verification. Remaining repository-transfer consumer boundaries are being
checked against existing Owner work; no unverified fleet-wide recovery is claimed. The live progress comment tracks these without
creating a second issue ledger.
