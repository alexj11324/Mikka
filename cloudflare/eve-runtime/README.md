# Eve Container host candidate

This is an **undeployed candidate**, not a production runtime. Issue
[#1946](https://github.com/alexj11324/Mikka/issues/1946) owns Eve hosting and
Workflow durability. The ordinary Node API belongs to #1949, release assembly
to #1953, and production routing and old-World drain to #1954.

## Current blocker

The candidate targets the pinned Eve `1.0.0-rc.9` Node server with the official
`@workflow/world-postgres@5.1.1`. That World uses Graphile database polling and
its bootstrap creates Workflow schemas. The latest #1946 requirements prohibit
new database polling and changes to the existing Neon schema. **Do not deploy
or bootstrap this candidate against production.** No production World is
selected by these files or the package script.

An acceptable World must satisfy Eve's atomic session start, persistent
streams, callbacks, retry, approval, timer and restart contracts without a
second Agent loop. The published third-party Cloudflare World is not a drop-in
replacement: it requires Worker bindings in the Node process and lacks the
pinned atomic-start capability. Neither a successful build nor this host's
unit tests resolves that problem.

## What the candidate implements

- A Worker forwards the existing `/mikka/api/agents/eve/v1/` and namespaced
  Workflow callbacks, plus the Slack webhook, to the native Eve HTTP server.
  Request bodies, cancellation, cookies and streaming responses pass through.
  It does not implement an Agent loop or business API.
- One shared Container uses the `basic` instance type and `max_instances: 1`.
  Its `shared-warm` policy renews the idle timeout within a trusted candidate
  lease (`EVE_HOST_WARM_UNTIL`, at most 24 hours ahead). A native durable alarm
  stops the candidate at the cutoff; subsequent requests and restart callbacks
  cannot resurrect it. This cutoff is for isolated cost-bounded acceptance;
  it does not establish a production availability or approval-drain policy.
  Stopping one
  Task does not stop the shared service. This policy **has standby charges**;
  it is not scale-to-zero and is not financially accepted yet.
- The launcher checks public source SHA, private overlay SHA, release ID, Eve
  version, build preset and World version before starting the native child.
  It waits for the child's actual exit on shutdown. The current PG experiment
  still has an active-stream shutdown failure; no graceful-drain acceptance is
  claimed.
- Automatic crash retries are bounded to three attempts per incident. Explicit
  owner stop persists in Durable Object storage and suppresses retries. The
  public request handler exposes no operator stop endpoint.
- Packaging copies the existing verified `.output/eve` with relative symlinks
  preserved. Checkout-dependent links, local Workflow data and root environment
  files are refused. Runtime credentials are individual Worker secret bindings
  prefixed `EVE_ENV_`, delivered to the child at runtime, not image build args.

The platform must explicitly provide `EVE_ENV_MIKKA_DEPLOYMENT_STAGE` as
`preview` or `production`. `NODE_ENV` is not a substitute for deployment stage.
The stage-aware product guards are in separate draft #1964 and must be composed
with the matching runtime before any production acceptance.

The configuration has no routes, preview URLs or Workers.dev endpoint. Its
default name identifies a candidate. Do not add production routes here.

## Local checks

From the repository root, with the pinned workspace dependencies installed:

```sh
node --experimental-test-module-mocks --import tsx --test cloudflare/eve-runtime/test/*.test.mjs
pnpm exec wrangler deploy --config cloudflare/eve-runtime/wrangler.jsonc --dry-run --containers-rollout=none --outdir /tmp/mikka-eve-worker-dryrun
```

The dry run compiles only the Worker and checks Wrangler configuration. It
does not build a Docker image, create remote resources, prove Container
shutdown, or demonstrate durable Workflow recovery.

## Before release

The World blocker above must be resolved first. Then bind one immutable image
digest to the source, overlay and release ID through #1953. Stock Wrangler
deployment activates Worker code before its Container rollout completes;
`max_instances: 1` does not make that transition atomic. Validate old/new image
compatibility or use isolated candidate routing through that release owner.

Existing Mikka session mappings do not yet carry a home World. A global
`MIKKA_EVE_ORIGIN` change must not send old approval, stop or reconnect requests
to a fresh World. Inventory and retain old Vercel runs, establish durable
session affinity or a proven migration, and complete drain and rollback with
#1954 before cutover. Never use a local Container filesystem or R2 artifact
bucket as a replacement for the Workflow World.

Real Cloudflare acceptance remains outstanding: authorized chat and native
tools, approval/stop/replay/restart/timers, tenant boundaries, public callbacks,
latency, resource reclamation, and attributed before/after cost. The account's
Container quota is available; that does not establish Startup Credit coverage
or that a warm host is cheaper than the current attributable Eve load.

References: [Eve self-hosting](https://github.com/vercel/eve/blob/main/docs/guides/deployment/self-hosting.md),
[Cloudflare Container deployment](https://developers.cloudflare.com/containers/guides/deploy/),
[rollout semantics](https://developers.cloudflare.com/containers/configuration/rollouts/),
and the pinned [Mikka Eve runtime contract](../../docs/operations/eve-runtime.md).
