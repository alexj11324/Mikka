// 设置 › 成员 and 设置 › 团队 drawn by a UI layer as one page with two tabs (docs/ui-overlay.md).
// The layer reads and saves through the public hooks, the same reads, confirmations and actions as the
// open-source pages: useWorkspaceMembers and useInviteMembers (hooks/settings/use-workspace-members.ts,
// use-invite-members.ts) for 成员; useTeamDirectory, useTeamForm and useTeamMembers
// (hooks/settings/use-team-directory.ts) for 团队, whose address (`&team=`, `&view=`, `&create=1`) they read.
export type SettingsMembersProps = {
  /** The section the address asks for. */
  section: 'members' | 'teams'
  workspaceId: string
  /** Open the invite once the role is known to be admin (an invite link from elsewhere, `&invite=1`). */
  inviteInitially: boolean
  /** Moves to the other section (the page's tabs). */
  onSection: (section: 'members' | 'teams') => void
}
