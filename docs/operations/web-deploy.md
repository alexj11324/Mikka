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

Initial automatic E2B runtime selection requires the observed Cloudflare
product to equal current main and the consumer run's recorded source. A push
only reports changed inputs and builds no candidate. Publication rechecks the
fixed serving receipt and publishes template IDs that passed the build-time
checks: the template builds, both CLIs start and the execution fence opens.
E2B uses the user's own key, so there is no subscription run before publication
([#2789](https://github.com/alexj11324/Mikka/pull/2789)).

The release starts by itself. When a run of the Cloudflare application
deployment workflow finishes with a serving-release observation
(`gateway-observe` after a cutover, or a per-service Web `service-production`),
the runtime workflow and Desktop release receive that `workflow_run` event.
Runtime applies the initial current-main selection above and its existing
input checks. Desktop accepts a served product in main's history and skips a
commit whose installer is already the latest release. Both use
`actions:RUN_ID:ATTEMPT` of that observation as their receipt, and every gate
rechecks it as below. The
[workflow reference](../../.github/workflows/README.md#cloud-worker-template-release)
owns runtime candidate checks and recovery.

To retry by hand, dispatch the official runtime workflow on current main with
its retry reason and `cloudflare_receipt`. A dispatch without a receipt fails
before any builder starts. For a Cloudflare-to-Cloudflare
promotion, run the existing Cloudflare application deployment workflow with phase
`gateway-observe` on the reviewed operations commit containing the prepared
checklist. The observer only reads the provider and canonical application.
Use `actions:RUN_ID:ATTEMPT` from that successful observation in the consumer
dispatch. Its original job identifies the 100% gateway version, product, overlay
and Web client pin. Each signing or publication gate rechecks the live gateway
fingerprint, product, overlay, pinned client and the served commit's membership
in main's history through the existing
[serving-source verifier](../../scripts/release/cloudflare-promoted-web.mjs).
Later merges do not replace the fixed source or invalidate publication. A manual
dispatch on a later main therefore builds the still-served commit rather than
the newer dispatch commit. Explicit release windows declared by the
#1752/#1954 owner remain binding; an offline push does not itself open one.
The first Vercel-to-Cloudflare transition keeps its historical issue #1954
comment/body hash, approval window and DNS TXT verification.
The same release produces the immutable template report for the private
Cloudflare API deployment.

Desktop uses its existing signed and notarized macOS workflow. A push records
in its run summary that no installer was built. The serving-release observation
starts it as described above; a manual dispatch on main with a fresh
`cloudflare_receipt` still works.
It verifies the serving Web version and exact overlay before allocating the
Mac, before loading credentials, and immediately before publishing the sealed
installer. The approved backend must contain the installer commit.

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

## Acceptance after a per-service release

A per-service release (private operations `service-release`) publishes no
`Web deploy` run, and nothing waits for one. The production acceptance
workflows that used to follow it (`read-cache-production`,
`self-hosted-production`, `task-attachment-production`,
`project-decisions-acceptance`, `model-provider-fallback-acceptance` and
`issue1415-deployed-production`) are dispatched on main after the release
instead. Their only release check is that the live `/mikka/api/version` serves
the expected build. `factory-visual-evidence-acceptance` still follows the E2B
runtime release.
