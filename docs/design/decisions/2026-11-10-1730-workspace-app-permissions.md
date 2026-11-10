# App permissions belong to the workspace, not to each Bot

- Date: 2026-11-10
- Source: Alex: authorizing each Bot separately is the wrong shape; an app is
  connected once and every Bot in the workspace should inherit that choice.
- Rule: 设置 › 应用与运行权限 authorizes the current workspace. It shows one access level per connected app — allow, ask or deny today, with read-only and disabled as the target levels — and the provider's real tool catalogue. App authorization is workspace-scoped; a Bot has no permission layer of its own. A device is allowed or denied separately. Target contract: MCP-server access levels, including read-only, are not enforced yet.
- Replaces: every per-Bot write-policy surface and every per-Bot allow/ask/deny row, including decision 2026-10-31 (R-77). The per-Bot storage is kept only as historical rows and is no longer read for enforcement; existing rows are migrated into the workspace policy. A run that names no workspace still reads its owner's legacy Coordinator head as an explicit ceiling until the personal-workspace backfill; that head is not a per-Bot layer.
- Amended by: user ruling, 2026-11-10. App authorization is workspace-scoped.

What follows:

- The page no longer asks which Bot to authorize. It reads
  `workspace_computer_policies.external_write_permissions` through
  `workspace_write_policy` and saves it through `set_workspace_write_policy`;
  only a workspace admin may save, any member may read. A personal workspace
  has one member, so the same page is the person's own authorization.
- One app is one rule. Saving an app writes its toolkit key and, where one
  exists, the legacy first-class write action key (`send_slack_message` and
  the other `WRITE_ACTIONS`), so the workspace choice governs both
  `call_app_tool` and the older write path. A tool call consults its own slug,
  the app key and the legacy action, so a deny stored only under the legacy
  key still blocks the newer tool.
- The workspace's access level is the only app authorization. Allow runs every tool the connection grants, with no approval card and no Decision API call. Read-only runs only tools with readOnlyHint and refuses writes with a model-visible reason. Disabled is absolute for direct app and GitHub calls; a dispatched Agent is the known exception until the backend makes the deny absolute (see below). There is no per-Bot layer and no per-action setting for app access; the Decision API judges only when the workspace does not name the app. Current: the workspace level uses `allow`, `ask` and `deny`. Target contract: the read-only and disabled app levels are not enforced yet.
- The page shows the provider's real catalogue, read lazily from
  `/api/bots/:botId/app-tools`: GitHub's hosted MCP tools (with their
  read-only hints) and Composio's tools for every other store app. The old
  three-item hand-written list was a policy subset, not the app's tool
  surface. The :botId only anchors the legacy route; the catalogue read is
  workspace-scoped and authorizes no Bot separately.
- The workspace deny covers every GitHub call in the workspace, including a
  dispatched Agent that uses the person's own GitHub credential; no personal
  credential bypasses the workspace choice. Target contract: until the
  backend makes this deny absolute, a dispatched Agent can still use the
  person's own credential.
- The run policy on the same page is the workspace layer (workspace_computer_policies.cli_run_policy). The workspace layer is the base; per-Bot and per-worker policy columns are retired, and team and project scopes still narrow a task.
- Capy's model — allow, disable or read-only on the MCP server, and allow on a device — authorizes a connection or a device, never an individual agent. This decision adopts that shape: the workspace's app rule and the device are the only app-authorization surfaces, and no Bot-level layer remains.

Cost if wrong: a team that needs per-Bot access has no surface; per-Bot access is intentionally unsupported because Capy has no such concept. Removing the Bot layer can only widen access where a Bot row was stricter; migrate those rows to the workspace rule before deleting them and record the diff.

## One workspace app-policy surface

Target contract: one workspace app-policy surface. 应用与运行权限 is the only place a person sets app access. 团队权限 › 允许使用的应用 will be removed; its rows will be migrated to the same workspace rule, and botMayUseApp will read that rule. Until then `workspace_app_policies` and `botMayUseApp` remain, and the second store is still enforced.

The app-tools catalogue route has no throttle or `maxDuration`. Bound it if it
becomes provider-facing beyond the settings page.
