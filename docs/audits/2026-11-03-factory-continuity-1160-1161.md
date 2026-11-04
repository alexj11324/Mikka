# Factory request continuity and unattended recovery — #1160 / #1161

## Correctness changes

The existing `factory_tasks.sourceEventId` is the request epoch UUID. It is
stable across execute, review, verify and repair; `revision` remains the
compare-and-swap version for individual stage transitions. No new task system,
queue or daemon protocol is introduced.

An authenticated owner continuation advances that epoch **within the same
Factory Task and thread**, retaining candidate, acceptance, failure and external
operation history. It creates a new execute attempt, clears the current
candidate, requests old workers to stop, revokes their run tokens and
supersedes obsolete questions. Old callbacks cannot advance or repair the new
attempt. A repeated source is idempotent; a source already superseded, a foreign
parent, an issue/Bot mismatch or withdrawn task authority is rejected.

Coordinator dispatches derive their continuation from the original persisted
owner event, not the model's dispatch note. Direct thread and computer API
actions retain the raw owner text with a fresh event UUID for each operation;
identical text after an intervening request is a distinct target epoch. Only a
replayed persisted source event is deduplicated. Every dispatched attempt and independent
check freezes the epoch. Current request text precedes historical context;
earlier non-conflicting constraints remain available. Repair budgets are scoped
to the request epoch so earlier accepted work does not consume the new owner's
repair allowance.

## Recovery behavior

Structured handoffs live in the existing `factory_events` ledger with a SHA-256
digest and source/attempt/publication/operation provenance. They contain current
goal, issue constraints, completed and pending stages, questions, last
candidate, checkpoint metadata, last run/error and external receipts. Fresh
dispatch and existing lease takeover both receive this handoff. A checkpoint is
still only a repository snapshot: ignored files, secrets, memory and native
sessions are not claimed to have transferred.

The existing independent `/api/cron/run-recovery` route scans at most 40 tasks
within a 20-second deadline. Run-completion events also target the affected
task directly. Progress uses stage/candidate/tool-result/checkpoint facts;
device heartbeat and run-lease renewal are not progress. Active observations
have a next-scan time so old, productive tasks cannot starve later tasks in the
bounded scan. Explicit pauses and human-input waits keep their existing paths.

Execute has a 45-minute no-progress window; other stages use 20 minutes. A
stalled executor receives a stop request and loses tool tokens. Recovery waits
for its terminal acknowledgement. If it does not acknowledge within five
minutes, the task stays blocked with one actionable notice. An original-session
question continuation is never replayed on another machine.

After acknowledgement, the watchdog retries through the normal Factory
dispatcher in the same epoch. For local execute, it selects another enabled,
online device belonging to the same owner, with the same harness and a model
and credential authorized for that device's Agent. Repository admission runs
again. It does not copy a device grant or another account's credential. The
retry keeps `retryOf` so the existing checkpoint-restoration path can be used.
Cloud runs reuse the existing host lifecycle to create their next worker.
Missing authorization or capacity remains bounded by three recovery attempts
with backoff; the per-epoch repair cap still applies.

Successful mechanical recovery is quiet. Uncertain external operations,
unacknowledged stops and exhausted recovery produce one durable blocker per
task/epoch. The existing Coordinator Decision flow receives the actual blocker
and handoff reference to decide whether to notify the owner. No uncertain PR,
push, email or other operation is replayed. Complex changes of plan remain with
the existing Coordinator; a watchdog observation is not acceptance evidence.

## Verification evidence and limits

The targeted PostgreSQL suite exercises concurrent epoch advancement, stale
finish/repair refusal, provenance rejection, immutable accepted history,
handoff hashing, heartbeat-independent stall detection, stop acknowledgement,
bounded missing-executor recovery and uncertain external receipts. The existing
all-dispatch suite now also follows the real stop-completion consumer into
normal admission on a second device, checking the same Task/epoch, checkpoint
lineage, one queued child, its actual Agent/device binding and zero owner
interruptions. The device heartbeat/stop acknowledgement and vendor responses
in these integration fixtures are synthetic; this is host-state-machine
evidence, not production daemon or paid-model acceptance.

