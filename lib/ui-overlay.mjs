// The hosted UI layer (docs/ui-overlay.md, decision 2026-11-06-2000).
// Without MIKKA_UI_OVERLAY_DIR every slot is its default in components/slots/;
// with it, each required provider resolves to the private layer's slots/<name>.tsx and
// `@hosted/*` to the layer's own files. The web and desktop Vite builds both
// read this (apps/frontend/scripts/application-plugin.mjs), so the two cannot
// disagree.
import { existsSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/** Web and Desktop share these bindings. Native slots are registered separately. */
export const UI_SLOTS = ['all-threads', 'app-frame', 'artifacts', 'auth-sso', 'board', 'bot-avatar', 'bot-overview', 'bot-tasks', 'chat-composer', 'chat-message', 'inbox', 'memory', 'model-picker', 'new-bot', 'new-task', 'onboarding', 'panel-header', 'plugins', 'reply-activity', 'review-page', 'review-summary', 'search', 'settings-account', 'settings-audit', 'settings-billing', 'settings-bot-permissions', 'settings-connections', 'settings-content', 'settings-devices', 'settings-frame', 'settings-general', 'settings-governance', 'settings-members', 'settings-memory', 'settings-models', 'settings-notifications', 'settings-organization', 'settings-permissions', 'settings-preferences', 'settings-privacy', 'settings-secrets', 'settings-security', 'settings-sidebar', 'settings-usage', 'task-column', 'tasks', 'task-conversation', 'task-detail', 'thread', 'thread-card', 'thread-header']

// These names are ESM link requirements in an official build. The three
// public no-content contracts can gain a private provider in a later release.
export const PUBLIC_CONTRACT_SLOTS = new Set(['auth-sso', 'settings-governance', 'settings-organization'])
export const UI_SLOT_EXPORTS = {
  'all-threads': ['AllThreadsColumn', 'AllThreadsToggle'],
  'app-frame': ['AppFrame', 'FRAME_LISTS_CHATS', 'FRAME_OWNS_HEADER', 'FRAME_OWNS_PANEL', 'IconRail'],
  'artifacts': ['ArtifactsPage'],
  'auth-sso': ['AuthSso'],
  'board': ['BoardCard', 'BoardColumnFrame', 'BoardHiddenLane', 'BoardScreen'],
  'bot-avatar': ['BotAvatar'],
  'bot-overview': ['BotOverview'],
  'bot-tasks': ['BotTasks', 'LISTS_TASKS'],
  'chat-composer': ['ChatComposer'],
  'chat-message': ['CHAT_SURFACE', 'ChatMessage', 'ChatWaiting'],
  'inbox': ['INBOX_PHONE_HEADER', 'INBOX_TITLE', 'InboxPage'],
  'memory': ['MemoryPage'],
  'model-picker': ['BotModelPicker'],
  'new-bot': ['NewBot'],
  'new-task': ['NewTask'],
  'panel-header': ['PanelHeader', 'PANEL_INITIAL_WIDTH'],
  'plugins': ['PluginsPage'],
  'reply-activity': ['ActivityGroup', 'ActivityList', 'ActivityThinking', 'ActivityTool'],
  'review-page': ['ReviewPage'],
  'review-summary': ['ReviewSummaryLine', 'REVIEW_ENABLED'],
  'search': ['SearchPalette'],
  'settings-account': ['AccountSettings'],
  'settings-audit': ['AuditLogPage'],
  'settings-billing': ['BillingPage'],
  'onboarding': ['Onboarding'],
  'settings-bot-permissions': ['BotPermissionsPage'],
  'settings-connections': ['ConnectionsList', 'AppPage'],
  'settings-content': ['SettingsContentFrame'],
  'settings-devices': ['DevicesPage'],
  'settings-frame': ['SettingsFrame', 'OWN_SETTINGS_FRAME'],
  'settings-general': ['WorkspaceGeneral'],
  'settings-governance': ['GovernancePlan', 'GovernanceTemplates', 'GovernanceUsage'],
  'settings-members': ['MembersScreen'],
  'settings-memory': ['MemorySettings'],
  'settings-models': ['ApiAndSubscriptions'],
  'settings-notifications': ['NotificationSettings'],
  'settings-organization': ['ORGANIZATION_SETTINGS', 'OrganizationSettings'],
  'settings-permissions': ['TeamPermissionsPage'],
  'settings-preferences': ['PreferencesSettings'],
  'settings-privacy': ['PrivacySettings'],
  'settings-secrets': ['SecretsPage'],
  'settings-security': ['SecurityAndSignIn'],
  'settings-sidebar': ['SettingsSidebar'],
  'settings-usage': ['UsagePage'],
  'task-column': ['TaskColumn'],
  'tasks': ['TasksPage'],
  'task-conversation': ['TaskConversation'],
  'task-detail': ['TaskDetailFrame'],
  'thread': ['ThreadScreen'],
  'thread-card': ['ThreadCard'],
  'thread-header': ['ThreadHeader', 'ThreadStatusLine'],
}

export const SLOT_PREFIX = '@ui-slot/'
export const HOSTED_PREFIX = '@hosted/'

const inside = (root, path) => {
  const rel = relative(root, path)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * Where each slot and the layer's own `@hosted/` imports resolve for this
 * build. Paths are absolute; `relativeAliases` gives them as Turbopack wants
 * them (`./…` from the repository).
 */
export function uiOverlay(repository, env = process.env) {
  const configured = env.MIKKA_UI_OVERLAY_DIR?.trim()
  const slots = Object.fromEntries(UI_SLOTS.map(name => [name, resolve(repository, 'components/slots', `${name}.tsx`)]))
  if (!configured) {
    if (env.MIKKA_UI_OVERLAY_SHA) throw new Error('UI_OVERLAY_DIR_REQUIRED_FOR_RELEASE')
    return { dir: null, slots }
  }
  const dir = resolve(repository, configured)
  if (!existsSync(dir)) throw new Error(`UI_OVERLAY_DIR_MISSING: ${configured}`)
  // Turbopack reads nothing outside the project root, and the layer must
  // resolve react and the app's own modules from this repository's node_modules.
  if (!inside(realpathSync(repository), realpathSync(dir))) throw new Error(`UI_OVERLAY_DIR_OUTSIDE_REPOSITORY: ${configured}`)
  for (const name of UI_SLOTS) {
    const file = resolve(dir, 'slots', `${name}.tsx`)
    if (!existsSync(file)) {
      if (PUBLIC_CONTRACT_SLOTS.has(name)) continue
      throw new Error(`UI_OVERLAY_SLOT_REQUIRED: ${name}`)
    }
    if (!inside(realpathSync(dir), realpathSync(file)) || !statSync(file).isFile()) throw new Error(`UI_OVERLAY_SLOT_INVALID: ${name}`)
    slots[name] = file
  }
  return { dir, slots }
}

/** The bundler aliases for this build, absolute (webpack, Vite) and `./`-relative (Turbopack). */
export function overlayAliases(repository, env = process.env) {
  const { dir, slots } = uiOverlay(repository, env)
  const toRelative = path => `./${relative(repository, path).split(sep).join('/')}`
  const absolute = Object.fromEntries(Object.entries(slots).map(([name, file]) => [`${SLOT_PREFIX}${name}`, file]))
  const turbopack = Object.fromEntries(Object.entries(absolute).map(([specifier, file]) => [specifier, toRelative(file)]))
  if (dir) turbopack[`${HOSTED_PREFIX}*`] = `${toRelative(dir)}/*`
  return { dir, absolute, turbopack }
}

/** Resolve one import specifier for the Vite plugin, or null when it is not a slot or `@hosted/` import. */
export function resolveOverlaySpecifier(source, aliases) {
  if (source.startsWith(SLOT_PREFIX)) {
    const file = aliases.absolute[source]
    if (!file) throw new Error(`UI_SLOT_UNKNOWN: ${source}`)
    return file
  }
  if (source.startsWith(HOSTED_PREFIX)) {
    if (!aliases.dir) throw new Error(`UI_OVERLAY_IMPORT_WITHOUT_OVERLAY: ${source}`)
    return resolve(aliases.dir, source.slice(HOSTED_PREFIX.length))
  }
  return null
}
