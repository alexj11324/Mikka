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
`NEON_API_KEY` and publishes to PostHog every 15 minutes, and makes a failed
collection eligible again after one minute. The minute Worker calls this route
only at UTC quarter-hours, so the normal next opportunity is the next
quarter-hour tick. Its state lives in `ops_monitor_observations`.
A failed collection makes the route answer 503.

## Automatic alerts

The [monitoring dashboard](https://us.posthog.com/project/670821/dashboard/2297143)
shows collection health and supplier usage. Managed alert definitions live in
`scripts/ops/posthog-observability.mjs` and their SQL in
`scripts/ops/posthog/`. Five hourly definitions cover billing-period transfer,
collector health, source query/JSON-byte anomalies, daily transfer pace and
error spikes. [Tracing](tracing.md#alerts) describes their thresholds and
coverage rules.

The collector's source policy uses `MONTHLY_BUDGET_BYTES=500_000_000_000`
and a daily reference of that value divided by 30. The monthly alert fires
above 50% of that reference. These constants do not verify the provider's
current plan or bill. Neon usage arrives in delayed hourly buckets, and
notification delivery has its own evidence requirement.

The four alerts created on 2026-11-03 used earlier operating thresholds,
including a 5 GB billing-period reference. That setup receipt is historical.
The managed five-alert inventory supersedes those definitions. Observe a real
threshold and delivery before claiming notification acceptance.

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
