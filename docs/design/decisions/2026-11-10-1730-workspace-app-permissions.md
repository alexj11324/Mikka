# App permissions belong to the workspace, not to each Bot

- Date: 2026-11-10
- Source: Alex: authorizing each Bot separately is the wrong shape; an app is
  connected once and every Bot in the workspace should inherit that choice.
- Rule: 设置 › 应用与运行权限 authorizes the current workspace. It shows one access level per connected app or MCP server — allow, read-only or disabled — and the provider's real tool catalogue. The workspace is the only authorization surface; a Bot has no permission layer of its own. A device is allowed or denied separately.
- Replaces: every per-Bot write-policy surface and every per-Bot allow/ask/deny row, including decision 2026-10-31 (R-77). The per-Bot layer is removed; the workspace is the only authorization surface, and no per-Bot setting or narrowing rule is read. Legacy per-Bot rows are inert and migrated to the workspace rule or deleted.
- Amended by: user ruling, 2026-11-10. The workspace is the only authorization surface.

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
- The workspace's access level is the only app authorization. Allow runs every tool the connection grants, with no approval card and no Decision API call. Read-only runs only tools with readOnlyHint and refuses writes with a model-visible reason. Disabled is absolute: direct app and GitHub calls refuse the app. There is no ask level, no per-Bot layer and no per-action judge; Decision API judgment is not used for app access.
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
- The run policy on the same page is the workspace layer (workspace_computer_policies.cli_run_policy), and it is the only run-policy layer. Per-Bot and per-worker policy rows are removed; no narrower layer is read at execution.
- Capy's model — allow, disable or read-only on the MCP server, and allow on a device — authorizes a connection or a device, never an individual agent. This decision adopts that shape: the workspace and the device are the only authorization surfaces, and no Bot-level layer remains.

Cost if wrong: a team that needs per-Bot access has no surface; per-Bot access is intentionally unsupported because Capy has no such concept. Removing the Bot layer can only widen access where a Bot row was stricter; migrate those rows to the workspace rule before deleting them and record the diff.

## One workspace app-policy surface

One workspace app-policy surface. 应用与运行权限 is the only place a person sets app access. 团队权限 › 允许使用的应用 is removed; its rows are migrated to the same workspace rule, and botMayUseApp reads that rule. No second store and no later reconciliation.

The app-tools catalogue route has no throttle or `maxDuration`. Bound it if it
becomes provider-facing beyond the settings page.
