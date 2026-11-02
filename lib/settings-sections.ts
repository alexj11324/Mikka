/**
 * The settings sections, in the order of Figma 设置 v4 (`551:6857`). The sidebar,
 * the shell's URL parsing and the page body all read this list, so a section
 * exists in one place only.
 */
export type SettingsSectionId =
  | 'account' | 'security' | 'preferences' | 'notifications' | 'memory' | 'connections' | 'models'
  | 'logins' | 'privacy' | 'computers' | 'developer'
  | 'general' | 'members' | 'teams' | 'bots' | 'permissions' | 'secrets' | 'audit' | 'usage' | 'billing'

export interface SettingsSectionDef {
  id: SettingsSectionId
  /** 'personal' is the 账号 group (account-level); 'workspace' is the current workspace's group. */
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
  { id: 'models', group: 'personal', title: 'API and subscriptions' },
  { id: 'logins', group: 'personal', title: 'Logins and keys' },
  { id: 'privacy', group: 'personal', title: 'Data and privacy' },
  { id: 'computers', group: 'personal', title: 'Devices' },
  // Hidden until an API accepts the tokens (Alex); the UI and token store are built. Delete `unbuilt` to ship it.
  { id: 'developer', group: 'personal', title: 'Personal access tokens', unbuilt: true },
  { id: 'general', group: 'workspace', title: 'General' },
  { id: 'members', group: 'workspace', title: 'Members', routed: true },
  { id: 'teams', group: 'workspace', title: 'Teams', routed: true },
  { id: 'bots', group: 'workspace', title: 'Bots and agents' },
  { id: 'permissions', group: 'workspace', title: 'Team permissions', adminOnly: true },
  { id: 'secrets', group: 'workspace', title: 'Secrets and environment', adminOnly: true },
  { id: 'audit', group: 'workspace', title: 'Audit log', adminOnly: true },
  { id: 'usage', group: 'workspace', title: 'Usage' },
  // Members see 付款 here (their card designation and credit share); plan, balance and top-ups are admins' (C19).
  { id: 'billing', group: 'workspace', title: 'Billing' },
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

/**
 * What only a team has: what is between people (decision 2026-11-02-0203). A
 * personal workspace has every setting of the workspace itself (常规, Bot 与
 * Agents, 密钥与环境, 用量, 计费) and none of these: 成员, 团队, 团队权限, 审计日志.
 */
export const TEAM_ONLY_SECTIONS: ReadonlySet<SettingsSectionId> = new Set(['members', 'teams', 'permissions', 'audit'])

export function visibleSettingsSections({ admin, personal = false }: { admin: boolean; personal?: boolean }): SettingsSectionDef[] {
  return SETTINGS_SECTIONS.filter(s => !s.unbuilt && (admin || !s.adminOnly) && !(personal && TEAM_ONLY_SECTIONS.has(s.id)))
}
