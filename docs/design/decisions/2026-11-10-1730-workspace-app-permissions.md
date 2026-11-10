# App permissions belong to the workspace, not to each Bot

- Date: 2026-11-10
- Source: Alex: authorizing each Bot separately is the wrong shape; an app is
  connected once and every Bot in the workspace should inherit that choice.
- Rule: 设置 › 应用与运行权限 authorizes the current workspace. It shows one
  access level per connected app and the provider's real tool catalogue; a
  Bot's own stricter layer may still narrow the workspace choice.
- Replaces: the per-Bot write-policy surface in decision 2026-10-31 (R-77) as
  the place a person configures app access. The per-Bot storage and its
  narrowing semantics stay for existing rows.

What follows:

- The page no longer asks which Bot to authorize. It reads
  `workspace_computer_policies.external_write_permissions` through
  `workspace_write_policy` and saves it through `set_workspace_write_policy`;
  only a workspace admin may save, any member may read. A personal workspace
  has one member, so the same page is the person's own authorization.
- One app is one rule. Saving an app writes its toolkit key and, where one
  exists, the legacy first-class write action key (`send_slack_message` and
  the other `WRITE_ACTIONS`), so the workspace choice governs both
  `call_app_tool` and the older write path.
- The page shows the provider's real catalogue, read lazily from
  `/api/bots/:botId/app-tools`: GitHub's hosted MCP tools (with their
  read-only hints) and Composio's tools for every other store app. The old
  three-item hand-written list was a policy subset, not the app's tool
  surface.
- GitHub is direct allow by default and can be denied as an app. There is no
  approval card on `github_call`; `githubActionDenied` tells the model the
  workspace blocked it. `github_tools` still lists names.
- The run policy on the same page is the workspace layer
  (`workspace_computer_policies.cli_run_policy`), not a Bot's layer. Existing
  per-Bot and per-worker layers still narrow it at execution; the page does
  not edit them.
- Capy's comparable model — permissions on the MCP server plus a per-device
  access prompt — also authorizes a connection, not each agent. This decision
  matches that shape without removing the existing enforcement layers.

Cost if wrong: a team that needs per-Bot access must keep using the API or a
future advanced surface; the current page cannot express it. The backend still
enforces narrower Bot layers, so no existing restriction is lost.

## Follow-up (not changed here)

Two workspace app-policy surfaces overlap. This page writes
`workspace_computer_policies.external_write_permissions`; 团队权限 › 允许使用的应用
writes `workspaceAppPolicies`, which `botMayUseApp` enforces first. An admin can
therefore see "allow" here while the other page still blocks the app, and the
Coordinator is exempt on the other page but not in this page's GitHub gate.
Reconciling or merging the two surfaces is a later decision; this ADR does not
change enforcement.
