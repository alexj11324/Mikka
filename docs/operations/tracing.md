# Server tracing (PostHog)

The web backend sends OpenTelemetry traces to PostHog distributed tracing
(beta), so each request or Server Action shows the database statements it ran.
Group by route and caller to find who drives database transfer, instead of
diffing `pg_stat_statements`. This adds to the
[database transfer monitoring](database-egress.md); the ops snapshot and the
`db_sample` / `db_transport_sample` logs are unchanged.

## What is traced

Only Mikka's own Next.js server, Node runtime (`instrumentation.ts` →
`lib/tracing/node.ts`). Nothing from the daemon, the desktop or mobile apps, or
users' own Claude Code or Codex sessions.

- Next.js request spans: the root `GET /route/[param]` span, route handler,
  render and outbound `fetch` spans.
- One `pg.query:<COMMAND> <db>` span per statement, from
  `@opentelemetry/instrumentation-pg` on the `pg` pool behind `lib/db`
  (drizzle `node-postgres`). Statements outside a request are not traced, and
  neither are connect spans.

Every span has `service.name=mikka-web` and `deployment.environment`
(`production`, `preview` or `dev`) as resource attributes, and:

| Attribute | Meaning |
| --- | --- |
| `mikka.route` | Grouping key: the `withRequestLog('/api/…')` route, the `withDatabaseOperation('/actions/…')` action, or Next's route template |
| `mikka.client_kind` | `daemon` (`/v1/*`, `/api/runs/mcp/*`, `/api/runs/github-token`), `mobile` (`/api/mobile/*`), `cron` (`/api/cron/*`), `worker` (`/api/webhooks/*`, Workflow steps) or `web` |

Database spans also have:

| Attribute | Meaning |
| --- | --- |
| `db.operation` | Command tag (`SELECT`, `UPDATE`, `BEGIN` …) |
| `mikka.db.statement_id` | sha256 prefix of the SQL text, the same as `statement` in `db_sample` log lines |
| `db.query.text` | Parameterized SQL, literals replaced by `?`, cut to 200 characters |
| `db.response.returned_rows` | Rows returned or affected |
| `mikka.db.response_bytes_approx` | Result JSON size, estimated from the first 50 rows (not wire bytes) |

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
