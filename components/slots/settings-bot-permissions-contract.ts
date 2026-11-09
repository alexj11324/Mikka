// What 设置 › Bot 权限 receives (docs/ui-overlay.md). The shape follows #1832's
// `GET /api/bots/:botId/permissions`: a mode, the connected apps with each
// action's level, and the red lines. Until that API lands, Mikka fills it from
// today's one fixed rule (every write asks first) and `editable` is false, so a
// layer shows the values and offers no control that would not be saved.

/** allow: does it on its own · ask: waits for the person's OK · never: will not do it. */
export type BotPermissionLevel = 'allow' | 'ask' | 'never'
/** careful: every write asks (today's rule, the default) · balanced: low-risk writes run · hands_off: all but the red lines run. */
export type BotPermissionMode = 'careful' | 'balanced' | 'hands_off'

export type BotPermissionAction = {
  id: string
  /** In the person's words: 发送 Slack 消息. */
  name: string
  /** read · write · risky: what a mode goes by. */
  kind: 'read' | 'write' | 'risky'
  /** The level in effect. */
  level: BotPermissionLevel
}

export type BotPermissionApp = {
  /** The toolkit (slack, notion, googlecalendar…) or Mikka's own app (github, linear, telegram). */
  id: string
  name: string
  /** The connected account's name, when there is one. */
  account: string | null
  iconUrl: string | null
  actions: BotPermissionAction[]
}

export type BotPermissions = {
  mode: BotPermissionMode
  apps: BotPermissionApp[]
  /** The person's own never-do lines (#1832); none until that ships. */
  redLines: { id: string; text: string }[]
  /** False while the settings are not saved anywhere (before #1832): controls show their value, disabled. */
  editable: boolean
}

export type SettingsBotPermissionsProps = {
  /** Null while the connected apps load. */
  permissions: BotPermissions | null
}
