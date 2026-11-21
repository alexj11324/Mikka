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
| Private hosted UI | Exact main at baseline capture verified; 27 open PRs, no repository workflow files; paired official builds and actual chat acceptance inspected | No private UI implementation copied, no independent builder introduced; chat/slot/permission changes remain #2912-owned |
| Private Cloud | Exact main at baseline capture verified; 14 workflows, 24 job templates; source pins, operations qualification, migration admission and original release receipts | Provider credentials, live databases, deployment, cutover and rollback remain original operations owners; full private source identities stay in the private PR/evidence |

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

### Integration checkpoint after the repository transfer

On 2026-11-21, this documentation branch normally integrates main
`59b7682fa34f80f402367d2bb40141034c9cf9fd`, the original Owner's #3001 merge.
The ten paths added since ed905 retain #3001's nine local-first paths and
#3006's one native Browser scheduling change, merged earlier as
`1d53f13c5753ef5f75b54e6f886a3b5fa3087733`. The earlier #2994 merge
`ed905baee7482c43b29e8b15480ebbae160278c1` and its 19 changed paths are retained,
including the three repaired CI test locators and isolated Cloudflare source
fixture. Overlapping instructions retain the Owner's Ready procedure and this
PR's dependency-based merge procedure. No unmerged Owner implementation is copied.

The following is a dated result snapshot, not a replacement for the single
issue progress comment. Five public implementation PRs have merged. The
private repair and four later public repairs remain unmerged at this checkpoint;
their local proofs are not final protected CI or release acceptance.

