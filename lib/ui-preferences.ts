// Personal interface preferences stored on user_preferences.uiPreferences.
// Client-safe: the settings page, the composer and the icon rail all read it.

import { z } from 'zod'

export const RAIL_PAGE_IDS = ['chats', 'pulls', 'automations', 'suggestions', 'board', 'plugins', 'artifacts'] as const
export type RailPageId = (typeof RAIL_PAGE_IDS)[number]

export const RUN_KEY_ACTIONS = ['steer', 'interrupt', 'queue'] as const
export type RunKeyAction = (typeof RUN_KEY_ACTIONS)[number]
export const SIDEBAR_LAYOUTS = ['hybrid', 'columns'] as const
export const COLOR_SCHEMES = ['light', 'dark', 'system'] as const
export const CODE_SIZES = ['default', 'small', 'large'] as const
export const DIFF_VIEWS = ['unified', 'split'] as const
export const DIFF_COLORS = ['redGreen', 'blue'] as const
export const HIDDEN_FILES = ['hide', 'dim', 'show'] as const
export const BACKGROUNDS = ['none', 'color'] as const

export const UI_THEMES = [
  { id: 'mikka', accent: '#2365db', fill: '#ffffff', foreground: '#171717' },
  { id: 'sakura', accent: '#e85d8c', fill: '#fff5f8', foreground: '#3b1d2a' },
  { id: 'oled', accent: '#7aa2ff', fill: '#000000', foreground: '#f5f5f5' },
  { id: 'softPurple', accent: '#8b6cff', fill: '#f6f3ff', foreground: '#241b3a' },
  { id: 'terminal', accent: '#3dd68c', fill: '#101614', foreground: '#d7ffe9' },
  { id: 'deepSea', accent: '#3aa0c8', fill: '#07141c', foreground: '#d5eef8' },
  { id: 'forest', accent: '#3f8f4e', fill: '#f3f7f2', foreground: '#1b2b1c' },
  { id: 'warm', accent: '#e07a2f', fill: '#fff6ee', foreground: '#3a2416' },
  { id: 'codeCyan', accent: '#14b8c4', fill: '#f2fbfb', foreground: '#102628' },
  { id: 'contrast', accent: '#111111', fill: '#ffffff', foreground: '#000000' },
  { id: 'slate', accent: '#5b6b7c', fill: '#f4f6f8', foreground: '#1c2430' },
  { id: 'lilac', accent: '#a06bc4', fill: '#faf6fc', foreground: '#2c1e33' },
  { id: 'bright', accent: '#f2b84b', fill: '#fffdf8', foreground: '#2a2416' },
  { id: 'midnight', accent: '#8aa0ff', fill: '#0c1020', foreground: '#e8ecff' },
] as const

