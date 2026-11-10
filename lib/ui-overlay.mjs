// The hosted UI layer (docs/ui-overlay.md, decision 2026-11-06-2000).
// Without MIKKA_UI_OVERLAY_DIR every slot is its default in components/slots/;
// with it, each slot resolves to the private layer's slots/<name>.tsx and
// `@hosted/*` to the layer's own files. next.config.mjs and the desktop
// renderer's Vite plugin both read this, so the two builds cannot disagree.
import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/** Every slot this repository offers. A layer may fill any subset. */
export const UI_SLOTS = ['all-threads', 'app-frame', 'artifacts', 'board', 'bot-avatar', 'bot-tasks', 'chat-composer', 'chat-message', 'inbox', 'memory', 'model-picker', 'onboarding', 'panel-header', 'plugins', 'reply-activity', 'review-page', 'review-summary', 'settings-account', 'settings-billing', 'settings-bot-permissions', 'settings-connections', 'settings-content', 'settings-devices', 'settings-frame', 'settings-general', 'settings-memory', 'settings-models', 'settings-notifications', 'settings-preferences', 'settings-privacy', 'settings-secrets', 'settings-security', 'settings-sidebar', 'settings-usage', 'task-column', 'tasks', 'task-conversation', 'task-detail', 'thread', 'thread-card', 'thread-header']

/**
 * The names every slot must export, in a layer as in the default. Callers may
 * import only these by name (`import { X } from '@ui-slot/…'`). Anything else a
 * slot exports is optional: read it through a namespace import with a fallback
 * (`import * as slot from '@ui-slot/…'; slot.X ?? fallback`), so a deployed
 * layer that predates it still builds. A missing named import fails the
 * production build; a missing namespace member is undefined. Adding a name here
 * needs the layer to export it first (docs/ui-overlay.md).
 */
export const UI_SLOT_EXPORTS = {
  'all-threads': ['AllThreadsColumn', 'AllThreadsToggle'],
  'app-frame': ['AppFrame', 'FRAME_LISTS_CHATS', 'FRAME_OWNS_HEADER', 'FRAME_OWNS_PANEL', 'IconRail'],
  'artifacts': ['ArtifactsPage'],
  'board': ['BoardCard', 'BoardColumnFrame', 'BoardHiddenLane'],
  'bot-avatar': ['BotAvatar'],
  'bot-tasks': ['BotTasks'],
  'chat-composer': ['ChatComposer'],
  'chat-message': ['CHAT_SURFACE', 'ChatMessage', 'ChatWaiting'],
  'inbox': ['INBOX_PHONE_HEADER', 'INBOX_TITLE', 'InboxPage'],
  'memory': ['MemoryPage'],
  'model-picker': ['BotModelPicker'],
  'panel-header': ['PanelHeader'],
  'plugins': [],
  'reply-activity': ['ActivityGroup', 'ActivityList', 'ActivityThinking', 'ActivityTool'],
  'review-page': ['ReviewPage'],
  'review-summary': ['ReviewSummaryLine'],
  'settings-account': ['AccountSettings'],
  'settings-billing': ['BillingPage'],
  'onboarding': ['Onboarding'],
  'settings-bot-permissions': ['BotPermissionsPage'],
  'settings-connections': ['ConnectionsList'],
  'settings-content': ['SettingsContentFrame'],
  'settings-devices': ['DevicesPage'],
  'settings-frame': ['SettingsFrame'],
  'settings-general': ['WorkspaceGeneral'],
  'settings-memory': ['MemorySettings'],
  'settings-models': ['ApiAndSubscriptions'],
  'settings-notifications': ['NotificationSettings'],
  'settings-preferences': ['PreferencesSettings'],
  'settings-privacy': ['PrivacySettings'],
  'settings-secrets': ['SecretsPage'],
  'settings-security': ['SecurityAndSignIn'],
  'settings-sidebar': ['SettingsSidebar'],
  'settings-usage': ['UsagePage'],
  'task-column': ['TaskColumn'],
  'tasks': ['TasksPage'],
  'task-conversation': [],
  'task-detail': [],
  'thread': [],
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
  if (!configured) return { dir: null, slots }
  const dir = resolve(repository, configured)
  if (!existsSync(dir)) throw new Error(`UI_OVERLAY_DIR_MISSING: ${configured}`)
  // Turbopack reads nothing outside the project root, and the layer must
  // resolve react and the app's own modules from this repository's node_modules.
  if (!inside(realpathSync(repository), realpathSync(dir))) throw new Error(`UI_OVERLAY_DIR_OUTSIDE_REPOSITORY: ${configured}`)
  for (const name of UI_SLOTS) {
    const file = resolve(dir, 'slots', `${name}.tsx`)
    if (existsSync(file)) slots[name] = file
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
