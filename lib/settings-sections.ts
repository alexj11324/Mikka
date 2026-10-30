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
  /**
   * No page body yet: left out of the sidebar, its search and URL resolution (a link to it
   * opens 偏好设置). Delete the flag on the section's line when its UI lands.
   */
  unbuilt?: true
}

export const SETTINGS_SECTIONS: readonly SettingsSectionDef[] = [
  { id: 'account', group: 'personal', title: 'Account' },
  { id: 'security', group: 'personal', title: 'Security' },
  { id: 'preferences', group: 'personal', title: 'Preferences' },
  { id: 'notifications', group: 'personal', title: 'Notifications' },
  { id: 'memory', group: 'personal', title: 'Memory' },
  { id: 'connections', group: 'personal', title: 'Connections' },
  // 模型订阅: connecting the person's own provider accounts. 可用模型 (admin allowlist) is under Bots; 额度 is Usage.
  { id: 'models', group: 'personal', title: 'Model subscriptions' },
  { id: 'logins', group: 'personal', title: 'Logins and keys' },
  { id: 'privacy', group: 'personal', title: 'Data and privacy' },
  { id: 'activity', group: 'personal', title: 'Activity' },
  { id: 'computers', group: 'personal', title: 'Devices' },
  { id: 'developer', group: 'personal', title: 'Personal access tokens', unbuilt: true },
  { id: 'general', group: 'workspace', title: 'General' },
  { id: 'members', group: 'workspace', title: 'Members', routed: true },
  { id: 'teams', group: 'workspace', title: 'Teams', routed: true },
  { id: 'bots', group: 'workspace', title: 'Bots' },
  { id: 'permissions', group: 'workspace', title: 'Team permissions', adminOnly: true },
  { id: 'secrets', group: 'workspace', title: 'Secrets and environment', adminOnly: true, unbuilt: true },
  { id: 'audit', group: 'workspace', title: 'Audit log', adminOnly: true, unbuilt: true },
  { id: 'usage', group: 'workspace', title: 'Usage', unbuilt: true },
  { id: 'billing', group: 'workspace', title: 'Billing', adminOnly: true, unbuilt: true },
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

/** Sections settings can show: every section with a page body. */
const ids = new Set<string>(SETTINGS_SECTIONS.filter(s => !s.unbuilt).map(s => s.id))
const known = new Set<string>(SETTINGS_SECTIONS.map(s => s.id))

/** True for any `?section=` value settings can open, current, unbuilt (opens the fallback) or pre-v4. */
export function isSettingsSectionParam(section: string): boolean {
  return known.has(section) || Object.hasOwn(LEGACY, section)
}

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
  return SETTINGS_SECTIONS.filter(s => !s.unbuilt && (admin || !s.adminOnly))
}