export type UiThemeId = (typeof UI_THEMES)[number]['id']
const THEME_IDS = UI_THEMES.map(theme => theme.id) as [UiThemeId, ...UiThemeId[]]
const RAIL_IDS = RAIL_PAGE_IDS
const HEX = z.string().regex(/^#[0-9a-fA-F]{6}$/)

export interface UiPreferences {
  sidebarPages: RailPageId[]
  sidebarLayout: (typeof SIDEBAR_LAYOUTS)[number]
  pinPages: boolean
  openInDesktop: boolean
  scrollNewToTop: boolean
  enterAction: RunKeyAction
  modEnterAction: RunKeyAction
  altEnterAction: RunKeyAction
  microphone: 'system'
  appearanceSync: boolean
  colorScheme: (typeof COLOR_SCHEMES)[number]
  themeId: UiThemeId
  accent: string
  fill: string
  foreground: string
  background: (typeof BACKGROUNDS)[number]
  codeSize: (typeof CODE_SIZES)[number]
  diffView: (typeof DIFF_VIEWS)[number]
  diffColor: (typeof DIFF_COLORS)[number]
  hiddenFiles: (typeof HIDDEN_FILES)[number]
}

export const DEFAULT_UI: UiPreferences = {
  sidebarPages: [],
  sidebarLayout: 'hybrid',
  pinPages: false,
  openInDesktop: false,
  scrollNewToTop: true,
  enterAction: 'steer',
  modEnterAction: 'interrupt',
  altEnterAction: 'queue',
  microphone: 'system',
  appearanceSync: true,
  colorScheme: 'system',
  themeId: 'mikka',
  accent: '#2365db',
  fill: '#ffffff',
  foreground: '#171717',
  background: 'none',
  codeSize: 'default',
  diffView: 'unified',
  diffColor: 'redGreen',
  hiddenFiles: 'hide',
}

export const uiPreferencesSchema = z.object({
  sidebarPages: z.array(z.enum(RAIL_IDS)).max(RAIL_IDS.length),
  sidebarLayout: z.enum(SIDEBAR_LAYOUTS),
  pinPages: z.boolean(),
  openInDesktop: z.boolean(),
  scrollNewToTop: z.boolean(),
  enterAction: z.enum(RUN_KEY_ACTIONS),
  modEnterAction: z.enum(RUN_KEY_ACTIONS),
  altEnterAction: z.enum(RUN_KEY_ACTIONS),
  microphone: z.literal('system'),
  appearanceSync: z.boolean(),
  colorScheme: z.enum(COLOR_SCHEMES),
  themeId: z.enum(THEME_IDS),
  accent: HEX,
  fill: HEX,
  foreground: HEX,
  background: z.enum(BACKGROUNDS),
  codeSize: z.enum(CODE_SIZES),
  diffView: z.enum(DIFF_VIEWS),
  diffColor: z.enum(DIFF_COLORS),
  hiddenFiles: z.enum(HIDDEN_FILES),
}).partial()

export type UiPreferencesPatch = z.infer<typeof uiPreferencesSchema>

/** Fills anything the stored object left out. An empty column is the defaults. */
export function normalizeUi(stored: unknown): UiPreferences {
  const patch = uiPreferencesSchema.safeParse(stored ?? {})
  const value = patch.success ? patch.data : {}
  return { ...DEFAULT_UI, ...value, sidebarPages: value.sidebarPages ?? DEFAULT_UI.sidebarPages }
}

export function themeById(id: string) {
  return UI_THEMES.find(theme => theme.id === id) ?? UI_THEMES[0]
}

/** The colors actually painted: a named theme, then any custom hex the person set. */
export function resolvedColors(ui: UiPreferences) {
  if (ui.themeId === 'mikka') return { accent: ui.accent, fill: ui.fill, foreground: ui.foreground }
  const theme = themeById(ui.themeId)
  return { accent: theme.accent, fill: theme.fill, foreground: theme.foreground }
}

let published = DEFAULT_UI

export function currentUiPreferences() {
  return published
}

/** Paints the open document and remembers the value for the composer and the rail. */
export function publishUiPreferences(ui: UiPreferences, root: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement) {
  published = ui
  if (!root) return
  const colors = resolvedColors(ui)
  root.dataset.sidebarLayout = ui.sidebarLayout
  root.dataset.pinPages = String(ui.pinPages)
  root.dataset.scrollNewToTop = String(ui.scrollNewToTop)
  root.dataset.openInDesktop = String(ui.openInDesktop)
  root.dataset.codeSize = ui.codeSize
  root.dataset.diffView = ui.diffView
  root.dataset.diffColor = ui.diffColor
  root.dataset.hiddenFiles = ui.hiddenFiles
  root.dataset.uiTheme = ui.themeId
  root.style.setProperty('--ui-accent', colors.accent)
  root.style.setProperty('--ui-fill', colors.fill)
  root.style.setProperty('--ui-foreground', colors.foreground)
  root.style.setProperty('--code-font-size', ui.codeSize === 'small' ? '12px' : ui.codeSize === 'large' ? '16px' : '14px')
}

export interface RunKeyEvent { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; isComposing: boolean }

/** Which saved action a keydown asks for while a run is in progress. Shift and an IME never count. */
export function runKeyAction(event: RunKeyEvent, ui: UiPreferences = published): RunKeyAction | null {
  if (event.isComposing || event.shiftKey || event.key !== 'Enter') return null
  if (event.altKey && !event.metaKey && !event.ctrlKey) return ui.altEnterAction
  if ((event.metaKey || event.ctrlKey) && !event.altKey) return ui.modEnterAction
  if (!event.metaKey && !event.ctrlKey && !event.altKey) return ui.enterAction
  return null
}
