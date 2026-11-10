// What 设置 › 应用与运行权限 receives (docs/ui-overlay.md): permissions for the
// current workspace, from the routes that store them. One choice applies to
// every Bot in the workspace; there is no per-Bot permission layer.
// - App access: the workspace's allow / ask / deny per app
//   (`/api/bots/:botId/definition`, view workspace_write_policy, action
//   set_workspace_write_policy). Only admins save; any member reads. The app's
//   real tool catalogue comes from `/api/bots/:botId/app-tools`.
// - Agent runs: the workspace's layer of the run policy
//   (`/api/agent-cli-policy`, readAgent / setAgent target workspace), which
//   also holds the workspace approval mode (ask / read_only). Computer use is
//   set on the computer itself, not here.

export type PermissionChoice = 'allow' | 'ask' | 'deny'
/** `default`: nothing stored, so an app call goes to the Decision API, a run action to its scoped default. */
export type PermissionValue = PermissionChoice | 'default'

export type BotPermissionAction = {
  /** The stored key: an app id (slack) or a run action (install_dependency). */
  id: string
  name: string
  /** What the workspace stores. */
  value: PermissionValue
  /** What runs now, where a stricter layer narrows `value`; null otherwise. */
  effective: PermissionChoice | null
  /** The choices this action takes (git_push: allow / deny; write_outside_repo: ask / deny). */
  choices: PermissionValue[]
  /** False where no route saves it (computer_use is set on the computer, not here) or the person may not. */
  editable: boolean
  /** The app an action acts in, for its mark. */
  app?: string
}

/** One real tool from the provider's catalogue. */
export type BotPermissionTool = { name: string; displayName: string; readOnly: boolean }
export type BotPermissionAppTools = {
  count: number
  readOnlyCount: number
  tools: BotPermissionTool[]
  truncated?: boolean
  error?: string
}

export type BotPermissionApp = {
  /** The toolkit (slack, notion, googlecalendar…) or Mikka's own app. */
  id: string
  name: string
  account: string | null
  iconUrl: string | null
  /** One workspace-level access choice; `tools` is the provider's real catalogue when it has been read. */
  actions: BotPermissionAction[]
  tools?: BotPermissionAppTools | 'loading'
}

export type SettingsBotPermissionsProps = {
  /** `workspace`: this page authorizes the whole workspace, not one Bot. */
  scope: 'workspace'
  /** The Bots in this workspace, for a layer that still names the anchor; the default page does not show a picker. */
  bots?: { id: string | null; name: string }[]
  botId?: string | null
  onBot?: (id: string | null) => void
  /** Null while the first read is out. */
  apps: BotPermissionApp[] | null
  /** The workspace's run permissions; null when there is no worker to read them through yet. */
  run: BotPermissionAction[] | null
  /** Kept for contract compatibility; the workspace choice is already on each app. */
  workspace: BotPermissionAction[] | null
  /** The workspace's approval mode; null when it cannot be read. */
  approvalMode: { value: 'ask' | 'read_only'; editable: boolean } | null
  onApprovalMode: (mode: 'ask' | 'read_only') => void
  /** Saves one or more actions of one kind to the same value. `write` and `workspace` both save the workspace policy. */
  onAction: (kind: 'write' | 'run' | 'workspace', ids: string[], value: PermissionValue) => void
  /** Reads one app's real tool catalogue on demand. */
  onLoadTools?: (app: string) => void
  saving: boolean
  /** A failed read or save, in the person's words. */
  error: string | null
}