Final isolated PostgreSQL 17 run: **112 passed, 0 failed, 0 skipped** across
`continuity.db`, `factory-all-dispatch.db`, `thread-continue.db`, `checks`,
`monitor-dispatch`, `checks.db`, `postgres`, `monitor-cycle` and `routing.db`.
Local targeted dispatch/cron/context tests: **36 passed, 0 skipped**.
`tsrs --noEmit`, acceptance-driver syntax and `git diff --check` also passed.
These are the implementation worktree checks, before root's integration.

No daemon or worker protocol change is required. Production still needs the
root integrator's exact-SHA deployment check and real authorized official
Codex/Claude continuation runs. The implementation worktree did not have those
production credentials. Tests do not claim production success.

## Reproducible official-subscription acceptance

`scripts/acceptance/factory-continuation.mjs` uses ordinary email/password login,
keeps credentials and cookies only in memory, and signs out afterward. It
accepts the explicitly authorized main account or a normal Smoke test account,
and sends production credentials only to `https://app.aspectlylabs.com/mikka`.
Loopback fixtures additionally require a Smoke account and
`MIKKA_ACCEPTANCE_LOCAL_FIXTURE=1`; main-account credentials never go to them. It
requires two already accepted, disposable owner tasks with downloadable
artifacts: Claude Code 53 → 74 bytes and Codex 56 → 77 bytes. It asserts both
byte count and precomputed SHA-256 of the exact expected artifact contents.

Prepare a JSON array containing one entry for each harness:

```json
[
  {
    "harness": "claude_code",
    "taskId": "<existing-owner-factory-task-uuid>",
    "threadRunId": "<existing-thread-run-uuid>",
    "artifactTitle": "continuation-claude.txt",
    "initialBytes": 53,
    "initialSha256": "<sha256-of-original-exact-content>",
    "expectedBytes": 74,
    "expectedSha256": "<sha256-of-new-exact-content>",
    "followup": "<the raw owner request including the exact new target>"
  },
  {
    "harness": "codex",
    "taskId": "<existing-owner-factory-task-uuid>",
    "threadRunId": "<existing-thread-run-uuid>",
    "artifactTitle": "continuation-codex.txt",
    "initialBytes": 56,
    "initialSha256": "<sha256-of-original-exact-content>",
    "expectedBytes": 77,
    "expectedSha256": "<sha256-of-new-exact-content>",
    "followup": "<the raw owner request including the exact new target>"
  }
]
```

Provide `MIKKA_TEST_ACCOUNT_EMAIL`, `MIKKA_TEST_ACCOUNT_PASSWORD`,
`MIKKA_ACCEPTANCE_BASE_URL`, `MIKKA_EXPECTED_DEPLOYMENT_SHA`,
`MIKKA_EXPECTED_BUILD`, `MIKKA_CONTINUATION_CASES_FILE` and optionally
`MIKKA_ACCEPTANCE_REPORT` via the authorized environment. When `/api/version`
reports a Vercel deployment ID, `MIKKA_DEPLOYMENT_METADATA_FILE` must contain
the actual provider metadata fetched by the deployer, including `id`,
`readyState: "READY"` and `gitSource.sha` or `meta.githubCommitSha`. The driver
checks this binding and rechecks the served build throughout the run.

```sh
node scripts/acceptance/factory-continuation.mjs
```

The driver rejects API-key runs masquerading as official subscriptions using
safe, owner-only frozen execution metadata in the existing evidence endpoint.
It then requires current-epoch independent review and verify runs, the same
candidate SHA, preserved earlier accepted attempts, and two matching downloads
after checks. Its report contains IDs, epoch, candidate SHA, byte counts and
hashes, never credentials or artifact content. Native workspace/Git inspection
and a real device-loss exercise remain part of the deployer's production
acceptance record; an HTTP artifact report alone does not prove those checks.
