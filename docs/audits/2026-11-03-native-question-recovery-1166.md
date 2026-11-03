# Explicit recovery of an original subscription session (#1166)

## Scope and evidence

The five unpublished diffs attached to issue #1166 were restored and their exact
UTF-8 byte counts and SHA256 digests matched the handoff. They were reviewed and
applied to `fa65fecd7c7818fef8daa29d5b8d51cff5fdb18f`, preserving #1164.

The observed failure is an original Codex session that executed another tool and
then failed in the managed subscription broker. The broker used to poison every
later request after its first exception. The cause of that first exception is
still unknown. A successful native resume alone is not completed acceptance.

Read-only production inspection on 2026-11-03 confirmed question
`40c859a6-f048-470d-b036-d6e17feb4765` remains blocked at revision 3, task
`9ea956ce-a604-4c2e-a724-fb04fa5a3c9b` remains blocked at revision 13, and the latest
failed continuation is `e57a6d03-510e-496f-bd88-97375318cd9e`. No production task,
answer, session, or machine was changed during that inspection.

## Changes

- Let the official SDK make its own retries after a single broker request fails.
  Every request still performs fresh authorization checks. Closing/revoking the
  broker still closes its requests. No Mikka retry loop or body-cap increase is
  introduced.
- Record only fixed error categories, phases, bounded protocol/status numbers,
  and request byte counts. Provider error text, bodies, and credentials remain
  excluded. Existing quota classification is retained.
- Add an owner-session recovery action with its own stable request ID and
  existing Factory event receipt. Preserve the original answer, fingerprint,
  result, origin run, session, account, and model. Resume from the latest failed
  continuation's actual custody and native history. Missing or mismatched
  history/VM identity fails before transfer; there is no replacement VM or fresh
  SID fallback.
- Connect the existing Retry button to that service. The thread root keeps its
  identity while its current failure display reads the latest run.
- Reject ordinary messages to a failed required-SID continuation before any new
  event or dispatch. Otherwise, `thread_continuation` would cancel the recoverable
  Factory task and create a new request epoch. Successful threads and ordinary
  failed threads retain their existing continuation behavior.

The ordinary-message escape has occurrence 10/10 and impact 8/10: its deterministic
dispatch path cancels the retained task. The missing Retry at the root has
occurrence 10/10 and impact 7/10: a stopped root hides its failed continuation.
Both are exercised by behavior regressions rather than text matching.

## Validation boundaries

Local actions/render regressions first failed in five relevant assertions, then
passed 24/24 after the fixes. The actions suite with Factory flags enabled passed
17/17. Question contract/recovery-route tests passed 11/11. Application typecheck
and strict lint of changed files passed. These are source and fake-service tests,
not evidence of successful provider calls or deployed behavior.

This executor runs as root, rejects switching to a normal user, and denies Unix
socket listening. Its initial hosted/broker test attempt is an environment failure
and is not counted as passing. The existing GitHub Actions daemon job and
PostgreSQL 17 database job must run the relevant suites for the actual PR head.
The new recovery route test is included in `test:factory-routing` so it is not
left outside CI. The new database regression requires failed strict messages to
leave task/question rows and run/event/message counts unchanged.

## Production completion criteria

1. CI passes for the reviewed head. Publish through the existing official-instance
   runtime workflow, preserving stock templates and every official package file.
   Verify the READY application/source/worker digest pair before resuming a task.
2. Through normal owner APIs, refresh the terminal failed run's Mikka runtime.
   Compare both original and failed native histories, original SID, worktree,
   Git snapshot, and exact 85-byte artifact before and after.
3. Use existing Retry once; reconcile unknown HTTP outcomes against its stable
   receipt. Verify the new run retains the original SID and official binding,
   then completes independent review, independent verification, and actual owner
   UI acceptance with a persisted acceptance record.
4. Separately verify Codex subscription, Claude Code subscription, and API-key
   execution. Subscription scenarios must not silently fall back to an API key.
   Verify both subscriptions' autonomous repository selection/authorized clone
   and retained old checkout scenario.

Keep the previous failed evidence and protected Acme VM intact. Do not re-label
the historical screenshots or claim that the unavailable original offline WIP
has been recovered. This document records the implementation and remaining gate;
it is not a production completion receipt.

Reference: [official app-server errors and retries](https://developers.openai.com/codex/app-server#errors).
