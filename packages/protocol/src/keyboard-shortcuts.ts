/** Shared action identities and defaults. Page code keeps its own navigation,
 * editor and dialog keys; only these existing product actions are configurable. */
export type KeyboardShortcutScope = 'global' | 'workspace' | 'board' | 'details' | 'devices'
export type KeyboardShortcutContext = { scope: KeyboardShortcutScope; editable: boolean; modal: boolean; target?: 'task' }
type ActionDefinition = {
  action: string; defaultBinding: string; metadataKey: string;
  context: KeyboardShortcutContext;
}

export const KEYBOARD_SHORTCUT_ACTIONS = [
  { action: 'search.open', defaultBinding: 'Mod+KeyK', metadataKey: 'keyboardShortcutSearchOpen', context: { scope: 'global', editable: true, modal: false } },
  { action: 'settings.open', defaultBinding: 'Mod+Comma', metadataKey: 'keyboardShortcutSettingsOpen', context: { scope: 'global', editable: false, modal: false } },
  { action: 'task.create', defaultBinding: 'KeyC', metadataKey: 'keyboardShortcutTaskCreate', context: { scope: 'workspace', editable: false, modal: false } },
  { action: 'sidebar.toggle', defaultBinding: 'Mod+KeyB', metadataKey: 'keyboardShortcutSidebarToggle', context: { scope: 'global', editable: true, modal: true } },
  { action: 'review.open', defaultBinding: 'Mod+Shift+KeyB', metadataKey: 'keyboardShortcutReviewOpen', context: { scope: 'workspace', editable: true, modal: false, target: 'task' } },
  { action: 'board.assistant.toggle', defaultBinding: 'Mod+KeyJ', metadataKey: 'keyboardShortcutBoardAssistantToggle', context: { scope: 'board', editable: true, modal: true } },
  { action: 'details.toggle', defaultBinding: 'Mod+KeyI', metadataKey: 'keyboardShortcutDetailsToggle', context: { scope: 'details', editable: false, modal: false } },
  { action: 'devices.add', defaultBinding: 'Mod+KeyN', metadataKey: 'keyboardShortcutDevicesAdd', context: { scope: 'devices', editable: true, modal: true } },
  { action: 'theme.toggle', defaultBinding: 'KeyD', metadataKey: 'keyboardShortcutThemeToggle', context: { scope: 'global', editable: false, modal: false } },
] as const satisfies readonly ActionDefinition[]

export type KeyboardShortcutAction = typeof KEYBOARD_SHORTCUT_ACTIONS[number]['action']
export type KeyboardShortcutSettingKey = `keyboardShortcuts.${KeyboardShortcutAction}`
export const keyboardShortcutSettingKey = <A extends KeyboardShortcutAction>(action: A): `keyboardShortcuts.${A}` => `keyboardShortcuts.${action}`
export type KeyboardShortcutBindings = Partial<Record<KeyboardShortcutAction, string | null>>
export type KeyboardShortcutConflict = { actions: [KeyboardShortcutAction, KeyboardShortcutAction]; bindings: [string, string]; platforms: ('apple' | 'other')[] }
export type KeyboardShortcutConflictResponse = { error: 'keyboardShortcutConflict'; conflicts: KeyboardShortcutConflict[] }

const modifierOrder = ['Mod', 'Ctrl', 'Meta', 'Alt', 'Shift'] as const
const modifiers: Record<string, typeof modifierOrder[number]> = { mod: 'Mod', cmdorctrl: 'Mod', commandorcontrol: 'Mod', ctrl: 'Ctrl', control: 'Ctrl', meta: 'Meta', cmd: 'Meta', command: 'Meta', alt: 'Alt', option: 'Alt', shift: 'Shift' }
const codes = ['Comma', 'Period', 'Slash', 'Backslash', 'Semicolon', 'Quote', 'BracketLeft', 'BracketRight', 'Minus', 'Equal', 'Backquote', 'Space', 'Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete', 'Backspace']
const namedCodes: Record<string, string> = Object.fromEntries(codes.map(code => [code.toLowerCase(), code]))
const punctuation: Record<string, string> = { ',': 'Comma', '.': 'Period', '/': 'Slash', '\\': 'Backslash', ';': 'Semicolon', "'": 'Quote', '[': 'BracketLeft', ']': 'BracketRight', '-': 'Minus', '=': 'Equal', '`': 'Backquote' }
const navigationCodes = new Set(['Space', 'Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete', 'Backspace'])

