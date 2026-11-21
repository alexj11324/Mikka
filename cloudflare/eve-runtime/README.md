# Cloudflare Eve host

The Node 24 image runs the Nitro server produced by Eve `1.3.0` from
`apps/eve`. The agent selects `@workflow/world-postgres` `5.4.1` when
`WORKFLOW_TARGET_WORLD=@workflow/world-postgres`. PostgreSQL stores sessions and Graphile
Worker processes their queued work inside the Eve server. Task sandbox ownership
and reclamation belong to the Sandbox Provider.

## Build and initialize

In cloud Linux with Docker, Node 24 and frozen dependencies installed, run:

```sh
pnpm check:eve-image
```

The same command runs in the existing Eve pull request image job. It checks the
model, Stop and packaging contracts before compilation, builds Eve and its shared
resources once with network access disabled, then builds a local Docker image.
It verifies that exact image ID against the resource manifest, source and
Postgres World metadata, its non-root startup configuration and entry syntax.
It sends no provider request and does not publish an image. Starting the real
server and its health route requires an isolated PostgreSQL World; this command
does not establish live model or Stop acceptance.

Use the protected public GitHub Actions Eve image workflow for publication. Its
Node build selects `NITRO_PRESET=node-server` and
`WORKFLOW_TARGET_WORLD=@workflow/world-postgres`, then packages the compiled output with
`node scripts/package-cf-eve-host.mjs`. The image starts that output with
`node eve/server/index.mjs` on port `8080`.

Before the first start and each Postgres World package upgrade, run the official
bootstrap command from the installed application workspace with the target
`WORKFLOW_POSTGRES_URL` supplied by the deployment secret manager.

```sh
pnpm --filter @mikka/eve exec bootstrap
```

Bootstrap installs the workflow schema and Graphile Worker migrations. The
command needs the installed package, including its `src/drizzle/migrations`
assets. The application image contains the compiled server output.

## Configure runtime delivery

The Container receives deployment settings through the existing `EVE_ENV_`
configuration mapping. Supply `EVE_ENV_WORKFLOW_POSTGRES_URL` for its workflow
database. The package also supports `DATABASE_URL`. Continue supplying the
existing application database, authentication and provider settings through the
same secret delivery path.

The official package supports `WORKFLOW_POSTGRES_WORKER_CONCURRENCY` and
`WORKFLOW_POSTGRES_MAX_POOL_SIZE`. Its documented defaults are `50` workers and
`10` pool connections. Size the pool for the selected concurrency and database
connection limit. Eve's guide recommends at least concurrency plus two
connections.

The package's default poll interval is 500 ms per worker, so 50 idle workers
query the database about 100 times a second. The host sets
`WORKFLOW_POSTGRES_POLL_INTERVAL_MS` to `5000`; LISTEN/NOTIFY still wakes idle
workers as soon as a job is added. A deployment can override it with
`EVE_ENV_WORKFLOW_POSTGRES_POLL_INTERVAL_MS`. Keep the concurrency at 50: the
package documents a deadlock at 10.

Each release runs its own Eve Container, and the host never sleeps. Stop a
release's Container with `stopForOwner` once no gateway release serves it,
otherwise every release keeps polling the database.

The named service `EveService` forwards the native protocol at
`https://eve.internal/eve/v1/*`. Postgres queue delivery stays inside the
Container. The ingress blocks external workflow queue callbacks, as required by
the Postgres World's security guidance. Keep queue delivery on its default
loopback origin.

The Containers SDK keeps the server active through its documented
`onActivityExpired` override and restarts it through `startAndWaitForPorts` after
an exit. Explicit operator cleanup persists the stopped state through
`stopForOwner`. A per-Container capability and an exact-host TLS intercept protect
the existing `product.internal` business API transport.

Follow the official configuration and operational guidance in
[Eve self-hosting](https://eve.dev/docs/guides/deployment/self-hosting),
[Eve Workflow worlds](https://eve.dev/docs/guides/deployment/workflow-worlds), and
the [Postgres World package](https://www.npmjs.com/package/@workflow/world-postgres).
