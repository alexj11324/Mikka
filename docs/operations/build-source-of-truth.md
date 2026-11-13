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

For a shared World authority hotfix, `.github/workflows/cloudflare-world-deploy.yml` retrieves the successful original public build artifact on the GitHub runner, verifies its digest and source, and invokes the pinned private operations publisher. It uses prebuilt modules without compiling the product again. The deployment does not depend on a Codex workspace downloading a build artifact. The private operations release plan pins both previous World versions and preserves their signing identity and physical storage.

Backend-only work (Eve / Task) should not import paid UI source unless a reviewed, independently testable build dependency truly requires it. Docker must send only required build context, not the entire dependency or Git-history tree.

## What current docs are authoritative?

Read in this order for an active engineering operation: `AGENTS.md`, [documentation index](../README.md), this page, relevant active design/operations references, and **latest main source plus the actual current #1953/#1954 release selection**. Dated audits, archived screenshots, older handoffs and `docs/design/decisions.md` are historical context only. Remove obsolete records once their active references are replaced; preserve current security, migration, recovery and release evidence.

**Repo size caveat:** Removing tracked history documents reduces a working tree or checkout size, but does not erase prior Git objects or necessarily reduce the repository size reported by GitHub. Never force-push rewritten shared Git history just to shrink it.
