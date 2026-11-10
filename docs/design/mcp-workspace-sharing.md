# Custom MCP connections in workspace settings

- **Status:** implemented sharing controls and API contracts. See #1163 for acceptance evidence.
- **GitHub:** #1163.
- **Owner thread:** `fix/mcp-share-ui-1163`, with the shared-MCP backend follow-up.
- **Layout source:** the existing Settings › Connections screen and API-key sharing controls on main; no new navigation or design direction.

## What the user does

The connection owner shares an existing custom MCP connection with members of the current workspace, or withdraws that permission. A member can identify who shared a connection without receiving its credential or private endpoint.

## Where it lives

Settings › Connections gains a Custom MCP group when connections exist. Workspaces are still changed only through the account menu. Each row has the existing app mark, connection name, enabled state and one owner-only sharing control. The setting changes a grant, not connection ownership.

Precedent: Mikka's API-key share switch and explicit enable confirmation (`components/settings/api-key-settings.tsx`). For the resource-sharing model, [n8n credential sharing](https://github.com/n8n-io/n8n-docs/blob/main/docs/administer/manage-credentials/share-credentials-securely.md) lets a credential owner share a resource into a project without exposing credential details to recipients. This change applies that pattern to the existing workspace and MCP authorization model, not n8n's end-user OAuth credential templates.

## Layout and states

| Task/state | Current behavior | New behavior |
| --- | --- | --- |
| Owner shares a connection | API only | Existing connection row, share switch, scope and authority confirmation |
| Owner stops sharing | No UI | Same switch, normal authenticated PATCH, then the stored value |
| Member finds a shared connection | No UI | Read-only name and owner; no share control, private endpoint or credential |
| Personal workspace | Owner API only | Own connections, no workspace sharing control |
| Empty | Existing Connections empty state | Remains empty only after custom MCP and existing app reads succeed |
| Loading | Existing app skeletons | Custom MCP uses the same SettingsLoading component |
| Read failure | No MCP UI | State-read error with Retry; no false empty state |
| Write/response uncertainty | No MCP UI | Share state unconfirmed; controls pause until a successful readback; no automatic write retry |
| Narrow/dark | Existing settings design | SettingRow stacks at narrow widths; shared semantic tokens and primitives |

The domain stays connection, account holder, workspace membership, authorization and current share state. Existing neutral foreground, muted text, control fill, card surface and error tokens remain unchanged. The task-specific emphasis is the owner-authorized workspace switch, not another page header or settings category.

## Components and rules

`SettingsSection`, `SettingRow`, `AppTile`, `Switch`, `Label`, `Badge`, `AlertDialog` and `SettingsSaveError` supply the UI. `McpConnections` composes these for the new API; it creates no new primitive. R-31, R-40, R-42, R-70, R-74, R-75 and R-76 apply. Confirmation copy describes the granted account authority; it is not an introductory subtitle. All copy lives in `Settings.mcpConnections` in both locale files.

`GET /api/integrations/mcp?workspaceId=WORKSPACE_ID` lists the workspace projection.
`PATCH /api/integrations/mcp/shares` uses exactly `{serverId, workspaceId, shared}`. Owner identity, active membership and fresh-session enforcement remain server-side. The client never sends another owner, an endpoint or a credential in a share request.

## Scope and acceptance

This follow-up adds sharing controls for existing custom MCP connections. Arbitrary OAuth onboarding, MCP connection creation/editing, individual recipient selection, model execution and a second workspace switcher are outside it.

Before merge: source checks, meaningful UI contract tests, normal owner/peer API checks against the backend, then one local production-build capture and review in English/Chinese at desktop/narrow widths. Archive reviewed screenshots with their source commit on the evidence branch and link them from the PR. Screenshots and fixture API checks do not substitute for production acceptance of the backend authorization path.
