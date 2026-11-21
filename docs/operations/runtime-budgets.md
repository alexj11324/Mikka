# Runtime request and CPU budgets

These checks prevent idle polling and distinguish useful work from successful
empty responses. They reuse daemon and unit tests, Vercel observability and
the existing operational logs. Company monitor definitions, response objectives and deployment procedures
are maintained through the [private operations entry](README.md).

## Executable client budgets

An idle visible page uses the healthy live channel for invalidation. The
source-only `pnpm test:idle-budget` check mounts the listed pages with fake
time and controlled live state, then counts server calls over a minute.
`tests/idle-request-budget.json` sets their budgets. Every listed page has an
empty budget map, so unlisted calls have a budget of zero. The polling policy
also rejects newly introduced polling. A source check establishes that
controlled component path. A live runtime observation needs its own evidence.

The first four rows below retain the superseded polling-era browser contract.
`tests/e2e/settings-background-polling.spec.ts` no longer runs and its polling
cadences must not be restored. The daemon rows remain separate source contracts.

| State | Budget | Check |
| --- | --- | --- |
| Shared workspace lists, isolated in Artifact view | Tasks every 10 seconds; threads every 15 seconds. Over 60 seconds: 3–6 reads per observed action, 8–10 combined | `tests/e2e/settings-background-polling.spec.ts` |
| Settings, including the legacy initial settings entry | Zero background task/thread/board/chat reads over 36 seconds, including focus and online events | Same browser spec |
| Return from settings | Exactly one immediate refresh for each action, then the normal 60-second budget | Same browser spec |
| Leave the workspace document | Zero further workspace reads over 30 seconds | Same browser spec |
| Idle device holding its session | No timed request at all: no heartbeat, no command poll; one report and one command read after the socket opens and a command read on each `work` signal; the 10-second `ping` is answered by the gateway without a database write | `packages/daemon/test/device-gateway.node-test.ts`, `cloudflare/device-gateway/src/route.test.ts` |
| Device session open or close | One `devices` update per report from the gateway, plus the lease extension (open) or lease end (close) of that device's live runs | `lib/device-session.db.test.ts` |
| Socket down | Only redials of the socket, 0.5 to 30 seconds with jitter; no long poll and no claims | Daemon tests |
| Queued commands | Process immediately; command acknowledgments do not wait for an idle cycle | Same daemon tests |
| Consecutive transport failures | Existing exponential waits of 1, 2, 4, 8, 16, 30 seconds, capped at 30; success resets the backoff | Same daemon tests |
| Stop or disconnect | Cancel idle/retry waits; ignore late command results on shutdown; no next request or server queue query after cancellation | Daemon tests and `app/v1/devices/[deviceId]/commands/route.test.ts` |

The retained browser spec counted Server Action requests after initialization. It
learns all four board polling actions, then isolates the two shared list actions
in Artifact view. It checks all four stop behind settings and learns action identities at runtime and stores only counts, budgets, states and
the tested SHA in `workspace-idle-request-budget`. The range accommodates SWR
scheduling around completed requests; lower bounds catch a broken refresh path.
Settings' own reads are outside the background workspace budget. These are
bounded regression checks, not a global request throttle.

A daemon is usable only while it holds its device gateway socket
(`cloudflare/device-gateway`, one Durable Object per device, or the self-hosted
built-in gateway); the open socket is the device session. The gateway reports
`connected` and `disconnected` to `POST /v1/internal/device-sessions/:deviceId`
(`lib/device-session.ts`), which records presence on `devices` and extends or
ends the leases of the device's runs. The server posts an empty `work` signal
(`lib/device-gateway-notify.ts`) after it commits work; the daemon then reads it
through `GET /v1/devices/:deviceId/commands`, which answers at once and never
waits. Changes on the device go once to `POST /v1/devices/:deviceId/report`,
which renews nothing. `GET /v1/devices/:deviceId/gateway` gives the daemon its
socket ticket; a server without a gateway answers 503 `deviceGatewayRequired`
and has no devices. There is no heartbeat and no long-poll fallback. The
run-recovery cron (every 15 minutes) asks the gateway about devices that hold
leased runs while the database still holds their session open, so a lost
`disconnected` report cannot keep a run alive. See the
[decision](../design/decisions/2026-11-17-2215-device-session-no-heartbeat.md).

Current daemons no longer poll `GET /v1/devices/:deviceId/fs/requests`. The
route still answers an authenticated empty list for older daemons. Existing
daemon installations must upgrade to receive these changes. Web deployment
alone does not update them.

## Runtime resource monitors

Company monitor definitions, provider resource IDs and notification receipts
are maintained through the [private operations entry](README.md).

Invocation counts and CPU must use the same route, deployment and time window.
Process-wide CPU under concurrent execution cannot attribute a single request;
telemetry aggregates do not by themselves reconcile a provider bill.

On Cloudflare, compare API application CPU and peak instance memory in the same five-minute windows as HTTP route templates, status, request volume and paired p50/p95 latency. Record background and concurrent work as part of application usage. The CPU per observed HTTP request ratio is a deployment-pressure diagnostic. It does not identify a request's CPU. A 15-minute anomaly check keeps missing observations distinct from verified recovery. For the legacy filesystem budget, the origin logs give a deduplicated observed count across devices. With incomplete origin coverage, 18 or fewer observed starts leave the per-device budget unknown. More than 18 starts across all devices prompts investigation. A per-device breach requires separate evidence for one device in the same five-minute window.

## Explicit outcomes and collection coverage

`lib/request-log.ts` adds only the fixed outcome enum `empty`, `work` or
`ignored` to the existing safe completion log. Filesystem requests, commands
and GitHub webhook admission mark their authenticated business branch. A
webhook `work` outcome means accepted processing, not completed background work.
No payload, concrete device path, token, email or query parameter is added.

`scripts/ops/monitor.mjs::requestOutcomes` aggregates a 15-minute window by route:
invocations, completed pairs, each outcome, unknown results and coverage. A
successful marked start/completion pair is required for classification. Errors,
missing pairs and unmarked legacy lines stay unknown; malformed timestamps are
reported separately. Empty ratio uses classified outcomes as its denominator;
coverage uses observed invocations. No classified samples means a null ratio.

Collection is explicitly `best_effort`: provider retention and pagination can
omit events. Exclusions, truncation or exhausted pagination mean incomplete
collection. No classified samples produce null ratios, not a healthy zero.
Use provider invocation metrics for total traffic; a successful collector
response alone does not establish complete logs or notification delivery.
The private runbook describes the company's collector invocation and artifacts.

## Deployment comparison and response

Company deployment comparisons, operational thresholds and rollback steps
are maintained through the [private operations entry](README.md).

Comparisons require a fixed deployment, aligned time windows, compatible
traffic groups and enough samples. Missing samples are `insufficient`; changed
traffic is `not_comparable`. Neither result proves improvement. Source tests,
configured definitions, workflow completion and actual runtime observations
establish different layers of evidence.

The same Cloudflare Container observation measures completed login, chat and API requests using the existing 99% success target and 10-second p95 threshold. A request still open after 120 seconds counts as a timeout. Select one complete 15-minute quarter at least 120 seconds in the past. Its single bounded log read includes the following two minutes for completions only. Requests that start in that grace interval belong to the next quarter. CPU, memory, database attribution and route profiles keep their original quarter boundaries. A source with no eligible starts or no observed latency leaves those alert IDs unassessed when notifying the existing internal sink.
