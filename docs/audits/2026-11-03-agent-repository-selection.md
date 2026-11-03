# Execution-side repository selection

Tracking: #1126; official subscription acceptance remains tracked in #1124.

## Failure and implementation

The task entry can select the wrong repository. A shell `cd` or nested clone
does not change the daemon worktree, device repository, candidate or checks.
Occurrence 9/10, impact 8/10, risk 72: an execution otherwise writes or hands
in the wrong checkout despite having the owner's GitHub access.

An execution Agent now receives `switch_repository`. It chooses a target and
explains the task/repository mismatch; the MCP process records actual origin
and HEAD. The handoff ends this execution without submitting a delivery.
Independent checks do not receive the tool, and the host also rejects a
check-stage handoff.

The host locks the current Factory task/run, checks the owner's live GitHub
user/App repository intersection, and registers the target in the same SQL
transaction. A new execution on the original runtime retains the frozen model,
credential source and read-only status. A changed source rolls the whole
switch back. The old run and worktree remain intact; history links the new
execution to it, while the daemon refuses to reuse a worktree from another
repository. Cloud startup is queued after commit through the existing host
workflow. The new repository supplies the later candidate and independent
checks. No publication or acceptance gate is skipped.

Registration accepts an existing transaction: starting and committing a nested
Drizzle database transaction had released the Factory transaction prematurely.
The real PostgreSQL regression exposed that failure before the final fix.
Repeated targets and more than three switches are refused.

## Local evidence

Cloud Linux, isolated PostgreSQL 17 at loopback port 55497; disposable databases
ending in `_e2e`, full migrations, normal store/reconciler/dispatch. No production
SQL writes, provider credentials or provider calls occur in these regressions.

- MCP regression failed before implementation and passed after. Real Git
  evidence, retained dirty checkout and absent check-stage capability are checked.
- 49 daemon Agent/repository/Codex transport tests pass, including fresh A-to-B clone/worktree
  origin/HEAD, retained A bytes and rejection of cross-repository continuation.
  Codex admits only the capabilities in the host-created MCP configuration:
  execution-side repository selection and fixed-check artifact inspection have
  separate grants. Both were declined by its previous fixed hand-in allow-list.
- 19 database tests pass, including normal completion regressions and seven
  selection cases: replay, authorized target, forbidden/invalid target,
  revocation, check-stage refusal, stop precedence, atomic credential-fallback
  rollback, and the actual cloud queue with the same subscription binding.
  The new candidate names the target repository and its submitted source SHA.
  Provider I/O and the GitHub directory are controlled test boundaries; this
  does not claim a real subscription Agent passed.
- 11 completion/prompt tests pass, including no human-question creation for
  an execution's repository selection.
- Application and daemon type checks and targeted lint pass.

## Live acceptance

Not completed by these local results. Required: an actual official-subscription
Agent receives the wrong repository, chooses the correct authorized repository,
continues in the host's new checkout, and passes independent Factory review
and verification before owner acceptance. Record the immutable application and
worker revisions, actual native sessions, origin, worktree and candidate SHA.

The separate subscription diagnostic run `08a39dd0-9165-4dd5-8b08-7cc751b3d18b`
passed Claude execution and independent review, but its verification did not
start and ended `device_lost` during a production worker release. Its application
version changed during the run, so it is not fixed-version acceptance. Earlier
Claude review and Codex native execution cancellation remains unresolved.
