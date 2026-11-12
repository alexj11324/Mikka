// Members and Teams share one official Settings page. The public hooks own membership, invitations,
// roles and team navigation, including `team`, `view` and `create` in the current address.
export type SettingsMembersProps = {
  /** The section the address asks for. */
  section: 'members' | 'teams'
  workspaceId: string
  /** Open the invite once the role is known to be admin (an invite link from elsewhere, `&invite=1`). */
  inviteInitially: boolean
  /** Moves to the other section (the page's tabs). */
  onSection: (section: 'members' | 'teams') => void
}
