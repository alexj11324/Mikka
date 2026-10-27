# Suggestions schedules

Two schedules keep the 建议 panel current (R-21). Vercel Hobby runs crons at most once a day, so a Cloudflare Worker, `cloudflare/suggestions-cron`, fires them instead. The Worker only calls Mikka with a bearer secret; the logic stays in the Next.js app, so the schedules can move to `vercel.json` later without touching the endpoints.

| Cron (UTC) | Endpoint | What it does |
| --- | --- | --- |
| `*/15 * * * *` | `GET /mikka/api/cron/briefings` | Writes the daily briefing for everyone whose local time is past 08:00 and who has none for today yet |
| `0 * * * *` | `GET /mikka/api/cron/suggestions-reconcile` | Backfills events a webhook may have missed in the last 26 hours |

Both endpoints answer 503 without `CRON_SECRET`, 401 for a wrong bearer, and otherwise a JSON summary of counts (no personal data). Each stops starting new people after about 40–45 seconds; the next run picks up whoever is left.

## Daily briefing at 08:00 local time

- Each person's IANA time zone is stored in `user_time_zones` (`drizzle/20261027011046_user_time_zones.sql`). The browser's zone, sent as `tz` when the suggestions list loads, replaces any earlier value. The connect callbacks' IP-derived zone (`x-vercel-ip-timezone`) only fills a gap. A person without a stored zone gets no scheduled briefing; the lazy path below still serves them.
- A zone is due from 08:00 until its local midnight. Every run writes the briefing for due people that have no row for their local date, so a briefing lands within 15 minutes of 08:00 and a missed run is caught up by the next one the same day. The `(userId, localDate)` primary key keeps it to one per day, even with overlapping runs.
- A day with nothing to report still gets a row with `total = 0`, so it is not recomputed every 15 minutes; the API shows no briefing for it.
- Connecting an app still writes a `first` briefing at once (`writeFirstBriefing`). One written before 08:00 is replaced by that day's daily briefing; one written after 08:00 is today's briefing.
- The lazy path in `GET /api/suggestions` stays as the fallback: from 08:00 on, a read that finds no briefing for today writes it the same way. Before 08:00 it shows the latest briefing from the last 24 hours and writes nothing early.

## Backfill

Everything read is ingested through `ingestNotifications`, which skips an external id already stored for that person before any model call, so only what a lost delivery missed is judged and added.

| Source | How | Notes |
| --- | --- | --- |
| Gmail | `GMAIL_FETCH_EMAILS`, `in:inbox newer_than:2d`, minus promotions and social | Same message id as the trigger |
| Slack | `SLACK_SEARCH_MESSAGES` after yesterday, direct and group messages only | Channel messages are left out: search reaches every channel the person can see, far more than the trigger delivers |
| Notion | `NOTION_SEARCH_NOTION_PAGE`, most recently edited pages | A page already on file under any edit time is skipped, because the trigger's edit time may be written differently |
| Linear | Replays the window's Issue and Comment deliveries from `linear_sync_inbox` | The inbox stores every signed delivery before it is acknowledged, whichever host received it |
| GitHub | Not reconciled | Sign-in grants no token that can list a person's review requests or notifications, and the repository webhook has no store to replay from |

People are those in `suggestion_trigger_checks` (opened the list or connected an app through Composio), least recently checked first. The backfill also re-creates missing Composio trigger subscriptions, at most hourly per person.

## Deploy the Worker

```sh
cd cloudflare/suggestions-cron
pnpm exec wrangler deploy
```

`wrangler.jsonc` sets `MIKKA_URL` to the production app, `https://app.aspectlylabs.com/mikka`, has no public route (`workers_dev: false`), and needs no Hyperdrive binding. Deploy previews are not scheduled: check a Preview by calling its endpoints by hand with its `CRON_SECRET`.

## Secrets

The Worker needs one secret, `CRON_SECRET`, and it must equal the app's `CRON_SECRET` in the same environment. Never put the value in the repository or in `wrangler.jsonc`.

| Where | Name | Source |
| --- | --- | --- |
| Vercel (Production) | `CRON_SECRET` | Already stored in Infisical `prod:/vercel` and synced to Vercel |
| Worker `mikka-suggestions-cron` | `CRON_SECRET` | New Infisical folder `prod:/cloudflare/suggestions-cron` holding only a reference to `prod:/vercel` `CRON_SECRET`, delivered by a new native Cloudflare Workers sync to `mikka-suggestions-cron` |

Use a folder of its own instead of the existing `/cloudflare` folder, which also holds the Linear OAuth and webhook secrets this Worker does not need. Deploy the Worker once before creating the sync, so the sync has a destination.

After deploying, check the cron history in the Cloudflare dashboard (Workers → `mikka-suggestions-cron` → Settings → Triggers → Cron events) and the Worker logs, which record each endpoint's status and summary.
