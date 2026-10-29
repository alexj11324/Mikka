# Scope retirement and run publication composition

Base: integration commit `84b775b1`. This follow-up composes #365 task scope
retirement with #362 durable run publication without dropping atomic task
history or the first accepted completion report.

## Confirmed defect and correction

A publication previously reread the task's current title after checking
visibility, and its receipt did not identify the scope generation. Retirement
could therefore happen between permission checking and the GitHub request;
re-promotion could also make an old teammate publication appear authorized
again. A late receipt could update the subsequent generation's metadata.

New assignments store the authorized title and `scopeVersion` on
`run_publications`. The additive migration leaves unknown legacy values null;
it never invents a historical grant from current task state. Such unknown
publications finish with a safe error and do not contact GitHub.

Publication checks the current run, task, pinned receipt, repository approval,
and accepted admission before preparing provider inputs. It rechecks those
conditions while holding the task and approval rows around each actual GitHub
PR creation or draft conversion. Each provider mutation retains its existing
eight-second HTTP timeout; repository metadata lookups remain outside these
locks. Workspace membership and task relation locks precede APP locks, matching
team promotion. APP locks follow issue → run → publication, with bounded lock
waits.

The task owner retains permission over their own run after a scope change, but
the publication continues using its original authorized title. A teammate's
retired grant cannot revive after re-promotion. A provider receipt for an older
generation remains available in the run receipt and completion event without
changing the later task's status, metadata, revision, or history.

## Validation

- Actual Node source execution: 25 publication/provider/admission tests passed,
  including final-write authority loss and draft-conversion fencing.
- Actual completion route source execution: seven tests passed, including
  workflow enqueue ordering, scope-guarded dispatch, and terminal malformed
  replay. Its mocks now explicitly stub the completion dependency and capture
  shutdown; no test accidentally loads the real authentication graph.
- After the integration owner's approval-mock corrections, all 16 tests in
  the publication command's module-mock group pass. This includes six new
  Factory composition tests and the seven completion route tests.
- New PostgreSQL cases cover owner completion across retirement, unknown
  legacy pins, teammate re-promotion, retirement during provider lookup, and
  an actual row-lock race with a late provider receipt. The row-lock race checks
  `pg_blocking_pids`, rather than inferring contention from elapsed time.
  Scope tests use the suite's retained database bootstrapped from tracked
  migrations, so the real scope-generation and retirement triggers run.

The PostgreSQL cases require the repository's isolated GitHub Actions PG17
gate. There is no authorized disposable PostgreSQL service in this execution
environment, so these cases have not been represented as locally passed.

## Factory completion transaction

The Factory branch's completion producers now execute inside the same
`persistRunCompletion` transaction as its immutable report, worker token
revocation and publication state. One raw PostgreSQL client backs both the
existing skill/Factory stores and Drizzle, including nested application reads.

The lock order is Factory task → issue → skill scope → run → publication.
Task discovery includes historical attempts and question origins/continuations;
multiple tasks and skill scopes are locked in stable order. This preserves the
task-first order used by cancellation and answers while preserving the
issue-before-run order required by scope retirement.

Only the first live completion records validated skill-mount evidence, performs
the existing bounded monitor readback and settles or records questions. Known
optional Factory rejections roll back their savepoint; unexpected errors abort
the entire transaction. Skill provenance errors retain the route's 409 response
and cannot start capture shutdown, publication, or dispatch. `finishedAt` uses
the database's `clock_timestamp()` after monitor readback.

The additional PostgreSQL regression injects a publication-state constraint
failure after skill evidence was written, then asserts that evidence, terminal
state, token revocation and publication state all roll back together. It also
checks that a terminal replay cannot replace the frozen report or append a new
skill receipt. This regression also awaits the real isolated CI PostgreSQL run.
