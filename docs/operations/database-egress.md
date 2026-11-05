# Database transfer monitoring

The monitor joins three distinct signals: Neon public network transfer,
completed API request counts, and 1% samples of database result JSON sizes.
Sampled JSON size is a diagnostic estimate, not Postgres wire size or a bill.
The collector makes no SQL queries and does not wake a suspended compute.
Per-request query attribution (which route, action or client) is in the
sampled PostHog traces: [tracing.md](tracing.md).

The existing Production smoke deployment-comparison job collects every fifteen
minutes and after production deployments. It uses the existing Infisical OIDC
identity and existing `/platform` provider credentials and `/vercel` public
PostHog ingestion configuration. No new identity, platform or paid plan is needed.
GitHub schedules can run late; this is not an instant detection guarantee.

The minute Worker's `GET /api/cron/ops-monitor` is a second, provider-only
collector (`lib/ops/egress-fallback.ts`). It reads Neon usage with
`NEON_API_KEY` and publishes to PostHog every 15 minutes, and retries a failed
collection after one minute. Its state lives in `ops_monitor_observations`.
A failed collection makes the route answer 503.

## Automatic alerts

[Dashboard](https://us.posthog.com/project/670821/dashboard/2297143) and
[alerts](https://us.posthog.com/project/670821/alerts) are in the existing Mikka
PostHog project. All four alerts subscribe the existing account owner by email.
The current plan rejected fifteen-minute alert evaluation, so they check hourly.
Only a threshold breach triggers an alert; these are not scheduled status emails.

| Signal | Initial threshold | Insight |
| --- | --- | --- |
| Latest reported hour | Greater than 20,000,000 bytes | `MeqUS5os` |
| Today (UTC) | Greater than 100,000,000 bytes | `CpCslHvh` |
| Current billing period | Greater than 50% of 5,000,000,000 bytes | `Vy1tVOwr` |
| Collector health | Failed collection, or no snapshot in the last hour | `r8wuvlUx` |

These are conservative **operating budgets**, not Launch plan quotas or
historically calibrated anomalies. Calibrate them against actual use as the
product grows. No automatic rollback, throttling or account suspension occurs.
Neon reports hourly buckets with delay; email delivery adds another dependency.
Do not advertise real-time alerting or confirmed mailbox delivery.

The collector uses completed daily buckets plus today's hourly buckets, within
the active billing period. Upgrading plans can begin a new period mid-day.
An upgrade today legitimately has no completed daily buckets. Empty provider
data, invalid values, stale data and partial logs cannot become a healthy zero.

## Attribution and privacy

`mikka-db-egress-sample` (flag `1024999`) enables 1% sampling for production
only. Results of 64 KiB or more are always logged while the flag is on
(`lib/db/egress-sample.ts`). Main and workspace pools are instrumented. Fixed
Server Action operation names attribute issue-list, chat and thread polls even
though they bypass API wrappers.
The sample includes a timestamp, SQL hash, table identifiers, row count and
JSON result bytes. It excludes SQL text, parameters and row contents.

`mikka_ops_snapshot` publishes aggregate usage and collection health;
`mikka_ops_route_requests` publishes route counts; `mikka_ops_query_sample`
publishes at most thirty query groups per collection. The dashboard uses the
latest snapshot per group instead of summing overlapping windows. Query
estimates with few samples are uncertain; absent samples are insufficient
attribution and do not by themselves prove a collector outage.

Vercel runtime logs are best effort. The report checks immutable deployment
scope, alias changes, pagination, excluded intervals and truncation. Unwrapped
routes and Server Actions do not have a total request count. Only the three named
Server Actions receive explicit query attribution here. This is not universal
application tracing. Keep native Vercel CPU/invocation monitors in place.

## Release and evidence

On 2026-11-03, the production sampling flag and four hourly email alerts were
created, and a real Neon/Vercel collection was ingested into PostHog. Saved
insights returned 8,806,295 provider bytes and a healthy collector snapshot.
That snapshot is a one-time verification, not proof of ongoing scheduling.

The collector now runs as the `deployment-comparison` job in
`.github/workflows/production-smoke.yml` (`scripts/ops/egress-monitor.mjs`).
To check it, open a recent run of that job and its
`egress-monitor-report/report.json` artifact, then check fresh PostHog snapshots
and nonzero timestamped query samples. Record the deployment SHA and workflow
run. A threshold firing, actual mailbox receipt and recovery must be observed
before claiming end-to-end notification acceptance.

Tests cover sampling privacy, billing resets, delayed provider data, missing
inputs, scope validation, JSON-size estimation, overlapping requests, delivery
failure and the provider/log collector contracts. No production statistics are
reset and no fabricated threshold-breach events are injected.
