# Every issue dispatch uses Factory (#1104)

The implementation follows
[the all-dispatch decision](../design/decisions/2026-11-03-0415-all-dispatch-through-factory.md).
An ordinary issue cannot acquire a new execute run through the Coordinator,
MCP client, Bot computer API or thread reply without a Factory task and attempt.
`start_web_subagent` remains outside this change; its observations may be evidence.

## Dispatch and recovery

`lib/factory/task-dispatch.ts` receives the placement and model already selected
by the existing dispatch rules. It serializes one owner's issue and commits
route/retry/repair, queue, check configuration, frozen definition, attempt binding
and the request receipt together. Cloud queueing joins that transaction through
`queueFactoryCloudRun`; provisioning starts after commit. Request replay checks
the original payload and current task authorization, including stopped tasks.

The current thread keeps its model/account, repository, read-only setting and
placement. A failed/blocked execute attempt retries; a failed/blocked check or
pending acceptance returns to execute through repair, clearing the candidate.
Accepted work creates a new task on the same issue. An explicit replacement
cancels its prior task in the new dispatch transaction; failed admission does not
stop the old thread. Review/verify/monitor runs are excluded from the task-thread
and latest-model lookups. A stop-requested old run does not block the admitted
replacement, but an ordinary continuation still observes `threadStopping`.

When no personal source message exists, the host records the dispatch in its
Coordinator chat as a `user_message` with `source: host_dispatch`. It has no
browser session attestation and grants no human acceptance or new permission.

Factory routing/lifecycle ship on, retaining their existing PostHog flags and
explicit operator-off behavior. An off flag returns `factoryLifecycleUnavailable`;
it never selects a direct queue. Already queued Factory attempts cannot acquire
an unfenced claim while those flags are off.

## Host-owned checks

Runtime reconciliation dispatches the next review or verify run in the same
transaction as advancement. A verified failed check enters the shared bounded
repair loop and dispatches the new execute attempt. Original failure reports,
criteria and chunk references remain available in the repair prompt. Missing or
untrusted provenance blocks; it is not treated as a successful check or an
automatic code diagnosis. Exhausted repairs remain failed.

Each check has a fresh run/session, a frozen read-only policy and the candidate's
exact repository/SHA. Device checks use the execute device; cloud checks get
fresh thread machines. Host-owned cloud relocation changes the executor and
repository FK in the frozen assignment, while preserving candidate identity.
Claim still checks the real thread machine and existing credential/policy fences.

Execution questions remain on their original stopped executor, model/account and
session. Their cloud queue reauthorizes the recorded question and credential,
commits the continuation with the new attempt, and resumes the original parked
thread machine after commit. A missing original machine/session fails closed.
An unanswered question cannot be bypassed by an ordinary retry.

## Candidates and acceptance

Contract v1 gains optional candidate `kind` without changing existing bindings:

| Kind | Candidate identity | Human acceptance |
| --- | --- | --- |
| `code` (legacy default) | Exact published 40-character SHA | Merge the reviewed PR as the person |
| `report` | Exact HEAD observed by the daemon for a read-only investigation or repository without a remote | Accept the report and evidence; no merge |
| `deliverable` | `sha: no-repository`, plus immutable candidate/run/artifact identity | Accept the desktop deliverable and evidence; no merge |

`no-repository` explicitly denotes the absence of a repository commit; it is not
a fabricated SHA and is not displayed as one. The desktop worker's private Git
workspace can still provide an internal execution SHA to pin its independent
checks. Public artifact evidence uses `sha: null` for this candidate kind.

The daemon supplies `observedHead`; agent handoff data cannot populate it. Reports
and deliverables pass the same independent review/verify and evidence gates as
code. `factory_acceptances` records only a live browser user's accepted candidate
and revision. No agent/worker token can use that endpoint. Code acceptance keeps
its existing GitHub merge/branch-protection behavior. Reading or accepting a
report does not require a GitHub token.

The browser store resolves each owned task's real Bot before invoking the
existing source, issue, scope and cancellation checks. Bot-scoped tasks are
therefore visible through task discovery, detail, evidence and acceptance.

## Missing verification commands

A missing command does not prevent scheduling review/verify. The agent inspects
repository scripts, Makefiles or CI and records the chosen command and its basis
in a criterion. The daemon executes that command under the frozen read-only
policy, retaining actual exit/signal/timeout/output and fixed-HEAD receipts.
Reconciliation freezes the inferred command only when paired tool input/output
and its recorded basis match. Those records are shown with the existing evidence.
Text criteria without UUIDs are retained as the protocol allows; they do not
replace the daemon's verification result.

Only a verifier reporting `factoryCheckCommandRequired` opens the existing human
question card. A browser-authenticated answer is saved on the owner's repository
registrations and starts fresh independent verification. No default command is
invented, and a command answer does not grant other execution permissions.

## Verification boundaries

`tests/factory-all-dispatch.db.test.ts` belongs to the required
`test:bot-threads-db` suite. It exercises actual dispatch/store/reconciliation,
independent checks, report acceptance, command questions, automatic repair,
replacement rollback and both dispatch/claim stop controls on loopback PG17.
`tests/cloud-runtime-auto.db.test.ts` adds cloud desktop delivery, fresh check
machines and strict execution-question continuation; E2B alone is substituted.
These tests use synthetic people, terminal reports and process observations.

`packages/daemon/test/factory-check.test.ts` uses real Git worktrees and child
commands with a simulated Harness, including inferred verification commands and
text-only criteria. A pre-fix reproduction dropped the fixture's text criterion
(occurrence 10/10 for this input; impact 8/10 because an ordinary independent
review cannot pass). The regression now retains that criterion without trusting
agent-reported verification.

API/CLI acceptance uses `pnpm test:local-loop` in cloud Linux with its normal test
account lease, local database/application/daemon and provider boundaries recorded
by that harness. The database and simulated-Harness tests do not establish real
E2B/provider behavior or a production rollout. This branch adds no production
credential, database write, flag mutation or deployment.
