# Runtime request and CPU budgets

These checks prevent idle polling and distinguish useful work from successful
empty responses. They reuse browser CI, Vercel observability and the existing
operational logs. The minute Worker keeps its current cadence and two-minute
dispatch/due-work objectives in [observability.md](observability.md).

## Executable client budgets

| State | Budget | Check |
| --- | --- | --- |
| Shared workspace lists, isolated in Artifact view | Tasks every 10 seconds; threads every 15 seconds. Over 60 seconds: 3–6 reads per observed action, 8–10 combined | `tests/e2e/settings-background-polling.spec.ts` |
| Settings, including the legacy initial settings entry | Zero background task/thread/board/chat reads over 36 seconds, including focus and online events | Same browser spec |
| Return from settings | Exactly one immediate refresh for each action, then the normal 60-second budget | Same browser spec |
| Leave the workspace document | Zero further workspace reads over 30 seconds | Same browser spec |
| Empty filesystem or command poll | One requested cycle in total, normally 25 seconds; early responses wait only the remainder; configured zero has a one-second minimum | `packages/daemon/test/fs-polling.test.ts`, `commands-polling.test.ts` |
| Queued filesystem work or commands | Process immediately; command acknowledgments do not wait for an idle cycle | Same daemon tests |
| Consecutive transport failures | Existing exponential waits of 1, 2, 4, 8, 16, 30 seconds, capped at 30; success resets the backoff | Same daemon tests |
| Stop or disconnect | Cancel idle/retry waits; ignore late command results on shutdown; no next request or server queue query after cancellation | Daemon tests and `app/v1/devices/[deviceId]/commands/route.test.ts` |

The browser spec counts real Server Action requests after initialization. It
learns all four board polling actions, then isolates the two shared list actions
in Artifact view. It checks all four stop behind settings and learns action identities at runtime and stores only counts, budgets, states and
the tested SHA in `workspace-idle-request-budget`. The range accommodates SWR
scheduling around completed requests; lower bounds catch a broken refresh path.
Settings' own reads are outside the background workspace budget. These are
bounded regression checks, not a global request throttle.

The filesystem endpoint currently returns an authenticated empty result
immediately. Its client supplies the idle wait; adding a server-side sleep
would retain a function invocation without adding useful behavior. Existing
daemon installations must upgrade to receive the client pacing fix. Web
deployment alone does not update them.

## Native Vercel monitors

[runtime-monitors.json](runtime-monitors.json) records the configured definitions
for project `mikka`. All four enable team-owner notifications. These initial
thresholds are project policy and should be calibrated against observed traffic.

| Monitor | Evaluation | Native ID |
| --- | --- | --- |
| CPU and invocation anomalies | Built-in Fluid CPU or function-invocation usage anomaly, minimum medium severity | `ar_01a191b3-4420-70ac-b1dd-165cef7af618` |
| Idle filesystem polling budget | More than 18 invocations per request path in five minutes, filesystem-request route only, across environments | `ar_01a191b3-4940-70d8-9658-85028d732d26` |
| Route CPU total anomaly | Production, 15-minute CPU sum per route, above three standard deviations, with at least 10,000 ms CPU | `ar_01a191b3-55e0-72c7-81a5-e5df7c11ed17` |
| CPU per invocation anomaly | Production, 15-minute CPU sum / invocation count per route, above three standard deviations, with at least 10,000 ms total CPU | `ar_01a191b3-661a-7059-8626-8656bbf8429d` |

At a 25-second idle cadence, a filesystem client normally starts about 12–13
requests in five minutes; 18 allows a small restart burst. Commands are excluded
from this absolute count alert because useful queued commands can return
immediately. On an alert, identify the deployment, route, environment and client
version; inspect request counts, CPU per invocation and outcomes together. Check
whether an old daemon is still polling before changing a production endpoint.

CPU comes from Vercel's function-invocation CPU metric, with invocation counts
from the same scope and window. Process-wide CPU differences cannot attribute a
single request under concurrent Fluid execution. These observability aggregates
do not reconcile the entire bill: the October investigation found about 245
billed CPU minutes versus 139.4 route-attributed minutes. The gap remains
unexplained and must not be reported as measured savings.

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

`scripts/ops/runtime-outcomes.mjs` reads the last 15 minutes of Vercel log events
for the active immutable production deployment, then rechecks the alias. It
stores only the three instrumented route templates and aggregate counts in
`runtime-outcomes-report/report.json` and `summary.md`. Collection is explicitly
`best_effort`: provider retention and timestamp pagination boundaries can omit
events. Reported exclusions, truncation or exhausted pagination are incomplete
collection, not a healthy zero. No samples are insufficient, with null ratios.
Use the native invocation metric for total traffic. The existing
`/api/cron/ops-monitor` remains the database signal collector; its successful
response alone does not establish runtime-log collection or notification
delivery. A 100% empty filesystem ratio is expected; combine empty outcomes with
excess request rate or CPU before treating them as a fault.

## Deployment comparison and response

`scripts/ops/deployment-regression.mjs` runs in the existing Production smoke
workflow after deployments and on quarter-hour follow-ups. It uses the existing
Infisical workload identity and Vercel token. Browser smoke retains its daily,
deployment and manual cadence; the comparison job needs no install or wait loop.

The report pins current and previous production deployment IDs, Git SHAs and
alias activation. It compares aligned, end-exclusive five-minute windows before
and after activation, excluding at least two minutes of warmup. Both CPU and
invocation queries use the same production deployment, route and HTTP-status
groups. Alias/deployment state is checked again after collection.

The initial policy requires at least 20 invocations per group, matching groups,
traffic volume within 2× and group shares within 20 percentage points. A CPU
regression exceeds both 2× and 100 ms per invocation. A server-error-rate rise
above five percentage points is a regression and cannot be presented as a CPU
improvement. Missing windows or samples are `insufficient`; changed traffic
groups or mix can be `not_comparable`. Neither state proves acceptance.

Reports include JSON and a job summary; regression fails the comparison job.
An operator inspects the route evidence, verifies the previous deployment's
health and database migration compatibility, then uses the report's exact
`vercel rollback` candidate if appropriate. Automatic rollback is disabled
because migration compatibility is unverified. No alert automatically pauses
the project, daemon, scheduler or business queues. Verify the same failing
metric and production smoke after any rollback.

Source tests, configured monitor definitions and workflow success cover
different layers. Record the exact CI revision, deployed SHA, aggregate report
and actual firing/recovery or runtime evidence before claiming live acceptance.
