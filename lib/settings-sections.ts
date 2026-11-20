/**
 * Settings sections, in the order of Figma page 1508:2 (Capy's four groups).
 * The sidebar, URL parsing and the page body all read this list.
 */
export type SettingsGroup = 'personal' | 'agent' | 'review' | 'workspace'

export const SETTINGS_GROUPS = ['personal', 'agent', 'review', 'workspace'] as const satisfies readonly SettingsGroup[]

export type SettingsSectionId =
  | 'preferences' | 'appearance' | 'account' | 'security' | 'notifications' | 'models'
  | 'environments' | 'connections' | 'logins' | 'developer' | 'computers'
  | 'instructions'
  | 'shortcuts' | 'git' | 'review-repositories' | 'review-config' | 'activity'
  | 'general' | 'issue-states' | 'members' | 'teams' | 'permissions' | 'secrets'
  | 'audit' | 'organization' | 'usage' | 'billing' | 'cloud'
  | 'referrals' | 'experiments' | 'cloud-credentials'

export interface SettingsSectionDef {
  id: SettingsSectionId
  group: SettingsGroup
  /** English name; the sidebar search matches it in any locale. */
  title: string
  /** Hidden from members. The server still checks the role. */
  adminOnly?: boolean
  /** Has its own route instead of `?section=`. */
  routed?: boolean
  /**
   * No page body yet: left out of the sidebar. A link opens 常规.
   * Delete the flag when its UI lands.
   */
  unbuilt?: true
  /** Decided not to build (推荐奖励, 实验功能, 云凭据). Not a link. */
  withheld?: true
  /** Reachable by an old or direct URL, not listed in the sidebar. */
  sidebar?: false
}

export const SETTINGS_SECTIONS: readonly SettingsSectionDef[] = [
  { id: 'preferences', group: 'personal', title: 'General' },
  { id: 'appearance', group: 'personal', title: 'Appearance' },
  { id: 'account', group: 'personal', title: 'Profile' },
  { id: 'security', group: 'personal', title: 'Security' },
  { id: 'notifications', group: 'personal', title: 'Notifications' },
  { id: 'models', group: 'personal', title: 'Models and subscriptions' },
  { id: 'environments', group: 'personal', title: 'Run environments' },
  { id: 'connections', group: 'personal', title: 'Integrations' },
  // Personal secrets stay one click from an old link; the sidebar entry is 集成.
  { id: 'logins', group: 'personal', title: 'Secrets and logins', sidebar: false },
  { id: 'developer', group: 'personal', title: 'Personal access tokens' },
  { id: 'computers', group: 'personal', title: 'Devices' },
  { id: 'instructions', group: 'agent', title: 'Instructions' },
  // Hidden until #2956 merges. Do not render placeholder data for these.
  // shortcuts: P9. git, review-repositories, review-config: P5. activity: P8.
  // MCP server detail (P4) stays on 集成 until that API exists.
  { id: 'shortcuts', group: 'personal', title: 'Shortcuts', unbuilt: true },
  { id: 'git', group: 'agent', title: 'Git and pull requests', unbuilt: true },
  { id: 'review-repositories', group: 'review', title: 'Review repositories', unbuilt: true },
  { id: 'review-config', group: 'review', title: 'Review config', unbuilt: true },
  { id: 'activity', group: 'workspace', title: 'Activity', unbuilt: true },
  { id: 'general', group: 'workspace', title: 'Workspace general' },
  { id: 'issue-states', group: 'workspace', title: 'Issue states' },
  { id: 'members', group: 'workspace', title: 'Members', routed: true },
  { id: 'teams', group: 'workspace', title: 'Teams', routed: true },
  { id: 'permissions', group: 'workspace', title: 'Team permissions', adminOnly: true },
  { id: 'secrets', group: 'workspace', title: 'Secrets and environment', sidebar: false },
  { id: 'audit', group: 'workspace', title: 'Audit log', adminOnly: true },
  // Only a UI layer that draws it shows 组织 (slot settings-organization).
  { id: 'organization', group: 'workspace', title: 'Organization' },
  { id: 'usage', group: 'workspace', title: 'Usage' },
  { id: 'billing', group: 'workspace', title: 'Billing' },
  { id: 'cloud', group: 'workspace', title: 'Mikka Cloud' },
  { id: 'referrals', group: 'personal', title: 'Referrals', withheld: true },
  { id: 'experiments', group: 'personal', title: 'Experiments', withheld: true },
  { id: 'cloud-credentials', group: 'personal', title: 'Cloud credentials', withheld: true },
]

/** Section ids from before the four groups. Old links open the page that now holds the content. */
const LEGACY: Record<string, SettingsSectionId> = {
  profile: 'account',
  integrations: 'connections',
  devices: 'computers',
  workspace: 'general',
  bots: 'models',
  memory: 'instructions',
  privacy: 'account',
  'bot-permissions': 'computers',
}

/**
 * What only a team has: what is between people (decision 2026-11-02-0203). A
 * personal workspace has every setting of the workspace itself and none of these.
 */
export const TEAM_ONLY_SECTIONS: ReadonlySet<SettingsSectionId> = new Set(['members', 'teams', 'permissions', 'audit'])

export type SettingsVisibility = {
  admin: boolean
  personal?: boolean
  billing?: boolean
  cloudAdmin?: boolean
  /** A UI layer draws 组织. */
  organization?: boolean
}

/** One place decides whether a section is listed. The sidebar and search both ask this. */
export function settingsSectionShown(section: SettingsSectionDef, { admin, personal = false, billing = true, cloudAdmin = false, organization = false }: SettingsVisibility): boolean {
  if (section.withheld || section.unbuilt || section.sidebar === false) return false
  if (section.adminOnly && !admin) return false
  if (personal && TEAM_ONLY_SECTIONS.has(section.id)) return false
  if (!billing && section.id === 'billing') return false
  if (!cloudAdmin && section.id === 'cloud') return false
  if (!organization && section.id === 'organization') return false
  return true
}

const openable = new Set<string>(SETTINGS_SECTIONS.filter(s => !s.unbuilt && !s.withheld).map(s => s.id))
const known = new Set<string>(SETTINGS_SECTIONS.filter(s => !s.withheld).map(s => s.id))

/** True for any `?section=` value settings can open, current, unbuilt (opens 常规) or legacy. Withheld ids are not links. */
export function isSettingsSectionParam(section: string): boolean {
  return known.has(section) || Object.hasOwn(LEGACY, section)
}

/** The section a settings URL shows. `/settings/members` and `/settings/teams` win over `?section=`. */
export function resolveSettingsSection(pathname: string, section: string | null | undefined): SettingsSectionId {
  if (pathname.endsWith('/settings/members')) return 'members'
  if (pathname.endsWith('/settings/teams')) return 'teams'
  if (section && openable.has(section)) return section as SettingsSectionId
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

export function visibleSettingsSections(ctx: SettingsVisibility): SettingsSectionDef[] {
  return SETTINGS_SECTIONS.filter(section => settingsSectionShown(section, ctx))
}
