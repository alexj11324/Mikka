# Bot runtime deployment

Mikka builds the pinned `eve@1.0.0-rc.9` agent in `apps/eve` alongside the
frontend and API. Run `pnpm build:app` to produce both services. The final
packaging step rejects different application and agent revisions.

## Routes and authentication

Clients use `/mikka/api/agents/eve/v1/…`, with the authenticated Bot scope in
the request. The eve channel authenticates the caller and checks Mikka's
session mapping. The application proxy preserves cookies, authorization,
query parameters and cancellation, and streams responses without buffering.
Only operators configure the upstream origin; a request cannot choose it.

The existing `/mikka/api/webhooks/slack` endpoint forwards the exact signed
body to eve's `/eve/v1/slack` channel. Slack signature and ownership checks
remain channel responsibilities.

## Node and Docker

The packaged agent lives at `.output/eve`, or `/app/eve` in the Docker image.
The API starts it as a peer Node process on a loopback port and stops it
through Nitro's close hook. No Vercel hosting, Connect or Sandbox is required.
The same Docker build copies the full application output, including eve.

The agent's local Workflow storage is independent of the application's
existing queue. It defaults to `MIKKA_DATA_DIR/eve-workflow`, or
`.cache/eve-workflow` when `MIKKA_DATA_DIR` is absent. Set
`MIKKA_EVE_DATA_DIR` to choose persistent storage. Back it up with the
application database; it contains the authoritative agent session history.
The startup binds eve's documented `.eve/.workflow-data` mount to that
directory and refuses an existing mount that points elsewhere.

Local Workflow deliveries and browser callbacks use the configured application
origin under `/mikka/api/agents`. That origin must reach the running app from
the eve process, as it must for the application's existing Workflow runtime.

For a separately supervised eve process, set `MIKKA_EVE_ORIGIN` to its HTTP
origin. Mikka then proxies to that service and starts no additional process.
The value must be an origin without credentials, a path or query parameters.
Keep that service's model and database configuration consistent with Mikka.

`pnpm dev` starts `eve dev` before the API workers. Eve owns its authored-file
watcher; API hot replacements reuse the existing service.

## Vercel prebuilt output

The existing GitHub prebuilt deployment builds both services from the same
revision. Packaging copies eve's generated Node functions under
`functions/_mikka_eve`, preserving its queue triggers and adding the app's
runtime resources. Eve's public routes precede application routes. Its
Workflow consumers stay separate from the application's root
`/.well-known/workflow` endpoints.

`EVE_PUBLIC_ROUTE_PREFIX=/mikka/api/agents` supplies the public callback
namespace. The small generated function adapter removes that prefix before
passing the request to the upstream fetch handler. Native queue deliveries
retain their context and generated trigger configuration.

Do not deploy output built with `--skip-sandbox-prewarm`. If an agent enables
sandbox-dependent capabilities, its configured provider must complete the
normal upstream build preparation.

## Verification and rollback

Run the deployment contract tests through `pnpm test:api`. They cover
same-revision packaging, queue configuration, path forwarding, signed Slack
bodies, authentication headers, cancellation and service cleanup. A successful
build is separate from live model, OAuth or Slack acceptance.

Roll back the entire application and agent output together through the
existing release flow. Preserve the agent's durable storage and Mikka
database. An eve package upgrade can strand earlier workflows, so retain
history and follow the pinned upstream session migration rules.

The main application's Workflow scanner is limited to `workflows` and `lib`.
Eve's generated `.eve` snapshots and `.output` belong to its independent World
and must never be discovered by the product compiler. Shared model descriptor
validation stays in the pure `lib/hosted-model-selection.ts` module; provider,
credential and database resolution remain on the Node side of the step boundary.
