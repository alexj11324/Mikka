// What 设置 › Bot 权限 receives (docs/ui-overlay.md): one Bot's real permissions, from the routes that store them.
// - App writes (decision 2026-10-31, R-77): an explicit allow / ask / deny per action wins; with none, the Decision
//   API judges each exact call and only a destructive one (delete, overwrite) asks. Stored per Bot and per workspace
//   (`/api/bots/:botId/definition`, views write_policy / workspace_write_policy, actions set_write_policy).
// - Agent runs: the Bot's own layer of the run policy (`/api/agent-cli-policy`, readAgent / setAgent target agent),
//   which also holds the person's approval mode (ask / read_only).
// Red lines are the actions set to deny.

export type PermissionChoice = 'allow' | 'ask' | 'deny'
/** `default`: nothing stored, so an app write goes to the Decision API, an agent action to the workspace's policy. */
export type PermissionValue = PermissionChoice | 'default'

export type BotPermissionAction = {
  /** The stored key: a write action (send_slack_message) or a run action (install_dependency). */
  id: string
  name: string
  /** What this Bot stores. */
  value: PermissionValue
  /** What runs now, where it differs from `value` (the workspace or another layer narrowed it); null otherwise. */
  effective: PermissionChoice | null
  /** The choices this action takes (git_push: allow / deny; write_outside_repo: ask / deny). */
  choices: PermissionValue[]
  /** False where no route saves it (computer_use is set on the computer, not here) or the person may not. */
  editable: boolean
}

export type BotPermissionApp = {
  /** The toolkit (slack, notion, googlecalendar…) or Mikka's own app. */
  id: string
  name: string
  account: string | null
  iconUrl: string | null
  /** Its write actions with their own setting; an app with none is judged call by call. */
  actions: BotPermissionAction[]
}

export type SettingsBotPermissionsProps = {
  /** The person's Bots, the Coordinator first. */
  bots: { id: string | null; name: string }[]
  botId: string | null
  onBot: (id: string | null) => void
  /** Null while the first read is out. */
  apps: BotPermissionApp[] | null
  /** The Bot's run permissions; null when there is no worker to read them through yet. */
  run: BotPermissionAction[] | null
  /** The person's approval mode on this Bot; null when it cannot be read. */
  approvalMode: { value: 'ask' | 'read_only'; editable: boolean } | null
  onApprovalMode: (mode: 'ask' | 'read_only') => void
  /** Saves one or more actions of one kind to the same value. */
  onAction: (kind: 'write' | 'run', ids: string[], value: PermissionValue) => void
  saving: boolean
  /** A failed read or save, in the person's words. */
  error: string | null
}
