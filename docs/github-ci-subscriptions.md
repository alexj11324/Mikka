# GitHub CI subscriptions

## Rollout switch (default off)

Everything below is behind `MIKKA_CI_RESUME_ENABLED` (`lib/github/ci/flag.ts`), on only when it is exactly `1`. It is a host environment switch like `MIKKA_PERSONAL_MAILBOX_ENABLED`; unset it (and redeploy) to turn the feature off again. With it off:

- publishing a task's PR writes no watch row;
- `POST /api/webhooks/github` neither reads nor writes the CI tables and answers exactly as before;
- `GET /api/cron/briefings` runs no CI reconcile or escalation retry and returns its previous body;
- failed `workflow_run` deliveries are not redelivered;
- a CI follow-up queued while the switch was on is stopped at claim (`stopReason` `superseded`, error "CI resume is disabled."), so it never reaches a model.

No model call and no CI database write happen while the switch is off. The two migrations are still required before deploying this code, because `agent_runs."ciContinuation"` is read by the claim and retry paths.

## Failure isolation

- Webhook: recording a CI event is its own sub-handler. Any error is logged by name only and the webhook still returns 202 and runs the suggestion ingest; the CI transaction rolls back without partial writes. A lost wakeup is caught by the cron reconcile while the watch is open. The deferred CI reconcile runs after the suggestion ingest.
- Publication: the watch is registered under a savepoint; a failure never blocks the publication receipt (a later webhook can backfill the watch from that receipt).
- Cron: CI reconcile is an isolated sub-task of the briefing cron. It never throws, its result is reported under `ci` in the body (`status: 'ok' | 'failed'`, counts), and it never changes the cron's HTTP status.

## Cost bounds

A resume is a model call in the task's original session. It is bounded by:

- **Who:** only a task whose own run published the PR and then finished (`succeeded`/`stopped` with `stopReason` `submitted`) with a resumable original session; subscription-backed and skill-selected runs are excluded. Nothing else is watched.
- **Dedupe (the only one):** `github_ci_resumes` holds one row per (task, PR, head SHA). A head resumes the task's session at most once, across duplicate deliveries, concurrent workers and later reruns on the same SHA. A follow-up retired before any claim (newer head or newer stable result) releases its row, because it spent no model call, so the newest result for that head takes its place.
- **Cap (the only one):** at most 3 resumes per task in any rolling 24 hours (`CI_RESUMES_PER_TASK_PER_DAY` in `lib/github/ci/budget.ts`). A stable head over the cap records `lastError` `resume_cap_reached` and is not resumed; if it is still the current head when the window frees a slot, it resumes then. There is no separate follow-up-generation limit: an agent that keeps pushing new heads is held to 3 resumes per task per day, with no human hand-off when the cap is reached.
- **Rate:** results are only read on a webhook (one reconcile, 30 s budget) or by the 15-minute cron (at most 4 watches per run); pending snapshots never call a model.

## Behavior

Mikka watches PRs published by a task run, using its existing GitHub App. A signed `workflow_run` or relevant PR webhook only schedules a read for an already bound task; it does not itself start a model. When recording succeeds it is durable before the webhook acknowledges; when it fails, the webhook still acknowledges (see Failure isolation) and the cron reconcile picks the watch up. The existing 15-minute briefing cron provides bounded reconciliation and retry; the webhook also attempts a reconciliation after acknowledgement. Failed App deliveries are eligible for the existing bounded redelivery process. No repository workflow changes are required.

The reader obtains a repository-scoped installation token with read access to pull requests, checks and commit statuses; Actions read access is used to recover missing workflow completion events. It verifies the PR is open, still belongs to the task branch and repository, and reads the current head, check runs and combined status contexts. Permission, network and incomplete or oversized responses fail closed and are recorded for retry; they are not successes. The watch remains active for 48 hours after publication or a relevant webhook. Later relevant events can reactivate it; a third-party check that appears after the watch expires without a GitHub Actions or PR event is not observed. Known pending Actions attempts are refreshed through the Actions API, but a new attempt is not detectable if all its webhooks are lost and its check/status snapshot is unchanged.

All known checks must finish. Failure, cancellation, timeout, action-required, stale and startup failure are failures. Skipped and neutral checks are non-failing but do not alone establish success; an all-skipped/neutral snapshot or an unknown conclusion stays pending. A success needs at least one successful check or status and no failed checks. A complete snapshot must remain unchanged for at least two minutes before dispatch; normal cron cadence can make delivery later. The bounded quiet window cannot prove a provider will not register a check later: a check that registers after a head was resumed is not reported for that head. GitHub's check-run API only covers the 1,000 most recent check suites; this implementation cannot detect every provider-side suite truncation. It fails closed when its own response limits are exceeded and does not claim complete coverage beyond the provider's limit.

GitHub is read once per reconcile pass, and that read first rechecks the person's GitHub access to the same installation and repository. There is no second read at claim: the claim checks only this watch's database row (current head, stable result, origin run, not expired) and its generation fence, and requires the original session, device, agent and repository. A newer head or result seen by a webhook or the 15-minute poll retires the unclaimed follow-up first, so it becomes stale at claim and is retired there too. A result that changes on GitHub in the seconds between a reconcile and a claim, before any webhook or poll records it, can still be delivered. The follow-up tells the agent to review the result before acting. A CI follow-up does not silently fall back to a new session. CI-created commits are watched too, within the same cap. Subscription-bound workers and runs with selected skills are currently unsupported for original-session CI follow-ups; they remain pending rather than falling back to a different session.

Deployment requires applying the new database migrations and deploying the app; the existing 15-minute scheduled worker must remain active. The App and its repository installation must grant Actions, Checks, Commit statuses and Pull requests read access; no new event subscriptions or persistent permissions are added by this change. A 202 response does not by itself establish durable scheduling, completed reconciliation or Agent execution. Tests with synthetic GitHub responses do not prove a live App installation or production OAuth path.
