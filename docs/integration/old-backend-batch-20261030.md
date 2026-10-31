# Older backend issues: integrated evidence

Scope approved by Alex: the older #179, #207, #208 and #209 issues, handled
by four sub-agents and delivered through the existing aggregate PR #524.
Latest issues and #520 are outside this work. No issue is closed merely
because a component implementation or fixture test passes.

## Frozen implementation

Integrated database/authorization/recovery revision: `ee68bc8a` (after merging
main `75b6bb5d`). Application revision `3ae8a561` additionally aligns native
Coordinator schedule instructions with the SDK path; the existing immutable
snapshot/message-policy compatibility regression passes on all three harnesses.
Compatibility merge `8ed27a66` then preserves main `a98b0eb0`'s human-control
pause handling, desktop/daemon publication and added tests. Only three merge
conflicts needed resolution: terminal recovery keeps both atomic reporting
and pause-field cleanup, package scripts retain both sides, and daemon HTTP
tests retain both additions. This is integration of others' existing changes,
not implementation of their latest issues. The final history contains 153
migrations; the earlier 152-schema/`3ae8a561` evidence below remains explicitly
bound to its earlier application revision.
Earlier evidence in `backend-batch-20261030.md` belongs to its stated
historical revisions; it is not evidence that this larger revision passed.

| Issue | Source commit | Integrated behavior |
| --- | --- | --- |
| #179 | `a0a35896eac437b3298abfb92b54eb5009307fba` | Persistent once/interval/daily schedules, seven Coordinator tools, original-chat reports, and restricted reads through the existing Coordinator |
| #207 | `8265d345a275ce1b8acf7f04e6ac17dcf21d8d50` | Worker requests recheck current membership, Bot/workspace access, STOP and device-run lease authority |
| #208 | `00d3cc3c44fe9e71bbaed1f20d1493f1ad38c777` | Authorized readback after the original execution fails; no renewed authority to resend the effect |
| #209 | `2560861a7d6c46d7eb08c46ecdbcaa9dda236131`, `d92170c4d751da99eaab36308dd9bb85ef38cc36` | Independent bounded lease recovery, atomic terminal notifications, checkpoint availability, and same-device/cross-device continuation rules |

Shared integration narrows both the actual tool registry and frozen grants
for scheduled reads, registers default schedule capabilities, and adds the
new tests to mandatory source/database CI inventories. The existing minute
Worker calls wakes, schedules and run recovery independently; a failed
request cannot prevent the other two requests from settling. No new timer,
secret, paid service or default-off availability flag is introduced.

Main's hosted usage accounting and online uninstall grace remain intact.
Actual offline credential revocation still records a fence receipt; an
online device's restricted uninstall grace does not create a false receipt.

## Migration provenance

Main `7883802f` independently merged the two identical counter migrations;
their SHA-256 hashes match the original candidates, so only the redundant
unmerged copies were removed. The four remaining candidates are dated after
main's `20261031000251` migration. Their SQL bytes are unchanged. Previously
applied ledgers/databases remain retained. Final history has 153 files.

| Previous candidate name | Current name | SHA-256 |
| --- | --- | --- |
| `20261030213400_issue_number_counter_expand.sql` | `20261031000250_issue_number_counter_expand.sql` | `dcebd6c3d9fd4ec923958f4c19dcfa87c2422f3a83317b79d052768041e8db03` |
| `20261030213401_issue_owner_number_unique.sql` | `20261031000251_issue_owner_number_unique.sql` | `940f564d977aaf7d0c7b17d27ac185052d81b2880ad696e8d47a2fb5a4700d11` |
| `20261030213402_coordinator_wake_recovery.sql` | `20261031002604_coordinator_wake_recovery.sql` | `251917c12499d5172deaeb764bd11e0c3a6b0cece46bf3fe287b93cfba28c2d7` |
| `20261030213403_daemon_credential_revocation.sql` | `20261031002605_daemon_credential_revocation.sql` | `083c044fbd62244565bd64e6aef3852a0bb3069cc5e2ef1d8f6de9b48d94804a` |
| `20261030230200_user_schedules.sql` | `20261031002606_user_schedules.sql` | `c946261f07d2cffbab65f86a2f22340bcbc0f90e4556326cacfaa57d0c0cc580` |
| `20261030230201_checkpoint_recovery_availability.sql` | `20261031002607_checkpoint_recovery_availability.sql` | `e3f15b25ad8d55a12f34c6480f18da1b1df827fd91b1d50383cc7793979b390e` |

