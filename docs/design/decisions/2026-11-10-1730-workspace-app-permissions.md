# App permissions belong to the workspace, not to each Bot

- Date: 2026-11-10
- Source: Alex: authorizing each Bot separately is the wrong shape; an app is
  connected once and every Bot in the workspace should inherit that choice.
- Rule: 设置 › 应用与运行权限 authorizes the current workspace. It shows one
  access level per connected app and the provider's real tool catalogue; the
  workspace choice is the only app permission, and a Bot has no allow/ask/deny
  layer.
- Replaces: the per-Bot write-policy surface in decision 2026-10-31 (R-77) as
  the place a person configures app access. The per-Bot storage is kept only as
  historical rows and is no longer read for enforcement; existing rows are
  migrated into the workspace policy. The owner-scoped legacy Coordinator head
  survives only as the no-workspace ceiling described below.

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
- The workspace's Allow is a real grant, not an absence: an app set to Allow
  runs directly, without the Decision API. Only the workspace layer decides:
  deny wins over ask, and allow runs the call. A workspace deny is absolute.
  Decision API judgment applies only when the workspace does not name the app.
- The page shows the provider's real catalogue, read lazily from
  `/api/bots/:botId/app-tools`: GitHub's hosted MCP tools (with their
  read-only hints) and Composio's tools for every other store app. The old
  three-item hand-written list was a policy subset, not the app's tool
  surface.
- GitHub is direct allow by default and can be denied as an app. There is no
  approval card on `github_call`; `githubActionDenied` tells the model the
  workspace blocked it, and `githubPolicyUnavailable` says the policy could
  not be read. `github_tools` still lists names. The deny gates Mikka's direct
  calls only: `find_repository`, `github_tools` discovery and a dispatched
  Agent still use the person's own GitHub credential, so the page's line says
  "direct" rather than "never".
- The run policy on the same page is the workspace layer
  (`workspace_computer_policies.cli_run_policy`); per-Bot and per-worker layers
  are retired, while team and project scopes still narrow a task.
- A run that names no workspace has no workspace policy to read: it uses the
  owner-scoped legacy `agent_kit_heads` row (`bot_key='coordinator'`) as an
  explicit ceiling, never as a wider allow. That row is not a per-Bot layer —
  no Bot read or write creates or reads one — and it stops applying once the
  personal-workspace backfill gives the run its workspace. The retired per-Bot
  heads (one per Bot id) are historical rows only; nothing reads their policy
  columns.
- Capy's comparable model — permissions on the MCP server plus a per-device
  access prompt — also authorizes a connection, not each agent. This decision
  matches that shape and removes the per-Bot enforcement layers.

Cost if wrong: a team that needs per-Bot access cannot express it; the
workspace choice applies to every Bot. Existing per-Bot rows must be migrated
into the workspace policy before enforcement is removed.

## Follow-up (not changed here)

Two workspace app-policy surfaces overlap. This page writes
`workspace_computer_policies.external_write_permissions`; 团队权限 › 允许使用的应用
writes `workspaceAppPolicies`, which `botMayUseApp` enforces first. An admin can
therefore see "allow" here while the other page still blocks the app, and the
Coordinator is exempt on the other page but not in this page's GitHub gate.
Reconciling or merging the two surfaces is a later decision; this ADR does not
change enforcement.

The app-tools catalogue route has no throttle or `maxDuration`. Bound it if it
becomes provider-facing beyond the settings page.
