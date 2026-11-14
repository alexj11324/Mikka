# Cloudflare Eve host

The Node 24 image runs the Nitro server produced by Eve `1.0.0-rc.9` from
`apps/eve`. The agent selects `@workflow/world-postgres` `5.2.0` when
`WORKFLOW_TARGET_WORLD=@workflow/world-postgres`. PostgreSQL stores sessions and Graphile
Worker processes their queued work inside the Eve server. Task sandbox ownership
and reclamation belong to the Sandbox Provider.

## Build and initialize

Use the public GitHub Actions Eve image workflow with frozen dependencies. Its
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
