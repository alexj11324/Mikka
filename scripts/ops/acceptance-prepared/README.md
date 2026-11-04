# Prepared production acceptance bundle

This directory contains inert preparation files for Mikka issues #1157–1163. Saving this directory does not activate an acceptance job, change the production deployment, or invoke a model. The workflow template is deliberately outside `.github/workflows`.

## Recovery and evidence

The original scratch files became unreadable during this session. The five executable/template files are being recovered from complete, untruncated tool output. `RECOVERY.json` records their original expected SHA-256 values, recovered values, and the actual post-recovery verification result. A match is required before describing a file as an exact recovery. This README is newly authored; it is not a byte-for-byte restoration of the former README. No production result is implied by restoring or testing these files.

## Scope

The main bundle uses the existing normal Smoke account session and the source checkout fixed by a 40-character commit SHA. It checks the canonical production version before work and at the existing boundary checks. Both the source revision and deployment ID in the workflow remain explicit placeholders until the publisher verifies a matching READY production deployment.

The owner MCP module runs once using the existing authenticated HTTP transport. It confirms the current personal workspace, its sole active owner, and owned Bots before creating one uniquely named, disabled, unauthenticated synthetic custom MCP connection. It reads its metadata back, requires a valid personal-workspace share attempt to return the actual `403 workspaceAccessDenied` boundary, deletes only the newly created receipt, and reads back its absence. It does not connect to the synthetic endpoint or invoke a provider. Unknown create or delete outcomes are not blindly replayed. Cleanup only uses the confirmed new receipt and validates ownership and marker before deleting it.

An owner MCP failure is recorded independently and does not by itself skip the group and replay evidence. The version check immediately after this module still stops later model work if the deployment changed. Overall success requires the owner module to pass, the group acceptance to pass, all 24 logical Decision replays (12 fixed baseline cases and 12 fixed candidate cases) to have valid complete call chains, and each required session and temporary credential cleanup to finish.

The group driver and the fixed 24-logical-case replay use the fixed source implementations. Each logical replay has one to four sequential Decision requests; provider calls are counted separately (at most 96 for this suite). Every complete phase needs a unique execution ID and provider-generation receipt, and the compatibility primary receipt must match the first phase. Invalid or unavailable rows retain paid/unknown attempts. Unknown costs remain null, and routing costs exclude correction, contribution, chat, tools and Factory work. Flash is the only permitted model. The source temporary-credential helper uses the existing authorized Smoke/Flash/E2B credentials; it removes only credentials that this run created and never deletes pre-existing credentials. Normal login and logout are used. The report separately observes the owner MCP/replay session, the source group session, and the temporary-credential helper session. A successful helper callback or key deletion does not prove that helper session logged out: each session requires its own HTTP 200 sign-out acknowledgement for a full pass. Cookies and secret values stay in memory. Reports use explicit safe-field projections and secret checks before being written.

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


## Sequential protocol revision

The five original recovery hashes in `RECOVERY.json` identify the recovered historical version, not this updated runner. This revision adapts `group-sequential-v1`, records actual wakes and per-phase receipts, and has its own offline verification. It does not turn the failed first production bundle into a pass.

A source-driver failure stops only its newly created fixture group through the normal owner API. If the driver unexpectedly throws, the outer runner can perform the same stop only after an actual HTTP 201 creation receipt, three fresh Bot creation receipts, current owner/workspace, matching fixture markers and exact membership are verified. A returned source cleanup receipt is never replayed. Unknown stop responses are read back once; no new message or message-history drain is used. Independent replay continues after a group failure only when no pending retry remains. Group stop and Factory cancellation are distinct: cancellation recorded does not prove the agent or cloud VM stopped. Runtime stop evidence must come from normal product readback, never from deleting a credential.

## Runtime cleanup evidence

Before the temporary E2B credential is removed, the runner may intentionally call the existing normal owner `POST /api/threads/:runId/machine` with `action: end`. This is a resource-cleanup action, not a read operation. It is limited to this newly created group's Factory create/continue receipts: the live decisions trace must bind message, reporter, Task and run; the current Task must be terminal and its current epoch belong to those receipts; every selected attempt belongs to an admitted epoch; and the run's frozen requester, execution principal, output owner, Bot, workspace and E2B payer must match the authenticated fixture owner. Only terminal runs with completed artifact readback (or an empty owned artifact inventory) are eligible.

Each exact run receives at most one end request, including after an unknown response. A normal HTTP 200 `{runId,state: ended}` is recorded as `machineEndAcknowledged`, reflecting the product's terminal action contract. A 404, conflict, timeout or unknown response is never reported as shutdown. The independent provider observation remains false. The separate normal Bot desktop GET returns only `machine` and `control`; this is a shared owner/workspace desktop and can include a synthesized sleeping state, so it never proves a particular thread VM stopped. Unconfirmed cleanup prevents an overall pass. None of these offline contracts calls a provider.
