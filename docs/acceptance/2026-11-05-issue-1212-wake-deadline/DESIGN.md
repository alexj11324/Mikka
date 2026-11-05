# Coordinator wake deadlines — bounded first increment

Status: design candidate; no implementation, runtime test, production call, or release yet.

## Existing source and scope

Reviewed source is Mikka `2b25caad1608df6a2a54d5e18e798b3c9807ce89`.
The next implementation branch must recheck main and preserve subsequent changes.

* `lib/coordinator/wake-recovery.ts` owns the durable inbox claim: an owner/Bot advisory lock, at most 50 events, 120-second wake lease, 8 attempts, and 60/120/240/480/900-second backoff. `failed` compares the old lease before updating; `replay` is explicitly bounded to exhausted pending events.
* `lib/coordinator/wake.ts` performs the immediate attempt; `retryCoordinatorWakes` repairs lost producers and interrupted Coordinator turns every minute.
* `coordinator_events` already persists `wakeAttempts`, `nextWakeAt`, `wakeLeaseUntil`, and `wakeLastError`. No new outbox or copy of notification content is needed.
* `workflows/coordinator/workflow.ts` already uses the deployed Workflow runtime. `workflows/run-publication/workflow.ts` already uses durable `sleep`.
* Package `workflow` is fixed at 5.2.3. Its official source tag is `d9bcbf62d39a61eac070ca67111b90c425e04d05`. The version's `sleep(Date)` is a durable timer. Its `start` API creates a new run per call and explicitly lacks atomic start-and-hook registration. Newer online experimental APIs are not assumed.

## Proposed one-purpose change

Keep the first immediate wake and its response semantics. After the actual claim/delivery outcome commits, start a bounded recovery workflow for that batch of events. Its arguments contain only owner ID, Bot ID, and the exact host scheduling fields returned by SQL; never event payload, chat text, credentials, or a model selection.

The workflow sleeps until the persisted absolute deadline. A database step then takes the same owner/Bot advisory lock and verifies exact event versions before doing any retry. This verification includes owner, Bot, event ID, attempt number, next-wake timestamp, lease timestamp, undelivered state, non-background tier, and the existing attempt cap.

The resulting transition is one of:

| Database observation | Action |
| --- | --- |
| Original events consumed, background, deleted, replayed, or superseded | Finish the old workflow without a claim or model call. |
| Ticket is current but its deadline has not arrived | Sleep to that same absolute deadline. |
| A real wake/session lease still blocks this owner/Bot | Sleep to the blocking lease's actual expiry; do not add an attempt. |
| Current batch is due and eligible | Use the existing claim and delivery path, then carry the next committed ticket. |
| Delivery failed or triage remains pending | Keep the existing error code and backoff, then sleep until the new persisted timestamp. |
| Turn start accepted | Keep the existing 120-second recovery lease; at its expiry, check whether the batch was consumed. |
| Attempt cap reached | Finish; preserve existing exhaustion notice and explicit replay semantics. |

The exact ticket comparison and claim must occur in one transaction. A stale timer must not first do an unlocked read and then call the unrestricted scope claim. Concurrent cron delivery or another timer may win, but cannot make the losing timer increment a replacement event's attempt.

The initial delivery arms at most one recovery workflow. When that workflow itself retries, it carries the returned ticket in its loop instead of recursively starting more recovery workflows. There is no permanent per-Bot workflow and no timer when there is no original pending batch.

## Commit and crash boundaries

The existing claim owns an explicit PostgreSQL transaction. Scheduling must happen only after confirmed COMMIT. The failure-state update must likewise return a ticket only after its own confirmed transaction, rather than starting a workflow from an ambient uncommitted pool query.

An unknown Workflow `start` result does not justify an immediate blind start retry. Log a fixed failure code and keep the durable inbox intact. If duplicate workflow runs nevertheless exist, exact database ticket/claim guards converge without duplicate attempt increments.

This increment deliberately retains the existing minute sweep. It still repairs producer COMMIT-to-start gaps, a process lost before arming the deadline workflow, workflow infrastructure failure, legacy null-Bot events, and interrupted Coordinator turns. A recovery step lost after its database mutation but before its Workflow completion record can leave a stale ticket; the independent sweep remains the recovery path for that gap.

Consequently this PR establishes deadline-driven recovery for armed batches. It does **not** complete #1212 D, prove that all event producers arm recovery, eliminate the minute route, or claim an egress reduction before measurement. Broad producer coverage and a lower-frequency reconciliation pass require a later independently reviewed increment.

## Resource and safety boundaries

Use the existing Workflow deployment, SDK, application database, and internal call paths. No Cloudflare namespace, alarm endpoint, credential, API route, production setting, or public start input is added. Schedules, run recovery, and A's stop/pause/revoke/approval checks remain outside this change. Built-in Coordinator/Decision behavior is retained; offline tests mock those boundaries and invoke no paid model.

## Required verification

1. Real PostgreSQL: before deadline no claim; at exact deadline one claim; active wake/session lease blocks until its actual boundary.
2. Real PostgreSQL: 10 concurrent timers and cron contend for one batch; only one increments attempts. Another owner/Bot is independent.
3. Real PostgreSQL: stale lease, delivered/background row, explicit replay, and replacement claim cannot be revived by the old ticket. Partial remaining batches are still handled without including unrelated new events.
4. Real PostgreSQL: preserve all existing backoff, attempt-8, exhaustion, process-exit, and old-completion tests without relaxing assertions.
5. Real PostgreSQL: COMMIT failure/ROLLBACK produces no start; start failure leaves committed recovery metadata; start accepted with lost response cannot double-claim.
6. Actual Workflow compilation and local durable-timer wiring, using the repository's installed 5.2.3 docs and runtime. Pure mocked `sleep` tests alone do not establish runtime durability.
7. Relevant Coordinator and cron regression suites, typecheck, lint, and workflow schema/type generation. No UI changes or screenshot claim.
8. The issue body's production and fixed-hour gates remain unsatisfied until separately performed; no merge or production acceptance is claimed by offline gates.

## Version-specific references

* https://github.com/alexj11324/Mikka/blob/2b25caad1608df6a2a54d5e18e798b3c9807ce89/lib/coordinator/wake-recovery.ts
* https://github.com/alexj11324/Mikka/blob/2b25caad1608df6a2a54d5e18e798b3c9807ce89/lib/coordinator/wake.ts
* https://github.com/vercel/workflow/blob/d9bcbf62d39a61eac070ca67111b90c425e04d05/docs/content/docs/v5/api-reference/workflow/sleep.mdx
* https://github.com/vercel/workflow/blob/d9bcbf62d39a61eac070ca67111b90c425e04d05/docs/content/docs/v5/api-reference/workflow-api/start.mdx
* https://github.com/vercel/workflow/blob/d9bcbf62d39a61eac070ca67111b90c425e04d05/docs/content/docs/v5/foundations/idempotency.mdx
