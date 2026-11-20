# Official build ownership and Cloudflare release

**Current architectural decision (Alex, 2026-11-13): GitHub Actions builds from public Mikka; Cloudflare deploys the verified artifacts.** The repository containing a source file is not necessarily the CI trigger repository, and the CI provider is not the source of truth. This page supersedes conflicting *instructions* in historical notes, but does not rewrite release evidence.

## One supported product architecture

| Responsibility | Owner | Boundary |
| --- | --- | --- |
| Product source, Node API, Eve, Task runtime, official Web/Desktop build root | [public Mikka](https://github.com/alexj11324/Mikka) | Official build starts from a pinned public commit |
| Paid UI source and official slot implementations | private `mikka-hosted-ui` | Checked out **read-only**, by exact approved SHA, into ignored `.hosted-ui/` in the public workspace |
| CI execution and product compilation | Public Mikka GitHub Actions | Pin source and original successful run, artifact ID and digest; use the existing public runners |
| Production hosting and image Registry | Cloudflare Workers / Containers | Deploy the verified artifacts through the existing publisher |
| Company deployment, secrets, staging, cutover and rollback | private `mikka-cloud`, issues #1953 and #1954 | Only the release owner promotes a verified immutable artifact; no private code committed to the public repository |

Public/Fork PRs build the public server and compatibility contracts only. Never supply paid UI checkout credentials, production database URLs, or deployment privileges to arbitrary PR code. The official client is assembled from one public source SHA and one private UI SHA; there is **no second community UI**.

## Actual migration state versus target

The original official release workflow `.github/workflows/web-deploy.yml` used a **public-root** checkout, then obtained `HOSTED_UI_READ_KEY` through a trusted identity and installed the private UI under `.hosted-ui/`. That source boundary was correct.

The temporary private-UI Cloudflare-native builder is retired. Its old `publication=none` receipts and historical OCI issuer instructions do not authorize a release.

The supported flow is public Mikka GitHub Actions → pinned, read-only private UI checkout when required → immutable Web/API/Eve/Task/World artifacts → the existing private operations publisher → Cloudflare staging and production. Keep the original source pins, customer secret isolation, authenticated Registry digest, database/Workflow recovery and rollback checks. Respect active release windows.

Protected API, Eve, Task and Cloud Services publishers use the existing Cloudflare workload identity to request a 15-minute Registry credential from Cloudflare's Containers API immediately before reading or publishing images. Read phases request only pull access; publication requests push and pull. Eve and Task publication replace the earlier pull-only Docker login with this fresh publication credential before pushing the verified image. Credentials stay in the consuming step, outside compiler environments. The compiler does not depend on a copied Registry password stored in GitHub Secrets. The existing Cloudflare identity needs Containers Edit for this API and container deployment.

A build keeps its original reviewed source pair when later main merges arrive. The actual main workflow authenticates the public revision; the selected UI revision must belong to its main history. Compilation and publication recheck the original checkouts and receipt, without replacing their bytes or requiring a moving branch to remain unchanged.

For a shared World authority hotfix, `.github/workflows/cloudflare-world-deploy.yml` retrieves the successful original public build artifact on the GitHub runner, verifies its digest and source, and invokes the pinned private operations publisher. It uses prebuilt modules without compiling the product again. The deployment does not depend on a Codex workspace downloading a build artifact. The private operations release plan pins both previous World versions and preserves their signing identity and physical storage.

Backend-only work (Eve / Task) should not import paid UI source unless a reviewed, independently testable build dependency truly requires it. Docker must send only required build context, not the entire dependency or Git-history tree.

## Service builds and release manifests

`cloudflare-api-image.yml` is the public content-addressed producer for an actual
`push` to `main` by the release owner. It does not manufacture a manual-dispatch
event. The existing `cloudflare-runtime-release` protection rejects PR merge
refs, including the owner's same-repository PRs. That rule remains intact: PRs
run the existing credential-free image qualifications, and Registry publication
starts after merging into main. Pre-merge Registry publication is therefore
blocked by the current environment policy, not verified acceptance. Forks
receive no Registry, Cloudflare or private UI credentials. The old
manual publishers remain available for release-owner operations already in
progress; they are not the automatic build path.

The producer reads the already approved UI selection from a fixed read-only
operations checkout. Only API and Web check out that exact UI commit and verify
its membership in the UI repository's main history. Compilers receive a filtered
environment without checkout, Registry or deployment credentials.

`config/service-build-inputs.json` records the six service input boundaries.
`scripts/release/service-builds.mjs` hashes sorted file names, file bytes, file
type, executable permission and declared build parameters. A new Git commit or
run ID alone does not change a context. Import-closure checks reject omitted
public source dependencies. Database migration files have a separate digest.

| Service | Actual input boundary | Output |
| --- | --- | --- |
| Web | Frontend, shared client/server contracts, public build settings and pinned official UI | Worker plus `web.tar.gz` containing `site/` and `proof/renderer-manifest.json` |
| API | Node API, shared application code, runtime resources, World business adapter, and the frontend shell currently embedded by the API compiler | OCI image, ingress Worker and the generated `routes.json` |
| Eve | Eve application and shared server code/resources; the standalone resource packager removes the former API/frontend compilation prerequisite | OCI image and runtime Worker |
| Task | Daemon/protocol sources, pinned CLI harness, task runtime, sandbox Dockerfile and image qualification inputs | OCI image and machine Worker |
| World | Cloudflare World source and its shared deployment/session-control contracts | Original World module archive format |
| LiteLLM | Proxy image/configuration, Worker and its shared protocol-fields module | OCI image and runtime Worker |

Shared code is an explicit dependency, not an assumption that all six services
are independent. In particular, the API still embeds the frontend shell and the
LiteLLM protocol gate executes the application's gateway handler. That gate is
separate from image content: every trusted candidate runs it, using the cached
immutable image when the proxy inputs are unchanged. A change
confined to `deploy/litellm` leaves the other five contexts unchanged. Task sends
only its selected files to Docker; API, Eve and LiteLLM retain their narrow image
contexts.

Before building, `service-plan` queries the Cloudflare OCI manifest endpoint for
each container's context tag. Only HTTP 404 means an absent image. Reuse requires
the original successful service job and its unexpired artifact; a tag without
that proof is rebuilt and qualified. Authentication or digest failures stop the
run. Service/cache artifacts are retained for 90 days; expiration never permits
unproved reuse. New publication verifies the Registry manifest digest
against Docker's published digest and records the local image ID for the private
publisher's independent platform-image check. Release decisions use immutable
digests, never a mutable tag.

### Qualification ownership

Main builds use `service-build (<service>)` in the unified producer. The legacy
automatic image jobs still qualify every PR without credentials; their manual
publication jobs remain unchanged. These are moved
gates, not deleted gates:

| Existing gate | Unified producer execution |
| --- | --- |
| Task Node contract tests and Python native-history test | `TASK_TESTS` and `TASK_HISTORY` in `Build and verify service` |
| Task Dockerfile's standard device-handoff test and pinned CLI installation | The same Task Dockerfile, built from the declared minimal context |
| Task offline non-root capability checks and review-listener isolation | `scripts/release/verify-task-image.sh`, preserving both original Docker commands |
| LiteLLM offline health/master-key guard | The unchanged `deploy/litellm/offline-check.sh` |
| Both CLI protocols through LiteLLM and a local fake provider; seven passes and zero skips | The unchanged `deploy/litellm/conversion-check.sh` before new publication, or `litellm-qualification` after independently pulling and checking the cached platform image |
| Eve network-isolated compilation and portable Node image | The same `build-cloudflare-eve-image.sh` with standalone resource packaging, followed by the same Eve Dockerfile |
| World authority dry-run bundle and module checksums | `service-build (world)`, preserving `modules/**`, `source.txt` and `SHA256SUMS` |
| API image self-verification | The existing `start.mjs verify-image` command, explicitly under BuildKit `--network=none` |

### Consumer contract

Each built service uploads `service-<service>-<runId>-<attempt>` with
`service-receipt.json`. Artifact paths are relative to that original GitHub
artifact archive. API uses keys `ingress` and `routes`; Web uses `assets`,
`worker` and `gateway`; Eve, Task and LiteLLM use `worker`. World uses `worker` with the path
`SHA256SUMS`; the checksum list verifies every module and `source.txt`. World's
only additional archive member is `service-receipt.json`.

After the service upload succeeds, a small
`service-cache-<service>-<context digest without sha256:>` artifact records its
original artifact ID. Cache lookup verifies this archive's GitHub digest, the
original service job and all its build/publication/upload steps. Another service
may have failed in that older run; this does not discard a separately successful
service build. Cancelled or incomplete workflows cannot supply release artifacts.
A full retry writes `service-build-plan-<runId>-<attempt>` and consumers use
the actual planning job's artifact ID. A failed-job retry retains that earlier
plan and successful services from their original attempts; the final collector
verifies each original job and selects only its successful full artifact. Only the small discovery cache pointer may be replaced during
that retry; the original service archives and final manifests remain immutable.
The final candidate manifest's workflow must still succeed in full, including
the latest LiteLLM qualification.

Job `release-manifest` verifies these artifact digests and uploads
`release-manifest-<runId>-<attempt>` with member `release-manifest.json` in its
`Upload release manifest` step. Every service carries its own original
`sourceCommit`, `overlayCommit`, `release` and
`build: {runId, runAttempt, artifactId, workflow}`. Container services also carry
`localImageId`, `imageDigest` and a digest-pinned `image`. API and Web retain their
original UI SHA; services without UI use `null`. Reuse preserves this metadata
and all artifact bytes; it does not relabel an old build as a new run.

A service's deployment digest covers its image digest and named artifact
digests. It excludes the newer candidate's commit, run ID and `reused` marker.
The private publisher verifies the original workflow/job/upload step and archive
before using any service. It then compares the candidate with the deployed
manifest, rather than treating every main merge as a six-service deployment.
Build success alone does not authorize production promotion.

## What current docs are authoritative?

Read in this order for an active engineering operation: `AGENTS.md`, [documentation index](../README.md), this page, relevant active design/operations references, and **latest main source plus the actual current #1953/#1954 release selection**. Dated audits, archived screenshots, older handoffs and `docs/design/decisions.md` are historical context only. Remove obsolete records once their active references are replaced; preserve current security, migration, recovery and release evidence.

**Repo size caveat:** Removing tracked history documents reduces a working tree or checkout size, but does not erase prior Git objects or necessarily reduce the repository size reported by GitHub. Never force-push rewritten shared Git history just to shrink it.
