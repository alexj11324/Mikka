# Coordinator Workflow routing (#635)

## Observed failure

Production `e24703eeb17969b1e29e82fcf81ce20b5323db7e`, deployment
`dpl_2myfn8MzhpXfakiwGpnuTdYJDV1V`, returned HTTP 500 from
`/mikka/.well-known/workflow/v1/flow` at 2026-10-31 13:17:23 UTC. The launcher
required `.next/server/pages/mikka/.well-known/workflow/v1/flow.js`, although
Workflow generates an App Router handler. An earlier deployment failed in the
same way at 13:14:54 UTC. A user event committed immediately before that
failure remained undelivered through multiple wake attempts. Gateway had no
corresponding new inference.

The failure occurs before the workflow body can record a failed turn. Existing
durable wake recovery retries the pending event; enqueue acceptance alone does
not prove that the worker loaded or consumed it.

The official [`@vercel/next` 27.0.0 package](https://registry.npmjs.org/@vercel/next/-/next-27.0.0.tgz)
contains the responsible adapter launcher in `dist/adapter/node-handler.js`.
It matches `x-matched-path` against the unprefixed App Router manifest without
removing the configured `/mikka` base path. The failed lookup leaves a path
without `/route`, so the launcher selects `server/pages` instead of
`server/app`. A source-only execution of that published launcher with a
representative manifest reproduced the exact missing path above; changing only
the matched path to `/.well-known/workflow/v1/flow` loaded
`server/app/.well-known/workflow/v1/flow/route.js`. This isolates the routing
classification defect without building or starting the application locally.
Production build logs identify Vercel CLI 65.4.0, whose [published package
metadata](https://registry.npmjs.org/vercel/65.4.0) pins `@vercel/next` 27.0.0.
The same source-only reproduction also passes against builder 28.0.1. The
deployed builder's exact package version has not been independently confirmed.

## Change and verification boundary

`vercel.json` disables the Vercel Next build adapter through build environment
`NEXT_ENABLE_ADAPTER=0`, retaining Next 16.4.1. This selects the legacy build
path using [Vercel's own configuration example](https://github.com/vercel/vercel/blob/84878e532142f0ac584953695658b324eb9e5b80/internals/service-topology/test/fixtures/e2e/23-services-next-segment-prefetch/vercel.json).
The matching upstream report is [workflow#4971](https://github.com/vercel/workflow/issues/4971).
This is a temporary workaround; remove it after the upstream fix passes the
same deployed health and queue-execution checks.

The executor check uses the SDK's queue-based health protocol, which reaches
this deployment's actual worker without starting a user workflow or calling a
model. A public `POST flow?__health` is unsuitable here: the platform can send
it to the locale catch-all function, even when the dedicated queue worker is
healthy. No public HTTP assertion was added to the smoke suite.

For the current production target, use the existing CLI authentication:

```sh
pnpm exec workflow health --backend vercel --project mikka --team mikka-dev --env production --json
```

For a frozen staged target, the SDK's `healthCheck(world, { deploymentId,
timeout })` also pins the exact deployment. Staged production deployment
`dpl_6K29PvtFRBZ8uiVLQcwCeRjsrow4`, code `16c30af0b67638338e38f04c28067b8da445e966`,
returned `healthy: true`, spec version 8 and Workflow core 5.2.3 in 7643 ms
at 2026-10-31 13:42 UTC. Its production domains had not been promoted. This
proves the actual queue handler loads; a real message/reply remains a separate
acceptance check.

Chat state now distinguishes active work from failed, unacknowledged and
exhausted wake attempts using the existing event metadata. Original pending
messages and retry scheduling are preserved. The shared projection also drives
bot-list spinners. Accepted wakes log the workflow run ID for correlation.

Source tests, cloud Linux application/database/browser checks, deployed health
and a real model reply are separate evidence. A READY deployment or a passing
health request alone does not establish end-to-end recovery.
