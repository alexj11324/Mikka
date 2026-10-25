# #179 isolated backend evidence

Runtime implementation: `9c5c67c717618ee77126a82b6d7aea61e1e2ce0c`.
Frozen baseline: #267 `470b3247ff12b50ba942ae93418ff4600c77edd5`.
Cloud Linux, Node 24 Docker, PostgreSQL 17, loopback origin
`http://127.0.0.1:3179/mikka`. Synthetic test users only. No actual provider
credentials, external email, production cron/migration/deployment or billable
provider/model resource was enabled. Details: [environment.json](environment.json).

| Gate | Actual result | Evidence |
| --- | --- | --- |
| PG/tool/clock/process/DST/origin/inbox | 15 passed, zero skips; real SIGKILL and transaction fault; ten claim/cancel races | [Raw terminal](postgres.cast), [log](postgres.log) |
| Real built Next + PG | Passed, 2026-10-25 18:25:35–18:26:41 UTC | [Raw terminal](next-http.cast), [log](next-http.log) |
| Once across actual service restart | One occurrence, one original Bot result after ten concurrent HTTP sweeps; within predeclared 10s SLA | [Retained DB/events/chat](next-pg-records.json), [process](next-process.log) |
| Two real-time repeat slots | Due 18:25:41.092 and 18:26:41.092 UTC; finished 18:25:41.172 and 18:26:41.142 | [HTTP log](next-http.log) |
| Pause/update timezone/resume/cancel | Real authenticated Next commands persisted and no extra run after cancellation | [HTTP log](next-http.log), [DB](next-pg-records.json) |
| Full `pnpm check` | Exit 0 after updating stale test assertions; no product UI/layout change | [Full log](check-final.log) |
| Production Next build / traced native workers | Exit 0; 100 route traces audited, eight BYOS traces and two workers verified | [Build](build-9c5c67c.log), [artifact check](artifacts.log) |
| Actual model conversation | **Blocked / not passed**: real `/api/agent` returns 503 without configured model resource; no fake provider used to claim success | [HTTP log](next-http.log) |
| #176 Workflow SDK, scoped write effects, tenant model budgets | **Not accepted here**; require #176/#207/#208/#265 integration | [Contract](../../backend/179-conversation-schedules.md) |
| Authorized Preview / OAuth / production | **Not executed**; parent-controlled release gates remain | — |

A `.cast` file is an original asciinema v2 PTY recording, not a rendered mock or
reconstructed UI. Play it with `asciinema play <file>`. The recorder implementation
is `scripts/record-terminal.py`. Exact HTTP operations are reproducible with
`scripts/verify-schedules-http.mjs`; it uses real Better Auth against its guarded,
disposable loopback database and restarts only the named local test container.
No user authentication secrets are published. The DB export deliberately excludes
all auth session/token tables; owner IDs and messages belong to synthetic fixtures.

Failures are retained: initial native-loader/cache build failure, missing isolated
loopback CI origin configuration, initial schedule CI Docker health quoting, the
first HTTP startup race and the pre-fix canonical-origin rejection. See the
`*failure*` files and original `.cast` recordings. A canonical-origin/actual-Host
fix was made and revalidated without weakening origin checks. The old UI/auth
source-assertion failures are retained in `check-baseline-ui-failures.log`; only
the stale test assertions were corrected.

The local development PG was evolved during implementation; the `reported_at`
column was added before the fixed runtime acceptance. The dedicated GitHub PG
workflow independently validates the final tracked migration on a fresh database.
Synthetic records and the local test containers remain available. The issue must
remain open: isolated backend success is not real model/OAuth or production acceptance.
