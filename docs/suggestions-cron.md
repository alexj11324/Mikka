# Suggestions schedules

Three schedules keep the 建议 page and each person's profile current (R-21, R-73). They do not use Vercel Cron (`vercel.json` has no crons). The Cloudflare Worker `cloudflare/suggestions-cron` (`mikka-suggestions-cron`) fires them. The Worker only calls Mikka with a bearer secret; the logic stays in the
Hono/Nitro API. Community deployments can run the same schedule through the
[built-in scheduler](self-hosting-realtime.md#scheduled-work).

Wrangler configures one native Cloudflare Cron Trigger, `0,15,30,45 * * * *`, so the Worker wakes four times per hour. On each run it reads Cloudflare's `scheduledTime` and calls, in parallel (`src/index.mjs`):

| When (UTC) | Endpoints |
| --- | --- |
| Minutes 0, 15, 30 and 45 | `/api/cron/reconcile`, `/api/cron/ops-monitor`, `/api/cron/briefings` |
| Minute 0 | `/api/cron/subscriptions`, `/api/cron/suggestions-reconcile` |
| Minute 30 | `/api/cron/user-facts` |

Account deletion and audit retention also use due timers and the reconcile
safety sweep. The Worker does not call their individual cron routes hourly.

Coordinator wakes, schedules and run recovery are event-driven (#1212, #1371): each starts from the write that makes it due, and work due later runs on a durable Workflow timer (`workflows/due-timer`, the Coordinator wake deadline) at its persisted time. `/api/cron/reconcile` is the one safety net: one statement (`lib/reconcile-due.ts`) says which of the three has work already due that no wake or timer picked up, and only that work runs and its timer is re-armed. Worst case, work whose start was lost runs 15 minutes after its due time. The old `/api/cron/coordinator-wakes`, `/api/cron/schedules` and `/api/cron/run-recovery` routes still work when called by hand.

Because it uses `scheduledTime`, a late run still does the work of the minute it was scheduled for. Each endpoint gets its call even when another fails (`Promise.allSettled`); any failure then fails the run. `runSchedule` still accepts the older single cron strings (`*/15 * * * *`, `0 * * * *`, `30 * * * *`) and then calls only that endpoint. During Cloudflare propagation, an event from the previous minute trigger uses its scheduled time and skips minutes without due work. Deployment steps: [`operations/minute-worker-deployment.md`](operations/minute-worker-deployment.md).

The three suggestions endpoints:

| Cadence (UTC) | Endpoint | What it does |
| --- | --- | --- |
| Every 15 minutes | `GET /mikka/api/cron/briefings` | Writes the daily briefing for everyone whose local time is past 08:00 and who has none for today yet, and has the Coordinator push it |
| Hourly, minute 0 | `GET /mikka/api/cron/suggestions-reconcile` | Backfills events a webhook may have missed in the last 26 hours, and, in parallel, sweeps Factory monitor completions (see below) |
| Hourly, minute 30 | `GET /mikka/api/cron/user-facts` | Merges the profile facts of everyone whose local time is past 04:00 and who has not been merged today |

All three endpoints answer 503 without `CRON_SECRET`, 401 for a wrong bearer, and otherwise a JSON summary of counts (no personal data). Reconciliation also returns 503 when GitHub is unconfigured, or 502 when a source fails. A provider that refuses one person's own authorization (a revoked or expired token) is not a failed source: that person's app is skipped and counted under `reconnect`, and the run carries on with everyone else. Each stops starting new people after about 40–45 seconds; the next run picks up whoever is left.

## Daily briefing at 08:00 local time

The briefing is delivered by the Coordinator, not shown in 建议 (R-21). Writing a briefing with something in it queues a `daily_briefing` event in the person's Coordinator inbox (dedupe key `daily_briefing:<userId>:<localDate>:<daily|first>`, so at most one push per kind and day) and wakes the Coordinator. The event is triaged as needing the person; the Coordinator writes the briefing in its chat in the person's language, names the most important items, and asks before acting on any of them. An empty day pushes nothing. Where the Coordinator does not run (no AI Gateway), the event waits in the inbox for the next turn.

- Each person's IANA time zone is stored in `user_time_zones` (`drizzle/20261027011046_user_time_zones.sql`). The browser's zone, sent as `tz` when the suggestions list loads, replaces any earlier value. The connect callbacks' IP-derived zone (`x-vercel-ip-timezone`) only fills a gap. A person without a stored zone gets no scheduled briefing; the lazy path below still serves them. A zone the person picks in Settings (`source = 'manual'`, `drizzle/20261029213936_settings_preferences.sql`) is never replaced by either; people with 每日建议 off, or 记忆 off, are skipped (docs/settings-backend/prefs.md).
- A zone is due from 08:00 until its local midnight. Every run writes the briefing for due people that have no row for their local date, so a briefing lands within 15 minutes of 08:00 and a missed run is caught up by the next one the same day. The `(userId, localDate)` primary key keeps it to one per day, even with overlapping runs.
- A day with nothing to report still gets a row with `total = 0`, so it is not recomputed every 15 minutes; nothing is pushed for it.
- Connecting an app still writes a `first` briefing at once (`writeFirstBriefing`) and the Coordinator pushes it. One written before 08:00 is replaced by that day's daily briefing, which is pushed too; one written after 08:00 is today's briefing.
- The lazy path in `GET /api/suggestions` stays as the fallback: from 08:00 on, a read that finds no briefing for today writes and pushes it the same way. Before 08:00 it writes nothing early. The list's response no longer carries the briefing.

## Nightly profile merge from 04:00 local time

Each stored notification is read once for facts about the person after it is rated (`lib/profile/extract.ts`, R-73, `docs/design/proactive.md` § 2.2); the facts go to `user_facts` (`drizzle/20261027231815_user_facts.sql`). Once a local day the merge (`lib/profile/facts.ts` `planConsolidation`) runs a few code rules and asks the Decision API the rest (decision 2026-11-01-1500):

- code rule: a deadline or subscription past `expiresAt` expires;
- Decision API: whether a group of purchases, orders or places is a lasting pattern (interest, routine, place); a count alone never makes one;
- Decision API: whether a fact not seen for a while is kept, lowered or expired; the person's corrections never fade;
- one answer per slot (for example `home_city`): the person's correction wins, otherwise the Decision API picks;
- a call without an answer changes nothing; those items are asked again the next night.

Proactive work is behind four switches (`docs/design/proactive.md` § 3), and any one of them off stops it:

1. The deployment switch, PostHog's `mikka-proactive-profile-deployment` (`lib/deployment-switches.ts`; while PostHog gives no answer, the old `PROACTIVE_PROFILE_ENABLED` of `1` or `true`), gates extraction and this merge. Off, the endpoint answers 200 with `{"skipped":"disabled"}`. Self-hosters without PostHog leave it off.
2. The PostHog flag `mikka-proactive-profile` must be exactly `true` for the person (distinct id = Mikka user id, as in the browser). It is checked on the server with `posthog-node` (`lib/posthog-server.ts`), cached 5 minutes per person, and fails closed: no `NEXT_PUBLIC_POSTHOG_KEY`, an error, a 2-second timeout or any other value reads off. With `POSTHOG_SECRET_KEY` (a project secret or personal API key) flags are evaluated locally from polled definitions; without it each uncached check asks PostHog. `mikka-proactive-research` is reserved for phase 2.
3. The person's 记忆 switch, `user_preferences."memoryEnabled"`: one switch for web and mobile Settings (`lib/preferences.ts`), which also keeps memory out of the Coordinator prompt.
4. A daily cap of 200 extraction calls per person and UTC day (`PROFILE_DAILY_CALLS`). Each call is counted before it is made, and its tokens are added after, in `proactive_usage` (person, UTC day, kind). Each call is also sent to PostHog as an `$ai_generation` event (model, input and output tokens, latency; never the prompt or answer), best effort, so cost per person shows in PostHog.

Set the environment values in Infisical, never in source.

Facts the person corrected in 记忆 are never faded or overwritten. A person is due from 04:00 their time (the zone in `user_time_zones`, UTC without one); `user_fact_consolidations.consolidatedOn` holds the local date of the last merge and is claimed before merging, so overlapping runs merge a person once a day. A person with 记忆 off is not merged and nothing is extracted for them. The run starts no new people after about 40 seconds; the next hourly run picks up whoever is left.

## Cron GET exception and the Factory monitor sweep

Mikka's rule is that GET is strictly read-only. Cron endpoints are the one documented exception
(the Vercel Cron pattern, which only issues GET): `/api/cron/*` handlers may write, provided that
they accept nothing but the exact `CRON_SECRET` bearer (503 when unset, 401 otherwise, checked
before any read or write) and every write is idempotent, so a repeated or overlapping run converges.

The hourly `suggestions-reconcile` run also sweeps the Factory monitor stage when
`factoryLifecycleEnabled()` admits both deployment switches. They default on.
`mikka-factory-routing-off` and `mikka-factory-lifecycle-off` are the PostHog
incident kill switches (`lib/deployment-switches.ts`). Otherwise it reports
`factoryMonitor.enabled: false` and does nothing. It finds `run_finished` events of monitor
attempts that no `factory_monitor_observations` row records, and hands each (user, Bot) scope to that
Bot's `monitor.reconcile`, until 50 seconds after the request started. Observed events are skipped
and replays create no new transition. The response carries
`factoryMonitor: { enabled, scopes, observed, failed, deferred }`; any failed scope answers 502. The backfill and the sweep run independently (`Promise.allSettled`): if either throws, the other still finishes, the answer is 502, `outcome: { suggestions, factoryMonitor }` reports `ok` or `failed` for each, and the failure is logged by name only.
No Worker change, redeploy or new secret is needed: the Worker already calls this fixed path.

## Backfill

Everything read is ingested through `ingestNotifications`, which skips an external id already stored for that person before any model call, so only what a lost delivery missed is judged and added.

| Source | How | Notes |
| --- | --- | --- |
| Gmail | `GMAIL_FETCH_EMAILS`, `in:inbox newer_than:2d`, minus promotions and social | Same message id as the trigger |
| Slack | Not reconciled | Slack is moving off Composio to Mikka's own Slack app; its backfill belongs there |
| Notion | `NOTION_SEARCH_NOTION_PAGE`, most recently edited pages | A page already on file under any edit time is skipped, because the trigger's edit time may be written differently |
| Linear | Replays the window's Issue and Comment deliveries from `linear_sync_inbox` | The inbox stores every signed delivery before it is acknowledged, whichever host received it |
| GitHub | Mikka's GitHub App (`mikka-github`) reads its own webhook delivery log (`GET /app/hook/deliveries`, last 3 hours) and asks GitHub to send again (`POST /app/hook/deliveries/{id}/attempts`) every delivery of a suggestion event (`pull_request`, `issues`, `issue_comment`, `pull_request_review`, `pull_request_review_comment`) that has no 2xx attempt, at most 25 a run | The redelivery reaches `app/api/webhooks/github`, so ingestion and the external-id dedupe are unchanged. The endpoint reports 503 without `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`, and it cannot help while that route answers 503 for want of `GITHUB_WEBHOOK_SECRET` |

People are those in `suggestion_trigger_checks` (opened the list or connected an app through Composio), least recently checked first. The backfill also re-creates missing Composio trigger subscriptions, at most hourly per person.

## Deployment and credentials

The existing quarter-hour `/api/cron/ops-monitor` tick also provides supplier-egress
collection independently of GitHub Actions schedules. It uses only the app's
existing `NEON_API_KEY` and PostHog ingestion key. A dedicated
`state.__providerEgressCollector` key in the latest operational observation
claims work in a short transaction; Neon reads and PostHog delivery run outside
the lock, followed by a short completion transaction. Successful collection next
becomes eligible at the next UTC quarter-hour after its claim started, so nonzero
request latency does not skip that tick. This is one successful collection per
fixed UTC quarter, not a rolling 15-minute gap; old minute callers still receive
`not_due` for the rest of the same quarter. Failures remain eligible one minute
after completion and abandoned claims after two minutes. The current Worker
attempts them at its next eligible quarter-hour tick; these internal deadlines
do not create extra scheduled requests. The ordinary operational collector persists separately
even if supplier collection fails. No supplier bytes or credentials are returned
by the cron endpoint.

Fallback snapshots have `collector_source=cloudflare_provider_fallback` and
`collection_scope=provider`. They omit runtime sample/request fields; they do
not prove GitHub runtime-log sampling recovered. Use `provider_healthy` for
supplier coverage and restrict runtime analysis to
`collection_scope=provider_and_runtime`. Existing budget insights retain the
latest known supplier value and the separate heartbeat detects absent/failed
collection. Do not interpret missing snapshots or stale supplier reports as zero
usage.

The Worker logs each endpoint path, HTTP status, and whitelisted numeric summary counts; request failures reject the scheduled run. Public Worker and version preview URLs are disabled.

Deploy the reviewed Worker and its trigger through the existing Wrangler publisher after the matching application is READY and its migrations have run. Wrangler manages the trigger from `cloudflare/suggestions-cron/wrangler.jsonc`. The release verifies the previous or current cadence before its single write and checks the new cadence afterwards. See [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) and the [deployment runbook](operations/minute-worker-deployment.md).

The Worker needs only `MIKKA_URL` and the secret binding `CRON_SECRET`. Its
secret must match the production app's value in Infisical `prod:/vercel`.
Keep deployment credentials and secret values in Infisical; deliver the Worker
secret through a dedicated `prod:/cloudflare/suggestions-cron` Secret Sync.
Never put either value in source, local environment files, or logs.

The app reads `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` from the Vercel
environment synced from Infisical `prod:/github`. The receiving webhook at
`/mikka/api/webhooks/github` uses `GITHUB_WEBHOOK_SECRET` from the same source;
it must match the GitHub App's webhook secret. GitHub App credentials are not
Worker bindings.

## Acceptance boundary

`pnpm build` runs `scripts/migrate.mjs` last, after the subscription worker,
Agent UI generation, shared frontend/API build and type checks succeed, so a
Vercel production deploy applies pending migrations itself. Do not apply the
Production SQL by hand. Off production it skips unless `MIGRATE=1` (or every
target is a loopback database); initialize any other non-production database
only against its own dedicated database with `MIGRATE=1`. Branches have no
Vercel Preview.

GitHub's redelivery API returns 202 when it accepts the request. The receiving
Mikka webhook also returns 202 before asynchronous suggestion ingestion
finishes. Neither status proves a suggestion was saved. Verify the actual
GitHub delivery response and resulting ingestion separately, and inspect the
Cloudflare scheduled-run history and the Worker log line of each endpoint.

Run the source-only Worker checks with:
`node --test cloudflare/suggestions-cron/src/index.test.mjs`.

## Inbox handling

Rejection, undo and snooze use the [Inbox API](inbox-api.md). Rejected or snoozed
suggestions are excluded from list/briefing reads and Coordinator attention
handoff. Inbox deadlines share the existing schedules due timer; the cron
routes above do not poll for them. Completed handling is recorded from the
source transaction starting at the inbox migration, without historical backfill.
