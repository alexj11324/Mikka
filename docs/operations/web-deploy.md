# Production web deploy

Company-hosted deployment and credential operations are maintained in the
[private operations repository](https://github.com/alexj11324/mikka-cloud/blob/main/docs/operations/web-deploy.md).
Authorized operators start with its `AGENTS.md` and `docs/operations/README.md`.

Public self-hosting and product setup remain in [the documentation index](../README.md).

Existing section links are retained as navigation only.

## Flow

See the [private runbook](https://github.com/alexj11324/mikka-cloud/blob/main/docs/operations/web-deploy.md).

## Skew Protection

See the [private runbook](https://github.com/alexj11324/mikka-cloud/blob/main/docs/operations/web-deploy.md).

## Cloudflare Web release candidates

The Cloudflare gateway maps each retained Mikka deployment ID to a private
release Worker. That Worker binds the official Vite output, the matching Node
API and the private Cloud service. The gateway reads the browser's asset and API
pins. A version check or document navigation uses the current release. A stale
API mutation returns 409 when its release has retired. The gateway never retries
it on the current API. Release retention and rollback belong to #1953/#1954.

Build the official public/overlay pair using the checkout and version checks
above. Set the browser's `MIKKA_DEPLOYMENT_ID` before building. From the
repository root, generate the Wrangler inputs in the release working directory:

```sh
node cloudflare/web/prepare.mjs release release-input.json release-wrangler.json
node cloudflare/web/prepare.mjs gateway gateway-input.json gateway-wrangler.json
```

The release input takes `id`, the full `sourceSha` and `overlaySha`, `assets` (the built `apps/frontend/dist/web`
directory), `api` and `cloud` (private service names selected by the release).
Preparation checks the hosted slot inventory, source-map boundary and the
shell's asset pins. The gateway input takes `current` and a `retained` array of
deployment IDs including the current release. A release service is named
`mikka-app-release-<id>`. Keep its code, bindings and assets immutable while
retained. A corrected build gets a new ID. Both generated configurations keep
workers.dev and version previews disabled and have no public route. Bind the
production domain only through #1954 after testing assets, callbacks, cookies,
streaming and rollback on the same source pair.

## Official runtime configuration

See the [private runbook](https://github.com/alexj11324/mikka-cloud/blob/main/docs/operations/web-deploy.md).

## Logs are public

See the [private runbook](https://github.com/alexj11324/mikka-cloud/blob/main/docs/operations/web-deploy.md).

## Rollback

See the [private runbook](https://github.com/alexj11324/mikka-cloud/blob/main/docs/operations/web-deploy.md).

## Official private UI overlay

See the [private runbook](https://github.com/alexj11324/mikka-cloud/blob/main/docs/operations/web-deploy.md).

### Public output boundary

See the [private runbook](https://github.com/alexj11324/mikka-cloud/blob/main/docs/operations/web-deploy.md).

The current release serves GET/HEAD `/mikka/api/version` from the five-field public version document first returned by its own bound API. A cold isolate verifies the public and private revisions before reusing those values. Every response carries `Cache-Control: no-store`. Release Workers and API services are immutable while retained. Publish a new release ID for a change in the minimum native client version. Deployment acceptance also probes the Node health endpoint and the version directly on the bound API before promotion, then exercises an authenticated read through the gateway.
