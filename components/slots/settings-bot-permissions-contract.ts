// Workspace execution policy from /api/agent-cli-policy.
export type PermissionChoice = 'allow' | 'ask' | 'deny'
/** `default` inherits the scoped run policy. */
export type PermissionValue = PermissionChoice | 'default'

export type BotPermissionAction = {
  /** The key of the run action. */
  id: string
  name: string
  /** What the workspace stores. */
  value: PermissionValue
  /** The choices this action takes (git_push: allow / deny; write_outside_repo: ask / deny). */
  choices: PermissionValue[]
  /** False where no route saves it (computer_use is set on the computer, not here) or the person may not. */
  editable: boolean
}

export type SettingsBotPermissionsProps = {
  run: BotPermissionAction[] | null
  approvalMode: { value: 'ask' | 'read_only'; editable: boolean } | null
  onApprovalMode: (mode: 'ask' | 'read_only') => void
  onAction: (id: string, value: PermissionValue) => void
  saving: boolean
  error: string | null
}