## Acceptance boundaries

Integrated cloud Linux evidence (PostgreSQL 17, explicit loopback port 55599):

| Gate | Result | Retained evidence |
| --- | --- | --- |
| New migration history | 152 applied; prior databases/ledgers retained | `/tmp/mikka-old-main-setup.log` |
| Schedule store, concurrent claims, SIGKILL, original chat and authorization | 11/11, no skips | `/tmp/mikka-old179-current-db.log`; `mikka_old179_current_e2e` |
| Worker authorization and actual MCP HTTP revocation | 10/10; related scope source 13/13 | `/tmp/mikka-old207-merged-db.log`, `/tmp/mikka-old207-merged-source.log`; `mikka_old207_merged_e2e` |
| Operation recovery and existing write-policy chain | 2/2 + 1/1, no skips | `/tmp/mikka208-fixed-serial-recovery.log`, `/tmp/mikka208-fixed-serial-policy.log` |
| Independent run recovery and authenticated checkpoint routes | 8/8 + 6/6, no skips | `/tmp/mikka-old209-main152-db.log`; `mikka_old209_main152_e2e` |
| Claim and cron boundaries | 14/14 + 2/2 | `/tmp/mikka-old209-main152-claim.log`, `/tmp/mikka-old209-main152-cron.log` |
| Daemon, HTTP and actual Git recovery | 70 cases; one initial setup timeout passed unchanged on focused rerun | `/tmp/mikka-old209-main152-daemon.log`, `/tmp/mikka-old209-main152-setup-focused.log` |
| Existing uninstall/service compatibility | 15 cases; one initial network timeout passed unchanged on focused rerun | `/tmp/mikka-old209-main152-uninstall-daemon.log`, `/tmp/mikka-old209-main152-uninstall-focused.log` |
| Native/SDK immutable prompt compatibility after alignment | 3/3 | `/tmp/mikka-old-native-prompt.log` |
| Mandatory database-suite inventory | 15/15 | `/tmp/mikka-old-final-inventory.log` |
| Production Next build including TypeScript | Passed on application `3ae8a561` | `/tmp/mikka-old-final-build2.log` |
| Actual Next, host tools, cron and automatic account leases | Reminder and issue snapshot passed; cron replay and peer isolation passed | `/tmp/mikka-old-runtime-final-result.log`; `http://localhost:3110/mikka`; `mikka_old_runtime3ae_e2e` |

The actual Next run attested application `3ae8a561` and its owned database,
used the normal automatic owner/peer signup/session/lease mechanism, and
released its successful lease cleanly. The server log passed credential
evidence scanning. Its tool executor was invoked by the test host against a
real HTTP-created user event; no model selected these tool calls. Two earlier
runner fixture errors (invalid issue priority and reserving the resource
after its insert) failed before this acceptance; their quarantined leases
and databases remain retained. The successful run reserved its fixture ID
before creation in a fresh database and used the existing valid priority.

The recovery HTTP test server now imports worker-only dependencies only in
worker mode, and fixture setup failure closes its own process and pools.
An explicit dropped-ready negative probe exited as a failure without leaving
its child behind. Existing ten-/thirty-second limits and effect assertions
are unchanged. The per-owner retry source fixture now explicitly exports a
raw-pool stub that throws if queried; its actual Bot-provenance regression
passes (`/tmp/mikka-old-mailbox-retry.log`).

The two initial daemon timeouts occurred during concurrent local validation;
focused reruns kept the original timeouts and assertions. No timeout increase,
new skip or production-code workaround was used. Their original logs remain.

