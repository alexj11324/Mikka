# Official build ownership and Cloudflare release

**Current architectural decision (2026-11-12): public Mikka owns the product build.** The repository containing a source file is not necessarily the CI trigger repository, and the CI provider is not the source of truth. This page supersedes conflicting *instructions* in historical notes, but does not rewrite release evidence.

## One supported product architecture

| Responsibility | Owner | Boundary |
| --- | --- | --- |
| Product source, Node API, Eve, Task runtime, official Web/Desktop build root | [public Mikka](https://github.com/alexj11324/Mikka) | Official build starts from a pinned public commit |
| Paid UI source and official slot implementations | private `mikka-hosted-ui` | Checked out **read-only**, by exact approved SHA, into ignored `.hosted-ui/` in the public workspace |
| CI execution, container build and image Registry | Cloudflare Workers Builds / Containers | No paid GitHub Actions runner required; trust must match the actual connected repo and trigger |
| Company deployment, secrets, staging, cutover and rollback | private `mikka-cloud`, issues #1953 and #1954 | Only the release owner promotes a verified immutable artifact; no private code committed to the public repository |

Public/Fork PRs build the public server and compatibility contracts only. Never supply paid UI checkout credentials, production database URLs, or deployment privileges to arbitrary PR code. The official client is assembled from one public source SHA and one private UI SHA; there is **no second community UI**.

## Actual migration state versus target

The original official release workflow `.github/workflows/web-deploy.yml` used a **public-root** checkout, then obtained `HOSTED_UI_READ_KEY` through a trusted identity and installed the private UI under `.hosted-ui/`. That source boundary was correct.

During Cloudflare migration, `mikka-hosted-ui/scripts/cloudflare-ci.mjs` currently triggers Cloudflare Builds from the private UI repo, fetching public Mikka as a nested checkout. The recent OCI issuer was added there as a workaround for unavailable paid GitHub Actions. **This is a temporary implementation, not a decision to transfer ownership of the product build to the private UI repo.** Existing CF source CI `publication=none` is not Registry OCI publication. Do not call it production.

**Target:** trusted public-Mikka Cloudflare main/release trigger → pinned private UI read-only Overlay checkout → official Web/API artifacts and separately scoped Eve/Task images → reviewed Cloudflare OCI/Registry digest → private #1953 staging and single #1954 production promotion. Keep the original two-SHA pin, customer secret isolation, authenticated Registry digest, database/Workflow recovery and rollback checks. Do not add another live publisher or change the production route while #1954 owns a release window.

Backend-only work (Eve / Task) should not import paid UI source unless a reviewed, independently testable build dependency truly requires it. Docker must send only required build context, not the entire dependency or Git-history tree.

## What current docs are authoritative?

Read in this order for an active engineering operation: `AGENTS.md`, [documentation index](../README.md), this page, relevant active design/operations references, and **latest main source plus the actual current #1953/#1954 release selection**. Dated audits, archived screenshots, older handoffs and `docs/design/decisions.md` are historical context only. Remove obsolete records once their active references are replaced; preserve current security, migration, recovery and release evidence.

**Repo size caveat:** Removing tracked history documents reduces a working tree or checkout size, but does not erase prior Git objects or necessarily reduce the repository size reported by GitHub. Never force-push rewritten shared Git history just to shrink it.
