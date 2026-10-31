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

## Change and verification boundary

`vercel.json` disables the Vercel Next build adapter through build environment
`NEXT_ENABLE_ADAPTER=0`, retaining Next 16.4.1. This selects the legacy build
path using [Vercel's own configuration example](https://github.com/vercel/vercel/blob/84878e532142f0ac584953695658b324eb9e5b80/internals/service-topology/test/fixtures/e2e/23-services-next-segment-prefetch/vercel.json).
The matching upstream report is [workflow#4971](https://github.com/vercel/workflow/issues/4971).
This is a temporary workaround; remove it after the upstream fix passes the
same deployed health and queue-execution checks.

The production smoke test now POSTs the SDK's inert `?__health` route and
requires HTTP 200 plus its health JSON. The check starts no workflow, reads no
chat and calls no model. Workflow 5.2.3 combines workflow and step execution
in this handler; it has no separate step route. The smoke check catches route
packaging failures that a Next build and the runtime feature flag miss.

Chat state now distinguishes active work from failed, unacknowledged and
exhausted wake attempts using the existing event metadata. Original pending
messages and retry scheduling are preserved. The shared projection also drives
bot-list spinners. Accepted wakes log the workflow run ID for correlation.

Source tests, cloud Linux application/database/browser checks, deployed health
and a real model reply are separate evidence. A READY deployment or a passing
health request alone does not establish end-to-end recovery.
