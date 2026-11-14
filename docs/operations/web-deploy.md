# Web deployment: current source contract and legacy compatibility

**Current build ownership:** Official product code and build entry belong to public `Mikka`. A trusted build checks out the exact private UI Overlay under `.hosted-ui` using a limited read-only identity; untrusted public PRs receive neither UI secret nor customer config. See [build source of truth](build-source-of-truth.md).

The [release owner](https://github.com/alexj11324/Mikka/issues/1954) selects and promotes a verified public build through the protected Cloudflare deployment workflow. Use the recorded serving receipt to identify the active public/UI pair and Cloudflare version. The [release ledger](https://github.com/alexj11324/Mikka/issues/1954#issuecomment-6868288411) distinguishes the promoted gateway and retained versions from later source merges. Preserve Cloudflare's version rollback and the recorded legacy workflow and callback obligations for their respective owners.

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

Changed template inputs require a successful Web build serving the exact current
main commit before the E2B release takes its lock or allocates builders. A
frozen publisher with no matching run leaves the runtime unpublished. After
the matching Web release is serving, the existing manual E2B release accepts a
retry reason. It rechecks the live version after building and validates both
official subscriptions before publishing template IDs.

After a Cloudflare promotion, dispatch the same official runtime workflow on
current main with its retry reason and `cloudflare_receipt`. For a Cloudflare-to-Cloudflare
promotion, run the existing Cloudflare application deployment workflow with phase
`gateway-observe` on the reviewed operations commit containing the prepared
checklist. The observer only reads the provider and canonical application.
Use `actions:RUN_ID:ATTEMPT` from that successful observation in the consumer
dispatch. Its original job identifies the 100% gateway version, product, overlay
and Web client pin. Each signing or publication gate rechecks the live gateway
fingerprint, product, overlay, pinned client and current product main.
The first Vercel-to-Cloudflare transition keeps its historical issue #1954
comment/body hash, approval window and DNS TXT verification.
The same release produces the immutable template report for the private
Cloudflare API deployment. The legacy Web publisher runs only on the original
release path with an empty Cloudflare receipt.

Desktop uses its existing signed and notarized macOS workflow. After promotion,
dispatch Desktop release on main with the same fresh `cloudflare_receipt`.
It verifies the serving Web version and exact overlay before allocating the
Mac, before loading credentials, and immediately before publishing the sealed
installer. The approved backend must contain the installer commit. The
original Vercel path remains available while Vercel serves the canonical app.

See the [private runbook](https://github.com/alexj11324/mikka-cloud/blob/main/docs/operations/web-deploy.md).

## Logs are public

See the [private runbook](https://github.com/alexj11324/mikka-cloud/blob/main/docs/operations/web-deploy.md).

## Rollback

See the [private runbook](https://github.com/alexj11324/mikka-cloud/blob/main/docs/operations/web-deploy.md).

## Official private UI overlay

See the [private runbook](https://github.com/alexj11324/mikka-cloud/blob/main/docs/operations/web-deploy.md).

Public builds verify the server, protocol and authentication code without private UI or credentials. The official release linker requires every declared workspace provider and named runtime export before either client can be distributed.

### Public output boundary

See the [private runbook](https://github.com/alexj11324/mikka-cloud/blob/main/docs/operations/web-deploy.md).

The current release serves GET/HEAD `/mikka/api/version` from the five-field public version document first returned by its own bound API. A cold isolate verifies the public and private revisions before reusing those values. Every response carries `Cache-Control: no-store`. Release Workers and API services are immutable while retained. Publish a new release ID for a change in the minimum native client version. Deployment acceptance also probes the Node health endpoint and the version directly on the bound API before promotion, then exercises an authenticated read through the gateway.