| Finding | Code-delivery state | Source-specific proof and remaining boundary |
| --- | --- | --- |
| SDLC-001 / #2986 Analytics allocation | Merged `040362591abbcb95d825311e5577bd27caa92b10` | Exact focused regression and main CI passed; observed summary allocation removed, no whole-CI speed claim |
| SDLC-002 / #2987 bootstrap cache | Merged `8cddaa7c48c97ce0092c3ea028519fc9d0ff6069` | Exact PG17 and DB regressions passed; unchanged ledger at measured setup cost |
| SDLC-003 / #2988 retry accounting | Merged `603d1d95f0266827549f858624a872920344034a` | Exact five-case regression and main CI passed; two original retry counterexamples |
| SDLC-004 / private Cloud #418 migration preflight | Unmerged; exact head retained in private review | Independent 13/13 migration and 55/55 pipeline cases; existing qualified-ancestor contract applies, but the current-head GitGuardian receipt is missing |
| SDLC-005 / #2993 repeated Site typecheck | Merged `128cf2776e1d00c664ac7c3e5b3dc0b78a0aea87` | Exact optimization and main CI passed; integrated tree has real build/HTTP proof, later local full-build attempt remains blocked |
| SDLC-006 / #2995 producer event admission | Merged `ee36d52f3ee391ddd529f1135ff86fa8f55bd99d` | Exact 68/68 offline contracts and main CI passed; no live publication or product task claimed |
| SDLC-007 / [#3000](https://github.com/aspectly-labs/Mikka/pull/3000) runtime history | Ready, unmerged `8b5de3dacd3771737b0e25974c195deb057817e8` | Nine original reviewed blobs and 19 Owner blobs preserved; integration review [6001494107](https://github.com/aspectly-labs/Mikka/pull/3000#pullrequestreview-6001494107). Primary CI `44846098568/1` succeeds with 19 success/2 skipped jobs. No observed full local `pnpm check` receipt before Ready; GitGuardian and merge remain incomplete |
| SDLC-008 / [#3002](https://github.com/aspectly-labs/Mikka/pull/3002) consumer identity | Ready, unmerged `249e3911f590eb7ead883bb35989ac5524af0fba` | Normal integration includes #3000's reader. Real legacy-API 301 counterexample goes from 16 pass/one fail to 17/17 through the existing immutable-ID API. Primary CI `44848238113/1` succeeds with 19 success/2 skipped jobs; the full local Before Ready receipt and GitGuardian remain unverified |
| SDLC-009 / [#3004](https://github.com/aspectly-labs/Mikka/pull/3004) marketing source admission | Draft, unmerged `290f41490c1a8ef7572b0ec3ce3f071bae5bfd08` | Normal integration of main `59b` retains all four reviewed implementation/test blobs and ten Owner paths. The previous ab7 head's CI `44845965398/1` succeeds with 19 success/2 skipped jobs; it is not current-head CI. Exact290 `local:plan` passes; full local Ready evidence, current CI and GitGuardian remain incomplete. No marketing dispatch/private build/publication sample |
| SDLC-010 / [#3007](https://github.com/aspectly-labs/Mikka/pull/3007) publication consumer contract | Draft, unmerged `070253d0447d76f2bfc87fe0863ccd65f02d9e24` | Original RED is 61 pass/3 fail; repaired original suites pass 198/198 and independent focused suites pass 82/82, with all 16 source/test blobs retained through main `59b` integration. Exact070 full `pnpm check` fails on eight daemon Unix-socket EPERM cases; later stages do not run. [Review6002104989](https://github.com/aspectly-labs/Mikka/pull/3007#pullrequestreview-6002104989) finds no code-integration blocker, while Before Ready remains unmet. Historical archive replay is not new live acceptance |

The first six rows' complete metrics and merge receipts remain below. Later
rows retain their original PR ownership, dependencies and exact-version proof;
they are not included in the five-merge denominator.

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

### Later fixed-head observations for three remediation candidates

The [later candidate sample](2984-final-candidate-ci.json) is separate from the
five-head baseline: three exact heads, 28 workflow runs and 150 attempt job
records. The first-useful result is selected across every returned workflow for
each head and checked against the original job log and actual checkout SHA.

| PR / measured head | First useful feedback | Actual assertion job, run/attempt and job ID | Job queue / execution | Real assertion count |
| --- | ---: | --- | ---: | ---: |
| #3000 / `8b5de3da` | 244 s | Source, `44845931133/1`, `136665494707` | 217 / 26 s | 78/78 |
| #3002 / `249e3911` | 374 s | Local driver Linux Xvfb, `44847445855/1`, `136670541300` | 351 / 23 s | 1/1 |
| #3004 / `ab7fbd7e` | 67 s | Source, `44844895642/1`, `136662067270` | 41 / 26 s | 86/86 |

The actual checked-out synthetic merges are respectively
`401c93aad406da2399449a885fdc0233e74e291f`,
`63c2dfae94aecbabaf0fe82b0e8fd993f3d69266` and
`87d7ca59700d69be2ece8edf5ecbf8c83e714517`.
These source jobs qualify because they execute the recorded real contract
tests. The Linux driver job finishes before #3002's later source job.
Classifier completions, Browser echo jobs, pure identity/plan steps, expected
Draft refusals without tests, skipped and cancelled jobs are excluded. The
JSON retains the excluded jobs completing before **or in the same second as**
the selected endpoint. Five skipped native records have reversed one-second
timestamps; their zero execution represents no executed work, not adjusted
raw timestamps. They do not become useful feedback.

The three Ready CI attempts form another explicit denominator: 63 jobs, with
19 successful and two skipped jobs per attempt. The existing attempt-aware
collector gives:

| PR / run | CI wall | Initial queue | Execution span after first start |
| --- | ---: | ---: | ---: |
| #3000 / `44846098568/1` | 2,445 s | 73 s | 2,372 s |
| #3002 / `44848238113/1` | 1,878 s | 113 s | 1,765 s |
| #3004 / `44845965398/1` | 2,246 s | 47 s | 2,199 s |

First feedback starts at the earliest workflow creation for the fixed head,
which can precede Ready; it is not Ready-to-feedback or push-to-feedback.
The earlier Draft refusals/cancellations remain in the inventory. No observed
full local `pnpm check` receipt precedes these three Ready transitions, and
Actions success does not create that missing local or GitGuardian receipt.
#3004 subsequently returns to Draft and integrates main as `290f4149`; its ab7
results remain historical. Different source inputs and runner scheduling
prevent a causal baseline-to-candidate CI speedup claim.

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
| Runtime publication history recognizes the retired `subscriptions` job and equates workflow head with published source | #3000 repairs the existing reader and shared artifact binding: real historical ZIP/source counterexample, original Node RED and independent61/61 GREEN. Exact primary Actions CI is successful; full local-gate evidence, GitGuardian and merge remain incomplete. No paid rebuild is triggered for measurement |
| Repository transfer leaves active consumers and public marketing admission tied to an old owner/name pair | Reuse the existing finite official profiles and immutable repository ID in #3002/#3004; preserve coherent owner/name, original actors where enforced, source/attempt and credential boundaries. No parallel identity registry |
| Publication consumers retain fields/jobs formally removed by accepted #2789 | #3007 reconciles the existing consumers with the producer's actual contract and #3000 reader; real product subscription, tool, version, terminal-state and cleanup assertions remain unchanged |

Seven original job logs underlying the typecheck comparison are in
[2984-typecheck-assessment.json](2984-typecheck-assessment.json). Identical command
spelling across different environments is not sufficient evidence of duplicate
validation. Existing image reuse remains the single supported build reuse path.

### Transfer delta and original-owner deduplication

The [transfer audit](2984-transfer-delta.md) and its
[machine-readable inventory](2984-transfer-delta.json) retain the later fixed
source `6fe25cf9413d4078ce350a97e284c33f1efa9de7` and its original capture
time. All 54 workflows have a disposition: 17 have no active old-identity
predicate, 14 already use the official profiles, six have original #2994
repairs, three belong to SDLC-008, 13 retain distinct production or finite
historical acceptance scope, and one exposes SDLC-009. The audit examines all
2,570 changed-file records from 50 open PRs and 139 exact-main runs in its
recorded window, including eight push runs. These denominators do not replace
the earlier CI performance sample.

The original audit precedes #2994's completed CI and normal merge. Those
results are now integrated through `ed905bae`; the dated audit's queued-state
observations are historical. The six original-owner workflow fixes are not
claimed as #2984 implementation. Historical URLs and signed receipts, the
unchanged Alex actor, the different `Mikka-handoff` repository and the finite
Factory #1789/#1783 scope remain deliberate exclusions. No dormant manual
release predicate is widened to manufacture a new execution sample.

A later main-only refresh at `59b7682fa34f80f402367d2bb40141034c9cf9fd`
still has the same 54 workflow filenames. Forty-seven blobs are unchanged
from the transfer capture. Six match #2994's merged identity fixes; the
seventh is #3006's native Browser gate `merge_group` and event/ref concurrency
change. The Browser job still only echoes and is not E2E. Every current blob
and disposition is retained under `subsequentMainRefresh` in the same JSON.
This refresh does not pretend that the original 50-PR inventory was recaptured
at the later time, and it creates no new workflow or identity registry.

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

The earlier [local-feedback evidence](2984-b1-local-feedback.json) records two
independently executed old/new source replays and an original Owner report for
a third problem. The later [HTTP/DB counterexample](2984-b1-2996-http-before-after.json)
independently executes that third problem before and after its original fix.
All replays occurred after the historical failures and repairs. They establish
local reproduction and regression entries without rewriting the original
developer chronology or claiming that queue differences were actually saved.
The restored Linux computer used Node24.22.3 and the pinned TypeScript5.9.3 for
the original route generator.

| Problem / Owner | Original local entry point and fixed-source result | Native CI and limits |
| --- | --- | --- |
| Generated route source hash, #2973 / #2956 | Original `node apps/api/scripts/generate-routes.mjs --check`: old67199ca7 rejects stale output in0.664650439 s; fixed45144ea3 passes twice in0.631379609/0.714444750 s,395routes/522methods. Generated files and output hashes remain unchanged | Original Site44811835977/1,job136550118390 queued831 s and printed the first error947.0578911 s after creation. Fixed Site44815741395/1 passed, while primaryCI44815741718/1 failed unrelated original contracts. The original batch is unmerged |
| Fixture preload uses the child cwd, #2969 / #2891 | Original preload in`.output/eve`: oldbf605701 reproduces nested-manifest ENOENT in0.032093036 s; fixedd30f6ec4 passes twice in0.035802252/0.034687927 s. Original guard/proxy/bundle suites pass6/6 at old source and7/7 at new source | Minimal explicitly synthetic manifest only. DB/LiteLLM URLs are parsed, not connected; original proxy tests use isolated loopback fixtures. No actual Eve/productHTTP/UI journey is claimed. The original Draft remains unmerged and itsCI44833174357/1 selector failed |
| Empty native sessions.create body, #2996 / #2869 | Independent original native SDK and actual zero-byte stream requests: four empty-body HTTP400 results at71320074 become four HTTP200 results at5f5d198d; `{}`2/2 remain200 and malformed JSON2/2 remain400. Two rounds verify the same scoped session in PostgreSQL and a fresh native client | Original fix is normally merged as9bbe245ca19d4ac3863cfc75dd47d072ebba1d33. Replay5f5d normally integrates that fix with the fixed d30 fixture candidate; it is not an exact9bbe main/deployment run. No browser or active Stop round is executed |

The first two replay denominators remain one RED and two GREEN invocations
per problem, plus their two original test-suite runs. Synthetic manifests were
removed; the four fixed-source worktrees retained unchanged tracked files.
Their original commands, exits, UTC boundaries and source/tree/blob hashes are
not replaced by the later HTTP evidence.

For the third case, exact RED source
`71320074133a3ec4705ec94576b248de8d54b232` and GREEN source
`5f5d198d70a1209b9b34ba927409a667985dc432` each produce the complete application
through the original build stages, then run396 migrations and six fixture scenes
on separate owned loopback PostgreSQL17.12 clusters. GREEN's three original
#2996 implementation/test blobs match its merge source; RED retains the old
coordinator implementation. Two rounds per phase each send the original native empty request and a
stream producer that closes without writing bytes. That gives the four empty
requests per phase, distinct from two `{}` and two malformed-JSON requests.
The stream producer's zero written bytes are recorded separately from an
unavailable observer body length. Repeated scoped DB and fresh-client snapshots
find one session, eight fixture tasks and zero user messages. No user model
turn is submitted; model call counters are not captured, so no stronger model
accounting claim is made.

The GREEN HTTP phase takes 20.87694 s, exits 0 and closes fixture, pool and
PostgreSQL normally. RED's core HTTP assertions complete, but its temporary
orchestrator exits 1 after wrongly waiting for an idle prewarmed session's cancel
result. The original native call graph defers that new-session control result
until a first turn. The failed orchestrator and original 20-second wait are
retained; correcting the temporary caller does not change product assertions,
timeouts or active Stop behavior. Interrupted builds and earlier failures also
remain in the evidence. No elapsed-time speedup is inferred from the different
HTTP outcomes or removal of that invalid orchestration assumption.

The [original Owner report](https://github.com/aspectly-labs/Mikka/pull/2996#issuecomment-7052767951)
at `09e694c3` separately records first text, Stop 1.748 s and a request settling
13 synthetic microdollars once. Those are Owner results, not this replay's
coverage. Original PRCI44831511577/1's port-in-use failure and successful retry/2,
and exact9bbe mainCI44834869958/1's stale Draft-policy assertions, remain their
own source-bound facts. Original developer local-RED timing is still unknown.
The independent third replay has **0 browser and 0 active Stop rounds**; the
complete UI→API→DB→new-browser denominator is separate in section D.

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
The original repair subsequently merged normally as
`ed905baee7482c43b29e8b15480ebbae160278c1` and is integrated here. Its 34
native check runs are Actions results; the missing GitGuardian receipt is
separately documented below and is not retrospectively counted as success.
The old 51-case RED remains a result for its old source. Integrating its Owner
fix is not an additional independent B1 reproduction or a completed fixture
journey, and it does not finish either original product epic.

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

The normally integrated private change passed 13/13 migration contracts and
55/55 related pipeline contracts, independently verified by
[review 6001310457](https://github.com/aspectly-labs/mikka-cloud/pull/418#pullrequestreview-6001310457).
That review corrects an earlier extra gate: the original operations contract
permits a trusted qualified ancestor to cover a later fixed operations source,
including release-script changes. The existing call graph, tests, native
ancestry and original `44774644281/1` qualification were checked. Its 22 stages
and actual artifact `14648988863` share digest
`a09564e7ece89911c52b1926e7fb64610c8e43ddf4a38869a1dbd389b68b2df5`.
This is legitimate reuse under the owning contract, not new CLI coverage in an
old CI run. No extra registry publication, new trigger or weaker qualification
rule is introduced for this source-only tool.

The current private head still lacks its original GitGuardian check receipt;
an earlier head's success cannot replace it. Normal merge and exact merged
regression remain required after applicable existing security gates. Full
private source identities and operations code stay in the private PR.

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

The later [exact local-gate evidence](2984-local-checks.json) preserves the same
distinction after normal integration of main `59b`. At #3007 head `070253d0`, the
original full `pnpm check` actually runs from 02:03:36.486862 to 02:04:34.300298 UTC
and exits 1 after 57.813485744 s. All eight cases in
`packages/daemon/test/commands.test.ts` fail at the original Unix socket listen
in `packages/daemon/src/rpc/server.ts:80` with EPERM; subsequent check stages do
not execute. The preceding original PG17 setup succeeds with 396 migrations,
and cleanup confirms stop0/status3/no PID file. Focused 198/198 and 82/82 results
at unchanged source blobs do not replace this failed full gate. An earlier
wrapper attempt stops before tests on a PostgreSQL version-string assumption;
the resumed run checks native `server_version_num=170012` and keeps the failed
attempt as environment evidence.

At marketing head `290f4149`, original `pnpm local:plan` passes in 12.359467241 s on
a clean exact source, but a minimal AF_UNIX construction independently fails
with errno 1 in this executor. That is a capability observation, not a passed
product test or full Ready gate. The original full checks remain required on a
healthy authorized environment; no assertion or stage is skipped to obtain a
Ready record.

The earlier official fixture from original #2969 was built with its pinned public
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
observation. The old failure remains attached to its old source. The B1 replay
above verifies the repaired preload against a minimal synthetic
manifest. It does not move/copy an actual build manifest as a startup workaround,
remove preload, change the readiness budget or take over that branch.

A later complete invocation of the original
`node scripts/build-application.mjs --local-fixture` at exact
`d30f6ec4a4a1b66278587442e7fd91676ab2f709` succeeds in 283.690083369 seconds
(n=1, 2026-11-21 00:37:13.302974–00:41:56.993031 UTC). Its
[public build receipt](2984-fixture-build.json) records the unchanged tracked
source, actual output manifest/log digests and the read-only pinned official
overlay boundary. The private overlay SHA and code are not copied here.
Provider credentials were not inherited, and native telemetry was disabled.

This is the fixed unmerged #2891 fixture candidate. Main59b has neither its
fixture package commands nor `scripts/fixtures/start.mjs`; the successful build
does not establish that the fixture is already delivered as main's default.

The subsequent [original backend fixture execution](2984-fixture-backend.json)
at that same public source uses Node24.22.3 and PostgreSQL17.12. It verifies the
actual `local-fixture` build manifest, runs `prepareFixture` in 3,781 ms with
396 migration ledger records, and successfully starts the original six scenes
(`empty`, `board`, `task`, `automations`, `bot-settings`, `pulls`). Chromium
then fails during launch, before a browser, context or page is created:
`process_singleton_posix.cc` reports `socket()` EPERM. This is an execution
environment failure before a product journey, not a failing product assertion.
The original fixture, database client and PostgreSQL close normally at
00:50:08.904 UTC; `pg_ctl status` exits 3 and no server remains running.

The later [existing Small browser execution](2984-d-browser-fixture-entry-diagnosis.json)
uses the same fixed d30 source and original compiled input. The three actual
child executions remain distinct:

| Invocation | Phase and observed result | Child exit / duration |
| --- | --- | ---: |
| First temporary caller | Bare Node22 cannot load the transitive `.ts` entry; no PG or browser starts. The outer wrapper's initial exit propagation was wrong; the original child receipt remains failed | 1 /0.715869506 s |
| Second temporary caller | Original embedded PG starts, but its package has no `createdb` CLI. No browser starts; owned PG stops normally. The next caller uses the existing locked `pg` client | 1 /4.331587086 s |
| Real browser attempt | Original prepare/start succeeds with396 migrations and six scenes; pinned Chromium156.0.8078.4 starts with its default launch. The first business page precondition fails before any mutation | 1 /48.056587349 s |

The third invocation reaches the original fixture login path (HTTP303), then
shows the community server status page. The unchanged fixture child lacks
`MIKKA_EDITION`; its default community runtime adds the status-document marker
before a full workspace mounts. This is a source-bound fixture entry defect
under original #2887/#2969, not another browser launch failure. The inspected
Owner candidate remains unmerged and has no observed edition repair. The
[exact-d30 independent review6002319755](https://github.com/aspectly-labs/Mikka/pull/2969#pullrequestreview-6002319755)
records this blocker in the original PR; it does not change that Owner's source,
branch or PR state. A separate old right-rail selector in the temporary caller has not been exercised against
an actual workspace and is not conflated with this failure.

One of two planned business journeys starts; **0/2 complete, with zero observed
business mutations**. Browser, fixture and DB client close through their original
methods; owned PG stops, status exits3 and no server remains. Those cleanup
fields are not extra child-exit telemetry. No live model, customer-data operation
or production migration occurs. The two temporary caller defects, original
child failures and their actual timings remain available without changing
Owner source, timeout or business assertions.

The earlier two runs of the original seed smoke each passed six scenarios with identical
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
the plugin directory; no callable Docker entry was returned at that earlier
point. No paid substitute, new CI workflow or test-result simulation was
introduced. The existing cloud computer was later restored with a fresh filesystem. The
original pushed branches were recovered through Git and normally integrated
with main; new local results above are separately source-bound. The same public
repository ID1427517699 is now`aspectly-labs/Mikka`. Historical receipt URLs
are preserved. No new identity or permission grant was required to resume
standard GitHub code writes.

Later discovery of the original authorized Docker SDK/REST entry permits reuse
of the existing Small environment. Its original Chromium can launch normally;
launch is not a completed browser journey. Execution stays in the new task's
own paths, with original Owner worktrees and databases left intact. Temporary
callers use the project's existing `tsx` loader on Node22 and the locked `pg`
client when that PostgreSQL package lacks the optional `createdb` CLI. These
environment adaptations do not alter fixture source or assertions. The completed
Small browser failure is recorded above; the full local-gate outcomes remain
pending their finished receipts. Transfer, dependency installation or process
startup is not acceptance.

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
integration. The later #3001 native local-first handoff is also retained;
neither its implementation nor its performance is attributed to
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
are #2969's fixture-entry correction and normal delivery, actual browser and
chat acceptance, real
staging admission and production acceptance. The child's corrected startup and
the third B1 HTTP/DB regression are now independently observed; a completed
browser journey is not. This
remediation still owns private #418's applicable current-head security checks,
normal merge/regression, the four later public repairs in the checkpoint table,
completed protected post-merge observations and this documentation PR's own
review/CI/merge. The automatic-E2B event contract repair
is merged and independently verified at its merge source; live publication is
not claimed. The publication-history job/source mismatch is implemented in#3000 at
head8b5de3dacd3771737b0e25974c195deb057817e8, with independent61/61 original
Node cases and the actual46376-byte historical ZIP digest verified. Its
[fixed-source evidence](https://github.com/aspectly-labs/Mikka/blob/8b5de3dacd3771737b0e25974c195deb057817e8/docs/ci/2984-runtime-reuse.json)
keeps original metadata, closed-adapter transport and true archive-byte checks
separate. Its exact primary Actions CI is now successful, while the missing
full local Before Ready receipt, GitGuardian, normal merge and exact merged-source
verification remain separate requirements. The main integration retains the nine reviewed implementation
blobs. Its first local invocation passes 96 tests but fails to start the Task
file because the original `tsx` loader was omitted; only that unstarted file
is then run correctly and passes 16/16. The failed invocation remains failed,
and these results are not described as one all-green run.

SDLC-010 uses the real historical producer `44140435060/1`, nine jobs and
artifact `14354323589`: the three templates are public/ready, while its
publication contract legitimately has no retired `subscriptionAcceptance`.
The actual published source `b53e8f369ff23eb062b1cc8509e499a60ec0bbe0`
differs from workflow head `5189fa615cfd7ce281ce7c7e17e477206dba2254`.
These are an actual historical receipt and fixed-source rejection examples,
not a newly executed publication or proof of a product subscription task.
The repaired original eight-suite run passes 198/198, and an independent focused
run passes 82/82. A closed replay reads the actual 46,376-byte archive, validates
its digest and checks the original selector/report/identity boundaries. Native
captured metadata and explicitly supported transport/Web fixtures remain
distinguished in the
[fixed-source evidence](https://github.com/aspectly-labs/Mikka/blob/070253d0447d76f2bfc87fe0863ccd65f02d9e24/docs/ci/2984-publication-contract.json).
No real model, VM, new publication or product subscription is executed. Modern
template publication requires the real publish/upload steps to succeed; the
legacy subscription branch and all three product drivers' assertions remain
intact. Normal main `59b` integration retains all 16 source/test blobs; the later
full local check still fails at the environment boundary described in section D.
Accepted #2789 merged as `25302463243fe27d86a74d4610ac2e6ad3750b3f`;
its retained product subscription/tool/version/terminal/cleanup requirements
are unchanged by this documentation correction.

### GitGuardian remains required; absent checks remain unverified

The [native GitGuardian assessment](2984-gitguardian-transfer.md) and
[public-safe records](2984-gitguardian-transfer.json) distinguish the existing
project requirement from the administrator settings visible to this identity.
Current AGENTS, CONTRIBUTING, workflow README and accepted #2997 preserve the
original external check. The visible public branch metadata lists three
Actions contexts; the full protection API is inaccessible. Neither observation
waives GitGuardian, and this work changes no protection or App configuration.

The purposive before/after public sample has one head each: #2986 has a real
GitGuardian App46505 success; post-transfer #2994 has 34 Actions check runs,
eight non-GitGuardian suites and zero statuses. The private Cloud sample has
three earlier scanned heads and three later heads missing scans, including
#418. Hosted UI has three current heads with successful historical scans but
zero observed new post-transfer heads. These are not fleet trigger rates, and
Hosted UI's old success does not establish that a new push will scan. A
zero-status `pending` result does not mean GitGuardian is queued.

The missing check creation is proven for those exact samples; its installation,
repository-selection, event-delivery or provider-configuration cause remains
unknown. No original transfer Owner receipt located in the sampled discussions
claims GitGuardian App migration is complete. The existing repository/App
integration Owner must restore and verify the applicable exact-head native
receipt. This is an external integration dependency, not authorization to
replace the scanner, use another identity, add a new gate or reduce the original
requirement. The live progress comment tracks this and the unfinished work
without creating a second issue ledger.

Official [GitGuardian integration documentation](https://docs.gitguardian.com/internal-monitoring/integrate-sources/vcs-integrations/github)
assigns configuration to GitGuardian Owners/Managers and organization App
installation to the organization Owner; installation access and monitored
repository perimeter are separate. GitHub's
[existing-installation documentation](https://docs.github.com/en/apps/using-github-apps/reviewing-and-modifying-installed-github-apps)
describes the existing owner/admin repository-access controls. These identify
the legitimate ownership boundary only. They do not establish that this
installation is missing, suspended or misconfigured, and they do not authorize
this remediation to change App settings, credentials or the original gate.
