# Narrow TS run-control dependency manifest — a410

Fixed source: `a410b292cc53cfef43992a91d7696023e3481567`. This supersedes neither the existing c29 broad inventory nor production identity proof. `known-source-delta.json` compared 162 previously captured files: 153 unchanged and 9 changed. `full-delta.diff` additionally records all 39 production-file changes in the examined areas; its SHA-256 is `df7c69a9ce04875e92cd63e3f1ee4b9061936445ae072ac713ade005fbedc38c`.

## First consumer

`HttpServerLink.prepareRunToolApproval` → `ToolApprovalGate` → actual adapter child cancellation. Every operation still calls the original fresh HTTP authorization. Existing native broker `native_active`/`active` and per-chunk authorization are outside this first replacement; their timers remain enabled.

| Authority input | Actual reader | Required transactional dependencies |
|---|---|---|
| Run ownership, device, admitted phase, stop, lease | `AgentToolApprovalStore.transaction` / `checkState` | `agent_runs`: owner/device/agent/Bot/issue, status, stop, lease, pause/resume fields, frozen policy ceiling and hierarchy |
| Effective CLI policy | `lockCliRunPolicy`, `lockCliAgentPolicy` | `agents`, `devices`, `bots`, `agent_kit_heads`, `workspace_computer_policies`, `cli_scope_policies`; all identities, layer policies, versions and generations actually selected by these readers |
| Issue deletion and pinned hierarchy | `lockCliTaskScope`, `lockCliHierarchy` | App `issues` owner/scope/scopeVersion/content metadata; Workspace `mikka_team_issues`, `mikka_teams`, `workspace_projects` issueIds, `mikka_team_projects` identities and relationships |
| Both Bot and issue Workspace memberships | `realCliMembershipGuard` → `acquireWorkspaceMembership` | Workspace active `mikka_workspace_members`; actual membership transaction stays fresh, bounded and released |
| Authenticated device token and custody | `authenticateDevice`, `device-scope` | App `device_tokens`, `device_token_devices`, `devices`, `cloud_machines`, `thread_machines`; token hash/owner/binding/revocation/expiry, selected cloud custody and ended state |
| Historical human-control expiry restoration | `AgentToolApprovalStore.checkState` | `computer_run_bindings`, `bot_desktops` exact owner/workspace/Bot and control/controlUntil; time expiry can require a fresh transition without any write notification |
| Implicit account/workspace deletion admission | Existing migration triggers reached during policy default materialization | `account_deletion_guards`, and workspace-deletion guards in the actual physical DB where those triggers are installed; combined and split layouts cannot be assumed equivalent |

Changing any authority row, FK deletion, or replacing a row must advance a persistent version in the **same transaction**. Rollback must leave both business state and version unchanged. `updatedAt`, token `lastUsedAt`, diagnostics and stream chunks alone are not authority changes. The fixture must demonstrate the exact trigger set; this document is not proof that triggers have already been installed or fully covered.

## Snapshot and deadline contract

1. Read App and Workspace persistent vectors; then run the existing complete reader; then read both vectors again. A positive snapshot is publishable only if both vectors are unchanged. A topology/generation change or a missing dependency is unavailable, not a zero revision.
2. Subsequent challenges require a source DB barrier **started after that challenge was admitted**. A grant can reuse the full snapshot only when the barrier vectors equal its bracketed vectors. Lost NOTIFY/WS hints cannot extend old authority.
3. Consumer time starts when it sends the challenge, using a monotonic clock. An accepted response expires relative to that send time, never receipt time. Deadline, wrong nonce, late/replayed response, source disconnect, or failed barrier revokes. A later reply cannot resurrect a revoked gate.
4. Natural expiry bounds the grant independently of version writes. Run/token/policy expiry and human-control expiration need exact handling. No timer removal is justified by a durable vector alone.
5. Operation checks, native per-chunk checks and legacy HTTP behavior remain unchanged. Reacquisition at 15–30 seconds is allowed only after authority is already unavailable; it cannot preserve an old allow.

## a410 additions and exclusions

The new project-decision capability is attached through the daemon's existing MCP configuration; its routes retain fresh `verifyRunToken`/worker authority and owner/team checks. `project_decisions`/sources are result records, not a new positive predicate of this monitor. New question-continuation and Factory reader code uses existing authoritative run and policy rows. Diagnostic log fields and deployment message changes do not change monitor predicates.

Credential owner/shares/epoch/refresh generation, model admission and native authorization are additional dependencies of the future broker source, not silently covered by the TS child fixture. PostHog deployment switch, route rollout and quota freshness keep their current semantics; no durable DB version is asserted for an external value.

## Still unproved

- Full current runtime trigger and FK coverage for the manifest (existing broad writer inventories are search evidence, not completeness proof).
- Production App/Workspace runtime connection identities and a long-lived two-source placement in the existing DeviceSession infrastructure; connector `neondb_owner` is not application identity.
- Production healthy-path SQL and request reduction. Shared barriers remain queries; report their actual frequency and count.
- Pause/resume and natural expiry, reconnect generation, and all native/API runner paths on the new source.
- Real three-path production acceptance. The normal readiness account currently differs from the historical case owner and has no configured sources; API balance is blocked. No pass is inferred from local fixtures.
