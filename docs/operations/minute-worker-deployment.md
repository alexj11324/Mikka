# Existing minute Worker

`mikka-suggestions-cron` uses one Cloudflare `* * * * *` trigger. The account's
existing Free-plan trigger limit rejected the earlier four-trigger configuration;
the Worker now dispatches the same cadences from that one scheduled event:

- Every minute: wakes, schedules, run recovery, account deletion, audit maintenance
  and operational observations.
- UTC minutes 0, 15, 30 and 45: briefings.
- UTC minute 0: suggestions reconciliation.
- UTC minute 30: user facts.

Dispatch uses Cloudflare's `scheduledTime`, so a delayed invocation retains its
original cadence. Each endpoint still gets its tick if another endpoint fails.
The older individual cron strings remain accepted during deployment transition.
Endpoint idempotency and authorization are unchanged.

Deploy the existing Worker only after the matching Mikka application is READY
and its tracked migrations have run. Keep the existing native-synced
`CRON_SECRET`, canonical `MIKKA_URL`, disabled public Worker/preview URLs and
observability. No new Worker, paid plan, identity or secret-delivery mechanism is
required. Verify the remote trigger list and secret-binding presence after
deployment; record actual production observation separately from source tests.