/** Empty disables an action. Invalid input is null, distinct from disabled.
 * Physical codes keep punctuation/Shift stable across keyboard layouts. */
export function normalizeKeyboardShortcut(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return ''
  if (trimmed.length > 80) return null
  const parts = trimmed.split('+').map(part => part.trim())
  const rawKey = parts.pop()!
  if (!rawKey || parts.length > 4) return null
  const active = new Set<string>()
  for (const part of parts) {
    const name = part.toLowerCase()
    const modifier = Object.hasOwn(modifiers, name) ? modifiers[name] : undefined
    if (!modifier || active.has(modifier)) return null
    active.add(modifier)
  }
  if (active.has('Mod') && (active.has('Ctrl') || active.has('Meta'))) return null
  const lower = rawKey.toLowerCase()
  const code = /^[a-z]$/.test(lower) ? `Key${lower.toUpperCase()}`
    : /^key[a-z]$/.test(lower) ? `Key${lower.slice(3).toUpperCase()}`
    : /^\d$/.test(lower) ? `Digit${lower}` : /^digit\d$/.test(lower) ? `Digit${lower.slice(5)}`
    : /^f(?:[1-9]|1\d|2[0-4])$/.test(lower) ? lower.toUpperCase()
    : Object.hasOwn(namedCodes, lower) ? namedCodes[lower] : Object.hasOwn(punctuation, rawKey) ? punctuation[rawKey] : undefined
  if (!code) return null
  // Focus, selection, dismissal and editor navigation remain owned by their
  // existing controls, including Shift+Tab and Shift+Arrow selection.
  if (navigationCodes.has(code) && [...active].every(modifier => modifier === 'Shift')) return null
  return [...modifierOrder.filter(modifier => active.has(modifier)), code].join('+')
}

function overlap(left: KeyboardShortcutScope, right: KeyboardShortcutScope) {
  if (left === 'global' || right === 'global' || left === right) return true
  const workspace = new Set<KeyboardShortcutScope>(['workspace', 'board', 'details'])
  return (left === 'workspace' || right === 'workspace') && workspace.has(left) && workspace.has(right)
}

function signature(binding: string, platform: 'apple' | 'other') {
  const parts = binding.split('+'), code = parts.pop()!
  const active = new Set(parts.map(part => part === 'Mod' ? platform === 'apple' ? 'Meta' : 'Ctrl' : part))
  return [...modifierOrder.filter(modifier => active.has(modifier)), code].join('+')
}

/** Compare the full effective set, including untouched defaults, on both
 * platforms. Mutually exclusive board/details/device surfaces may reuse a key. */
export function keyboardShortcutConflicts(bindings: KeyboardShortcutBindings): KeyboardShortcutConflict[] {
  const conflicts: KeyboardShortcutConflict[] = []
  for (const [index, left] of KEYBOARD_SHORTCUT_ACTIONS.entries()) {
    const a = bindings[left.action] ?? left.defaultBinding
    if (!a) continue
    for (const right of KEYBOARD_SHORTCUT_ACTIONS.slice(index + 1)) {
      const b = bindings[right.action] ?? right.defaultBinding
      if (!b || !overlap(left.context.scope, right.context.scope)) continue
      const platforms = (['apple', 'other'] as const).filter(platform => signature(a, platform) === signature(b, platform))
      if (platforms.length) conflicts.push({ actions: [left.action, right.action], bindings: [a, b], platforms })
    }
  }
  return conflicts
}
