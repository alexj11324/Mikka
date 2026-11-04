# Prepared production acceptance bundle

This directory contains inert preparation files for Mikka issues #1157–1163. Saving this directory does not activate an acceptance job, change the production deployment, or invoke a model. The workflow template is deliberately outside `.github/workflows`.

## Recovery and evidence

The original scratch files became unreadable during this session. The five executable/template files are being recovered from complete, untruncated tool output. `RECOVERY.json` records their original expected SHA-256 values, recovered values, and the actual post-recovery verification result. A match is required before describing a file as an exact recovery. This README is newly authored; it is not a byte-for-byte restoration of the former README. No production result is implied by restoring or testing these files.

## Scope

The main bundle uses the existing normal Smoke account session and the source checkout fixed by a 40-character commit SHA. It checks the canonical production version before work and at the existing boundary checks. Both the source revision and deployment ID in the workflow remain explicit placeholders until the publisher verifies a matching READY production deployment.

The owner MCP module runs once using the existing authenticated HTTP transport. It confirms the current personal workspace, its sole active owner, and owned Bots before creating one uniquely named, disabled, unauthenticated synthetic custom MCP connection. It reads its metadata back, requires a valid personal-workspace share attempt to return the actual `403 workspaceAccessDenied` boundary, deletes only the newly created receipt, and reads back its absence. It does not connect to the synthetic endpoint or invoke a provider. Unknown create or delete outcomes are not blindly replayed. Cleanup only uses the confirmed new receipt and validates ownership and marker before deleting it.

An owner MCP failure is recorded independently and does not by itself skip the group and replay evidence. The version check immediately after this module still stops later model work if the deployment changed. Overall success requires the owner module to pass, the group acceptance to pass, all 24 actual Decision replay receipts to be present and valid, and the required session and temporary credential cleanup to finish.

The group driver and the fixed 24-receipt replay use the existing source implementations. Flash is the only permitted model. The source temporary-credential helper uses the existing authorized Smoke/Flash/E2B credentials; it removes only credentials that this run created and never deletes pre-existing credentials. Normal login and logout are used. Cookies and secret values stay in memory. Reports use explicit safe-field projections and secret checks before being written.

This owner-only MCP HTTP evidence does not establish two-member MCP sharing, a shared Run token, live custom MCP execution, Gmail delegation, official Claude/Codex subscription execution, or cloud-to-device recovery. Those require their own existing authorizations and separate real evidence. Prepared offline transport fixtures are not model or provider evidence.

## Offline verification

From this directory, run:

```sh
node --test run-proactive-acceptance.test.mjs owner-mcp-boundaries.test.mjs
node --check run-proactive-acceptance.mjs
node --check owner-mcp-boundaries.mjs
```

The tests inject transport and helper dependencies. They must make no provider or production network calls. Keep the recovered test result separate from any older pre-loss test result; the actual post-recovery result is recorded in `RECOVERY.json`.

## Publisher mapping

The authorized publisher is responsible for reviewing the exact files and the current production source/deployment pair before activation. The prepared branch itself remains inactive.

| Prepared file | Runtime destination when intentionally activated |
| --- | --- |
| `run-proactive-acceptance.mjs` | `scripts/ops/proactive-acceptance-once.mjs` |
| `owner-mcp-boundaries.mjs` | `scripts/ops/owner-mcp-boundaries.mjs` |
| `proactive-acceptance-once.yml` | The single temporary acceptance workflow, only after both placeholders are replaced with the verified pair |

The template retains the exact repository/acceptance-branch boundary, distinct concurrency group, 65-minute budget, and four explicit existing secret inputs. It must not be activated by placing this prepared copy under `.github/workflows`. Do not run duplicate acceptance workflows or infer success from a setup or polling timeout.