Real PostgreSQL, independent HTTP services and process-kill tests establish
the specific recovery/authorization behavior described in the component
reports. Explicit provider or execution fixtures do not establish live SaaS,
real model or dual remote-daemon acceptance.

- #179 still needs a real model selecting the schedule tools and completing
  an authorized scheduled Agent read with its real connection configuration.
- #207's complete issue acceptance spans more entry points and real sessions
  than this focused MCP worker fix.
- #208 still needs live-provider readback; the existing Composio adapter does
  not supply an automatic receipt for every uncertain operation.
- #209 still needs two remote daemon/harness instances and real model
  acceptance. The updated existing cron Worker has not been deployed here.
- #500's source hands scoped GitHub credentials and CI ownership to the
  execution Agent; the configured private-key lookup returned HTTP 404, so
  live credential issuance and red-CI → repair → green remain unverified.

No production deployment, main merge, live external message or paid worker
execution is included. These issues remain open for their remaining
acceptance, rather than being closed as wholly complete.

## Final branch preparation

Main `7883802f` owns the final numbering implementation and canonical counter
SQL. The consolidated branch retains its implementation and expanded tests;
this batch does not implement its newer read-lock issue. The four new pending
migrations are `20261031002604` through `20261031002607`. The SSH enrollment
fixture now applies the same credential-revocation DDL as the application;
its online grace, uninstall receipt, expiry and offline revocation tests pass
4/4 with no skipped cases (`/tmp/mikka-old-enrollment-final.log`).

The GitGuardian report identified the static synthetic lease UUID on line 11
of `lib/schedules/scope.test.ts` in historical source commit `72bb1d42` as a
generic high-entropy secret. That pure mock never authorizes a database or
provider request. It now generates a fresh UUID at test runtime; its four
scope cases pass unchanged. No scan exemption or detector suppression was
added. The aggregate branch is consolidated into one commit on current main
to remove the historical false fixture from the PR's commit range. Original
source commits remain recorded above and in the closed source PRs; the prior
integration history is retained locally on
`archive/backend-batch-pre-squash-20261031-0028`.

On the pre-final-main 153-schema integration (`8ed27a66`, application-equivalent
to `9b92cb5e`), schedules DB 11/11, worker DB 10/10, operation recovery/policy
DB 3/3 and recovery/checkpoint DB 8/8 + 6/6 all passed without skips. Root,
daemon and protocol TypeScript passed; daemon HTTP tests passed 25/25. Logs
use `/tmp/mikka-old-a98-*`. The local mobile source check initially lacked
its existing Expo dependency links; linking the already installed workspace
dependencies, with the integration React renderer shared, made its normal
script pass without source or configuration changes.

## Final CI fixture alignment

Application revision `11ebb049` passed full/strict source checks, production
build, real packaged SSH/systemd, performance 5/5 and the real-daemon MVP
fixture 2/2. Its full DB run exposed two older fixtures creating device-bound
`running` runs without a lease: scope-completion rollback token verification
and secret output/checkpoint masking. Production correctly refused that
state. The fixtures now seed active leases; all original authorization,
rollback, masking and target-isolation assertions remain. Secrets pass 57/57
on fresh 153-schema `mikka_209_secrets_ci_e2e`; a fresh
`mikka_scope_fixture207_e2e` proves NULL/valid/STOP/expired token behavior 4/4.
The original scope suite's existing CI/retained-target guard is unchanged;
its full acceptance runs in real GitHub Actions.

The sole browser failure in that revision was the unadopted Factory retry
fixture advertising an older daemon capability set: checkpoint recovery
refused it before the intended Factory fence. The fixture now declares the
same strict local-worktree continuation capability as the current daemon.
Expected Factory errors, absent credentials/receipts and concurrent STOP
assertions remain unchanged. Claim-boundary source tests pass 14/14. These
follow-ups change tests and this report only, preserving application source,
runtime guards, timeouts and skip policy. Final Git-linked CI is recorded on
the aggregate PR, rather than treating these earlier runs as final success.
