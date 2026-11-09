// 设置 › 成员 drawn by a UI layer (docs/ui-overlay.md): the workspace whose members are shown.
// The layer reads and saves through useWorkspaceMembers (hooks/settings/use-workspace-members.tsx),
// the same reads, confirmations and actions as the open-source MembersSettings.
export type SettingsMembersProps = {
  workspaceId: string
  /** Open the invite dialog once the role is known to be admin (an invite link from elsewhere). */
  inviteInitially: boolean
}
