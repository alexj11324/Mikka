# Server tracing (PostHog)

The web backend sends OpenTelemetry traces to PostHog distributed tracing
(beta), so each request or Server Action shows the database statements it ran.
Group by route and caller to find who drives database transfer, instead of
diffing `pg_stat_statements`. This adds to the
[database transfer monitoring](database-egress.md); the ops snapshot and the
`db_sample` / `db_transport_sample` logs are unchanged.

## What is traced

Mikka's own Next.js server, Node runtime (`instrumentation.ts` →
`lib/tracing/node.ts`), and the daemon's own operations (service
`mikka-daemon`, see [Daemon](#daemon)). Nothing from the desktop app or users'
own Claude Code or Codex sessions. The mobile app sends trace context, not
spans (see [Mobile app](#mobile-app)).

- Next.js request spans: the root `GET /route/[param]` span, route handler,
  render and outbound `fetch` spans.
- One `pg.query:<COMMAND> <db>` span per statement, from
  `@opentelemetry/instrumentation-pg` on the `pg` pool behind `lib/db`
  (drizzle `node-postgres`). Statements outside any span are not traced, and
  neither are connect spans.
- Background work, each as a labelled job (see [Background work](#background-work)):
  `after()` callbacks, Workflow steps and cron handlers.

Every span has `service.name=mikka-web` and `deployment.environment`
(`production`, `preview` or `dev`) as resource attributes, and:

| Attribute | Meaning |
| --- | --- |
| `mikka.route` | Grouping key: the `withRequestLog('/api/…')` route, the `withDatabaseOperation('/actions/…')` action, a background job (`after:<job>`, `cron:<name>`, `workflow:<workflow>/<step>`), or Next's route template |
| `mikka.client_kind` | `daemon` (`/v1/*`, `/api/runs/mcp/*`, `/api/runs/github-token`), `mobile` (`/api/mobile/*`, or any other `/api/*` request the iOS app sends; see [Mobile app](#mobile-app)), `cron` (`/api/cron/*`, `cron:` jobs), `workflow` (Workflow steps, `/.well-known/workflow/*`), `background` (`after:` jobs), `worker` (`/api/webhooks/*`) or `web` |
| `mikka.app.version` | The iOS app's version (`1.2.3`), on `mobile` spans only |
| `error.type`, `mikka.error.code`, `mikka.error.detail` | On a failed request or job: the error's class name, and the code and detail of the first coded error in its cause chain (`@mikka/protocol/tracing`). Never the message |

Database spans also have:

| Attribute | Meaning |
| --- | --- |
| `db.operation` | Command tag (`SELECT`, `UPDATE`, `BEGIN` …) |
| `mikka.db.statement_id` | sha256 prefix of the SQL text, the same as `statement` in `db_sample` log lines |
| `db.query.text` | Parameterized SQL, literals replaced by `?`, cut to 200 characters |
| `db.response.returned_rows` | Rows returned or affected |
| `mikka.db.response_bytes_approx` | Result JSON size, estimated from the first 50 rows (not wire bytes) |

## Mobile app

The iOS app exports no spans of its own. Every request it sends to Mikka's
`/api/*` (`apps/mobile/lib/tracing.ts`, from `@mikka/protocol/trace-context`)
carries:

- `traceparent`: a fresh W3C trace context per request, flagged not sampled.
  The server's sampler decides as for any caller, so the app cannot force a
  trace to be kept. The server's spans join that trace id.
- `x-mikka-client-kind: mobile` and `x-mikka-app-version` (only a numeric
  `x.y.z` version; anything else is left out).

`withRequestLog` stamps `mikka.client_kind=mobile` and `mikka.app.version` on
the request's span, and child spans inherit them. The headers are attribution
only, never authentication, and are ignored on machine routes
(`/api/cron/*`, `/api/webhooks/*`, `/api/runs/*`) and `/v1/*`. Requests to other
hosts (uploads, OAuth providers) get no headers.

## Daemon

`packages/daemon/src/tracing.ts` traces Mikka's own daemon operations on the
user's computer, as service `mikka-daemon`:

| Span | What |
| --- | --- |
| `daemon.run` | One run, from start to its end; `mikka.outcome` is the run's stop reason (`submitted`, `turn_ended`, `cancelled`, `error` …) |
| `daemon.run.repository`, `daemon.run.worktree`, `daemon.adapter.start` | The run's start-up stages; `daemon.adapter.start` is where a harness that cannot start fails (`subscription_local_runtime_unavailable`) |
| `daemon.run.lease` | Claiming a run from the server |
| `daemon.tool_approval`, `daemon.tool_approval.refused` | Preparing the run's tool-approval gate; a liveness refusal |
| `daemon.gateway.connect` | Opening the device gateway socket, until it opens or fails |
| `GET /v1/devices/[id]/…` | Every call to the server, named by route template (ids become `[id]`, no query), with `http.response.status_code` |

Each span has `mikka.client_kind=daemon`, `mikka.run.id_hash` (sha256 prefix
of the run id, never the id), `mikka.harness`, `mikka.outcome`, and on failure
`error.type`, `mikka.error.code` and `mikka.error.detail`. Filter the error
code with `mikka.error.code = subscription_local_runtime_unavailable` to see
why runs fail on users' computers.

- **Joining the server's trace.** Each `/v1/*` call sends `traceparent`, so
  the server's request and database spans are children of the daemon span.
  Both sides head-sample by the same trace-id ratio: at equal rates the
  server keeps exactly the traces the daemon kept.
- **Settings.** The server hands them over in the device registration
  response (`tracing`: endpoint, the public `phc_` project token, sample rate,
  environment); `daemonTraceSettings()` in `lib/tracing/config.ts` sends them
  only for the PostHog endpoint and only when server tracing is on. A daemon
  never gets a personal key.
- **Sampling and turning it off.** The server's rate (default 10%).
  `MIKKA_DAEMON_TRACE_SAMPLE_RATE` on the daemon can lower it, never raise it;
  `0`, or `MIKKA_DAEMON_TRACING=0`, turns daemon tracing off.
- **Never blocks.** A batch processor exports every 10 s from a queue of 512
  (then drops). A failed or thrown export drops its spans and pauses exporting
  for a minute; shutdown waits at most 2 s. Nothing is registered globally,
  so an agent SDK's own OpenTelemetry is unaffected.
- **Privacy.** Only an allowlist of attributes leaves the computer; strings
  go through the same rules as the server (`@mikka/protocol/tracing`
  `scrubString`), and paths under a home directory become `[home]`. No
  prompts, file content, paths, environment variables, tokens or emails; no
  span events or status messages. Tested in `packages/daemon/src/tracing.test.ts`.
  The daemon traces only its own work, never what the user's Claude Code or
  Codex does, and passes no trace context to agent CLIs.

## Background work

Work with no request of its own runs as a job, labelled by
`lib/tracing/jobs.ts` (`runJob`) and `lib/tracing/labels.ts`. The label is
also the `route` of its `db_sample` log lines, which the egress monitor
groups like a route.

| Work | Label | Kind | Span |
| --- | --- | --- | --- |
| `after()` callbacks (coordinator wakes, live notifications, issue effects, webhook ingest, device wakes …) | `after:<job>` | `background` | New root span, linked to the request that scheduled it |
| Fan-out a cron handler defers with `after()` | `cron:<name>/<part>` | `cron` | Same, root and linked |
| Cron handlers (`app/api/cron/*`: run recovery and lease sweeps, coordinator wake recovery, the ops/egress monitor …) | `cron:<name>` | `cron` | Child of the cron request's span |
| Workflow steps (every `'use step'` body) | `workflow:<workflow>/<step>` | `workflow` | Inside the step delivery request, under the SDK's own `step.execute` spans |

- Schedule deferred work with `afterJob('after:<job>', task)` from
  `lib/background.ts`, never next/server's `after` directly (oxlint
  `no-restricted-imports`). Next runs an `after()` callback in a snapshot of
  the scheduling request's async context, so a bare `after()` keeps the
  request's route and parents its queries to a request span that has already
  ended. `afterJob` enters the job inside that callback, after the snapshot
  is restored, so the job's label is the one in force. Do not bind the task
  with `AsyncLocalStorage.bind`/`snapshot`: entering it would restore the
  request's context over the label. Work that must keep its scheduling
  context when called back from elsewhere (live notifications) passes
  `retainContext`, which binds outside the job. The only bare `after()` calls left hand over promises
  already running in their webhook (Slack, Telegram) or flush analytics.
- Wrap a cron handler with `cronJob('<name>', handler)`.
- Workflow steps need nothing: the label comes from the step context the
  Workflow SDK runs every step body in (`getStepMetadata()`'s
  AsyncLocalStorage).
- Job names are fixed strings, never ids or user data.
- Root job spans are head sampled at `MIKKA_TRACE_SAMPLE_RATE` like a
  request, independently of it; child job spans follow their request.

`requireParentSpan` stays on, so a statement outside every span is still not
traced. Turning it off would make each such statement its own single-span
trace, labelled from a stack trace: in the bundled server those frames are
`.next/server/chunks/*.js` files, not modules, and capturing a stack on every
unparented query costs CPU on hot paths. Labelling the entry points instead
gives every background statement a parent, a real name and a trace.

## Querying

In the PostHog app: **Tracing** (`https://us.posthog.com/tracing`), filter
service `mikka-web`, then by attribute, for example `mikka.client_kind = daemon`
or `mikka.route = /v1/devices/[deviceId]/commands`.

From an agent, the PostHog MCP tool `query-apm-spans`. Use `flatSpans: true` to
get the database spans themselves rather than their traces:

```json
{ "query": { "serviceNames": ["mikka-web"], "flatSpans": true, "dateRange": { "date_from": "-6h" },
  "filterGroup": [{ "key": "mikka.client_kind", "operator": "exact", "type": "span_attribute", "value": "daemon" },
                  { "key": "db.operation", "operator": "is_set", "type": "span_attribute" }] } }
```

`apm-attributes-list` and `apm-attribute-values-list` list the attribute keys
and values; `apm-trace-get` returns one trace's tree. Counts are sampled:
multiply by `1 / MIKKA_TRACE_SAMPLE_RATE` for totals.

## Dashboard and alerts

The [「Mikka 数据库与错误」 dashboard](https://us.posthog.com/project/670821/dashboard/2306506)
answers "who drives database transfer, and what fails" without SQL. Its
collection health lives on the
[monitoring dashboard](https://us.posthog.com/project/670821/dashboard/2297143).

Read every number on it this way:

- **Counts are sampled.** Traces are kept at 10% (`MIKKA_TRACE_SAMPLE_RATE`).
  `sampled_*` columns are what arrived; `estimated_*_x10` multiply by 10 and
  are what the charts draw. If the sample rate changes, the ×10 is wrong.
- **Bytes are not Neon's bytes.** `mikka.db.response_bytes_approx` is the
  JSON size of the returned rows, estimated from the first 50 rows. It ranks
  routes and statements; it is not network transfer and not the bill. The
  budget tiles and alerts use Neon's own numbers from the ops snapshot
  ([database transfer](database-egress.md)).
- **Hours are UTC**; the project's time zone is Asia/Shanghai. Hours with no
  spans are left out, not drawn as zero.
- **Error counts are spans** with `status_code = 2`, grouped by
  `mikka.error.code` (else `error.type`); one failed request can produce
  several.

| Tile | Source |
| --- | --- |
| Reading note | `scripts/ops/posthog/dashboard-note.md` |
| Daily / billing-period transfer budget | Ops snapshot (`daily-budget.sql`, `monthly-budget.sql`) |
| 7d coverage and missing attributes | `coverage.sql` |
| DB queries per hour by route, top 15, 24h and 7d | `route-queries.sql` |
| DB response JSON bytes per hour by route, top 15, 24h and 7d | `route-bytes.sql` |
| Queries and bytes by `mikka.client_kind` | `client-kinds.sql` |
| Heaviest 20 statements, with parameterized SQL | `statements.sql` |
| Error causes by code / detail; errors by route / code / detail | `error-causes.sql`, `errors.sql` |

### Alerts

Five alerts, the plan's limit. All check hourly and email the subscribed
users (Alex). In each alert's email, the `source` column names the route or
error code and its numbers.

| Alert | Fires when | Tune |
| --- | --- | --- |
| Mikka transfer reaches 50% of 5 GB operating budget | The billing period's Neon transfer reaches 50% of 5 GB (`monthly-budget.sql`) | The threshold `upper: 0.5` in `ALERTS` |
| Mikka monitoring collection failed or heartbeat absent | No healthy ops snapshot in the last hour (`heartbeat.sql`) | — |
| [1324] Mikka 来源数据库小时异常 | One `mikka-web` route's sampled DB queries in the last full UTC hour exceed `max(3 × its 7-day hourly median, 200)` (≈2,000 real queries), or its sampled JSON bytes exceed `max(3 × median, 1 MB)` (≈10 MB). Needs 24 observed hours of history; bytes only when ≥95% of the hour's queries carry a size (`alert-source-anomaly.sql`) | `3 *` (the multiple) and the floors `200` / `1000000` in `metrics`; `covered_hours >= 24` for warm-up |
| [1324] Mikka 日速率外推超过5GB月预算 | Today's Neon transfer so far, scaled to 24 h and to the month's days, exceeds 5 GB. Only from 03:00 UTC, with a snapshot ≤60 min and provider data ≤180 min old (`alert-daily-pace.sql`) | `5000000000` (the budget) and `utc_hours >= 3` |
| [1324] Mikka 错误码小时突增 | One service's error spans for one code in the last full UTC hour exceed `max(3 × its 7-day hourly median, 5)` (≈50 real spans), after 24 observed hours (`alert-error-spike.sql`) | `3 *` and the floor `5` in `metrics` |

Every alert query returns exactly one row and the alert reads it
(`first_row`). PostHog refuses an `any_row` alert whose query its `LIMIT`
cuts short, and production has more routes than that limit. The two hourly
queries rate each source (`per_source`: 1 breach, 0 none, `NULL` without
current telemetry) and return the worst value; `source` names up to five
breaching sources, worst first, or the heaviest one when none breaches.
`NULL` (no current telemetry) does not fire; the heartbeat alert covers
collection.

### Changing them

`scripts/ops/posthog-observability.mjs` holds the dashboard, its insights
and the alerts; the SQL is in `scripts/ops/posthog/`. It finds each object by
its production id, else its `key:<name>` tag, else its exact name, and
changes only what differs, so running it twice changes nothing.

```sh
# POSTHOG_PERSONAL_API_KEY: a personal API key (phx_…) with insight, dashboard
# and alert write access, kept in Infisical prod:/platform; never in a file.
infisical run --env=prod --path=/platform -- node scripts/ops/posthog-observability.mjs           # plan, read-only
infisical run --env=prod --path=/platform -- node scripts/ops/posthog-observability.mjs --check   # exit 1 on drift
infisical run --env=prod --path=/platform -- node scripts/ops/posthog-observability.mjs --apply
```

Edit the definitions or SQL in a PR, then apply once it merges. A change made
in the PostHog app shows as drift in the next `--check`; copy it back into the
repository or it is overwritten on the next `--apply`.

## Sampling and cost

- Head sampling per trace, `MIKKA_TRACE_SAMPLE_RATE` (0–1), default `0.1`. A
  caller's `traceparent` cannot force a trace to be kept.
- `0` turns tracing off: no provider is registered. Tests (`NODE_ENV=test`), CI
  and `next build` always get 0. Set `1` locally to see every request.
- Batch span processor (5 s, 512 spans per export, queue of 2048, then
  dropped). On Vercel a flush is handed to `waitUntil` when a request's root
  span ends, after the response.
- Exporting never blocks or fails a request. A failed export drops its spans
  and pauses exporting for a minute; there are no retries beyond the
  exporter's own bounded 5 s attempt.
- The tracer makes no database queries and does not change SQL (no
  sqlcommenter), so `pg_stat_statements` groups as before.

## Configuration

| Variable | Use |
| --- | --- |
| `NEXT_PUBLIC_POSTHOG_KEY` | The existing PostHog project token (`phc_…`), sent as `Authorization: Bearer` |
| `MIKKA_TRACE_SAMPLE_RATE` | Optional, default `0.1` |
| `MIKKA_TRACE_ENDPOINT` | Optional, for a local mock collector; default `https://us.i.posthog.com/i/v1/traces` (OTLP HTTP/protobuf) |

## Privacy

Enforced in `lib/tracing/sanitize.ts` on every span before export, and tested
in `lib/tracing/tracing.test.ts` with the real `pg` driver and instrumentation.

- No SQL parameter values: `enhancedDatabaseReporting` is off, and literals in
  the SQL text are replaced by `?`. No row content.
- Only allowlisted attribute keys leave the process; connection strings, users,
  hosts, client addresses and user agents are dropped.
- Query strings and fragments are removed from URLs, paths and span names.
- Emails and IP addresses in any kept string become `[email]` / `[ip]`.
- Exception messages, stack traces and status messages are dropped (database
  errors echo values); only the exception type is kept.
- No person or session linking: spans carry no user id, email or token.

Adding an attribute means adding its key to the allowlist in `sanitize.ts`
and a case to the privacy test.
