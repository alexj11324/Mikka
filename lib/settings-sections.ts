/**
 * The settings sections, in the order of Figma 设置 v4 (`551:6857`). The sidebar,
 * the shell's URL parsing and the page body all read this list, so a section
 * exists in one place only.
 */
export type SettingsSectionId =
  | 'account' | 'security' | 'preferences' | 'notifications' | 'memory' | 'connections' | 'models'
  | 'logins' | 'privacy' | 'activity' | 'computers' | 'developer'
  | 'general' | 'members' | 'teams' | 'bots' | 'permissions' | 'secrets' | 'audit' | 'usage' | 'billing'

export interface SettingsSectionDef {
  id: SettingsSectionId
  group: 'personal' | 'workspace'
  /** English name; the sidebar search matches it in any locale. */
  title: string
  /** Hidden from members, as in S-P. The server still checks the role. */
  adminOnly?: boolean
  /** Has its own route instead of `?section=`. */
  routed?: boolean
}

export const SETTINGS_SECTIONS: readonly SettingsSectionDef[] = [
  { id: 'account', group: 'personal', title: 'Account' },
  { id: 'security', group: 'personal', title: 'Security' },
  { id: 'preferences', group: 'personal', title: 'Preferences' },
  { id: 'notifications', group: 'personal', title: 'Notifications' },
  { id: 'memory', group: 'personal', title: 'Memory' },
  { id: 'connections', group: 'personal', title: 'Connections' },
  { id: 'models', group: 'personal', title: 'Models' },
  { id: 'logins', group: 'personal', title: 'Logins and keys' },
  { id: 'privacy', group: 'personal', title: 'Data and privacy' },
  { id: 'activity', group: 'personal', title: 'Activity' },
  { id: 'computers', group: 'personal', title: 'Computers' },
  { id: 'developer', group: 'personal', title: 'Developer' },
  { id: 'general', group: 'workspace', title: 'General' },
  { id: 'members', group: 'workspace', title: 'Members', routed: true },
  { id: 'teams', group: 'workspace', title: 'Teams', routed: true },
  { id: 'bots', group: 'workspace', title: 'Bots' },
  { id: 'permissions', group: 'workspace', title: 'Permissions', adminOnly: true },
  { id: 'secrets', group: 'workspace', title: 'Secrets and environment', adminOnly: true },
  { id: 'audit', group: 'workspace', title: 'Audit log', adminOnly: true },
  { id: 'usage', group: 'workspace', title: 'Usage' },
  { id: 'billing', group: 'workspace', title: 'Billing', adminOnly: true },
]

/** Section ids from before v4. Old links open the page that now holds the content. */
const LEGACY: Record<string, SettingsSectionId> = {
  profile: 'account',
  // v3's ?section=account was the identity + sign-in page, now split into 账户 and 安全.
  // A current id always wins, so this only catches ids v4 does not use.
  integrations: 'connections',
  devices: 'computers',
  workspace: 'general',
}

const ids = new Set<string>(SETTINGS_SECTIONS.map(s => s.id))

/** The section a settings URL shows. `/settings/members` and `/settings/teams` win over `?section=`. */
export function resolveSettingsSection(pathname: string, section: string | null | undefined): SettingsSectionId {
  if (pathname.endsWith('/settings/members')) return 'members'
  if (pathname.endsWith('/settings/teams')) return 'teams'
  if (section && ids.has(section)) return section as SettingsSectionId
  if (section && section in LEGACY) return LEGACY[section]
  return 'preferences'
}

export function settingsHref(id: SettingsSectionId, workspaceId?: string): string {
  const def = SETTINGS_SECTIONS.find(s => s.id === id)
  const search = new URLSearchParams(workspaceId ? { workspace: workspaceId } : {})
  if (def?.routed) return `/settings/${id}${search.size ? `?${search}` : ''}`
  search.set('section', id)
  return `/settings?${search}`
}

export function visibleSettingsSections({ admin }: { admin: boolean }): SettingsSectionDef[] {
  return SETTINGS_SECTIONS.filter(s => admin || !s.adminOnly)
}
