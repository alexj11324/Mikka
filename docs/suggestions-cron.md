# Suggestions schedules

Two schedules keep the 建议 panel current (R-21). Vercel Hobby runs crons at most once a day, so a Cloudflare Worker, `cloudflare/suggestions-cron`, fires them instead. The Worker only calls Mikka with a bearer secret; the logic stays in the Next.js app, so the schedules can move to `vercel.json` later without touching the endpoints.

| Cron (UTC) | Endpoint | What it does |
| --- | --- | --- |
| `*/15 * * * *` | `GET /mikka/api/cron/briefings` | Writes the daily briefing for everyone whose local time is past 08:00 and who has none for today yet, and has the Coordinator push it |
| `0 * * * *` | `GET /mikka/api/cron/suggestions-reconcile` | Backfills events a webhook may have missed in the last 26 hours |

Both endpoints answer 503 without `CRON_SECRET`, 401 for a wrong bearer, and otherwise a JSON summary of counts (no personal data). Reconciliation also returns 503 when GitHub is unconfigured, or 502 when a source fails. Each stops starting new people after about 40–45 seconds; the next run picks up whoever is left.

## Daily briefing at 08:00 local time

The briefing is delivered by the Coordinator, not shown in 建议 (R-21). Writing a briefing with something in it queues a `daily_briefing` event in the person's Coordinator inbox (dedupe key `daily_briefing:<userId>:<localDate>:<daily|first>`, so at most one push per kind and day) and wakes the Coordinator. The event is triaged as needing the person; the Coordinator writes the briefing in its chat in the person's language, names the most important items, and asks before acting on any of them. An empty day pushes nothing. Where the Coordinator does not run (no AI Gateway), the event waits in the inbox for the next turn.

- Each person's IANA time zone is stored in `user_time_zones` (`drizzle/20261027011046_user_time_zones.sql`). The browser's zone, sent as `tz` when the suggestions list loads, replaces any earlier value. The connect callbacks' IP-derived zone (`x-vercel-ip-timezone`) only fills a gap. A person without a stored zone gets no scheduled briefing; the lazy path below still serves them.
- A zone is due from 08:00 until its local midnight. Every run writes the briefing for due people that have no row for their local date, so a briefing lands within 15 minutes of 08:00 and a missed run is caught up by the next one the same day. The `(userId, localDate)` primary key keeps it to one per day, even with overlapping runs.
- A day with nothing to report still gets a row with `total = 0`, so it is not recomputed every 15 minutes; nothing is pushed for it.
- Connecting an app still writes a `first` briefing at once (`writeFirstBriefing`) and the Coordinator pushes it. One written before 08:00 is replaced by that day's daily briefing, which is pushed too; one written after 08:00 is today's briefing.
- The lazy path in `GET /api/suggestions` stays as the fallback: from 08:00 on, a read that finds no briefing for today writes and pushes it the same way. Before 08:00 it writes nothing early. The list's response no longer carries the briefing.

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
imports and needs no build. Apply both crons, `MIKKA_URL`, and observability
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

GitHub's redelivery API returns 202 when it accepts the request. The receiving
Mikka webhook also returns 202 before asynchronous suggestion ingestion
finishes. Neither status proves a suggestion was saved. Verify the actual
GitHub delivery response and resulting ingestion separately, and inspect the
Cloudflare scheduled-run history for both triggers.

Run the source-only Worker checks with:
`node --test cloudflare/suggestions-cron/src/index.test.mjs`.
