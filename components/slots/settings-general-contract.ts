// What the 常规 slot receives (docs/ui-overlay.md). Its reads and saves come
// from hooks/settings/use-workspace-general.ts.

export type SettingsGeneralProps = {
  workspaceId?: string
  userKey?: string
  /** A team workspace that is not a preview: its archived bots show too */
  showArchived: boolean
}
