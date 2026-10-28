# Suggestions schedules

Three schedules keep the 建议 panel and each person's profile current (R-21, R-73). Vercel Hobby runs crons at most once a day, so a Cloudflare Worker, `cloudflare/suggestions-cron`, fires them instead. The Worker only calls Mikka with a bearer secret; the logic stays in the Next.js app, so the schedules can move to `vercel.json` later without touching the endpoints.

| Cron (UTC) | Endpoint | What it does |
| --- | --- | --- |
| `*/15 * * * *` | `GET /mikka/api/cron/briefings` | Writes the daily briefing for everyone whose local time is past 08:00 and who has none for today yet, and has the Coordinator push it |
| `0 * * * *` | `GET /mikka/api/cron/suggestions-reconcile` | Backfills events a webhook may have missed in the last 26 hours |
| `30 * * * *` | `GET /mikka/api/cron/user-facts` | Merges the profile facts of everyone whose local time is past 04:00 and who has not been merged today |

All three endpoints answer 503 without `CRON_SECRET`, 401 for a wrong bearer, and otherwise a JSON summary of counts (no personal data). Reconciliation also returns 503 when GitHub is unconfigured, or 502 when a source fails. Each stops starting new people after about 40–45 seconds; the next run picks up whoever is left.

## Daily briefing at 08:00 local time

The briefing is delivered by the Coordinator, not shown in 建议 (R-21). Writing a briefing with something in it queues a `daily_briefing` event in the person's Coordinator inbox (dedupe key `daily_briefing:<userId>:<localDate>:<daily|first>`, so at most one push per kind and day) and wakes the Coordinator. The event is triaged as needing the person; the Coordinator writes the briefing in its chat in the person's language, names the most important items, and asks before acting on any of them. An empty day pushes nothing. Where the Coordinator does not run (no AI Gateway), the event waits in the inbox for the next turn.

- Each person's IANA time zone is stored in `user_time_zones` (`drizzle/20261027011046_user_time_zones.sql`). The browser's zone, sent as `tz` when the suggestions list loads, replaces any earlier value. The connect callbacks' IP-derived zone (`x-vercel-ip-timezone`) only fills a gap. A person without a stored zone gets no scheduled briefing; the lazy path below still serves them.
- A zone is due from 08:00 until its local midnight. Every run writes the briefing for due people that have no row for their local date, so a briefing lands within 15 minutes of 08:00 and a missed run is caught up by the next one the same day. The `(userId, localDate)` primary key keeps it to one per day, even with overlapping runs.
- A day with nothing to report still gets a row with `total = 0`, so it is not recomputed every 15 minutes; nothing is pushed for it.
- Connecting an app still writes a `first` briefing at once (`writeFirstBriefing`) and the Coordinator pushes it. One written before 08:00 is replaced by that day's daily briefing, which is pushed too; one written after 08:00 is today's briefing.
- The lazy path in `GET /api/suggestions` stays as the fallback: from 08:00 on, a read that finds no briefing for today writes and pushes it the same way. Before 08:00 it writes nothing early. The list's response no longer carries the briefing.

## Nightly profile merge from 04:00 local time

Each stored notification is read once for facts about the person after it is rated (`lib/profile/extract.ts`, R-73, `docs/design/proactive.md` § 2.2); the facts go to `user_facts` (`drizzle/20261027231815_user_facts.sql`). Once a local day the merge (`lib/profile/facts.ts` `planConsolidation`, no model call):

- turns scattered purchases into patterns: three or more on one topic become an interest (川菜调料 ×3 → 川菜), three or more orders from one merchant at one time of day become a routine, two or more places in one area become a place;
- expires deadlines and subscriptions past `expiresAt`;
- fades facts not seen for 30 days (confidence × 0.95 a night, expired below 0.2);
- keeps one answer per slot (for example `home_city`): the person's correction, else the newest.

Proactive work is behind four switches (`docs/design/proactive.md` § 3), and any one of them off stops it:

1. `PROACTIVE_PROFILE_ENABLED` (deployment, off unless `1` or `true`) gates extraction and this merge. Off, the endpoint answers 200 with `{"skipped":"disabled"}`. `PROACTIVE_RESEARCH_ENABLED` is reserved for the phase 2 research run and nothing reads it yet. Self-hosters without PostHog leave both off.
2. The PostHog flag `mikka-proactive-profile` must be exactly `true` for the person (distinct id = Mikka user id, as in the browser). It is checked on the server with `posthog-node` (`lib/posthog-server.ts`), cached 5 minutes per person, and fails closed: no `NEXT_PUBLIC_POSTHOG_KEY`, an error, a 2-second timeout or any other value reads off. With `POSTHOG_SECRET_KEY` (a project secret or personal API key) flags are evaluated locally from polled definitions; without it each uncached check asks PostHog. `mikka-proactive-research` is reserved for phase 2.
3. The person's 记忆 switch, `user_preferences."memoryEnabled"`: one switch for web and mobile Settings (`lib/preferences.ts`), which also keeps memory out of the Coordinator prompt.
4. A daily cap of 200 extraction calls per person and UTC day (`PROFILE_DAILY_CALLS`). Each call is counted before it is made, and its tokens are added after, in `proactive_usage` (person, UTC day, kind). Each call is also sent to PostHog as an `$ai_generation` event (model, input and output tokens, latency; never the prompt or answer), best effort, so cost per person shows in PostHog.

Set the environment values in Infisical, never in source.

Facts the person corrected in 记忆 are never faded or overwritten. A person is due from 04:00 their time (the zone in `user_time_zones`, UTC without one); `user_fact_consolidations.consolidatedOn` holds the local date of the last merge and is claimed before merging, so overlapping runs merge a person once a day. A person with 记忆 off is not merged and nothing is extracted for them. The run starts no new people after about 40 seconds; the next hourly run picks up whoever is left.

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

The Worker logs each endpoint path, HTTP status, and whitelisted numeric summary counts; request failures reject the scheduled run. Public Worker and version preview URLs are disabled.

Upload `cloudflare/suggestions-cron/src/index.mjs` as an ES module from the
reviewed commit using the authorized Cloudflare API credential. It has no
imports and needs no build. Apply all three crons, `MIKKA_URL`, and observability
settings from `wrangler.jsonc` separately when uploading through the API.

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

The ordinary `pnpm build` does not run migrations. Review the pending SQL
manifest, then configure the authorized production deployment's Build Command
as `pnpm migrate && pnpm build`. This invokes `scripts/migrate.mjs` in the
production build; do not apply the Production SQL manually. Initialize a
Preview only against its dedicated cloud database with `MIGRATE=1`.

GitHub's redelivery API returns 202 when it accepts the request. The receiving
Mikka webhook also returns 202 before asynchronous suggestion ingestion
finishes. Neither status proves a suggestion was saved. Verify the actual
GitHub delivery response and resulting ingestion separately, and inspect the
Cloudflare scheduled-run history for every trigger.

Run the source-only Worker checks with:
`node --test cloudflare/suggestions-cron/src/index.test.mjs`.
