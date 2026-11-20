import { eq } from 'drizzle-orm'
import type { db } from '@/lib/db'
import type { SettingValue } from '@mikka/protocol/settings'
import { KEYBOARD_SHORTCUT_ACTIONS, keyboardShortcutConflicts, keyboardShortcutSettingKey, type KeyboardShortcutBindings } from '@mikka/protocol/keyboard-shortcuts'
import { settingDefinition } from './registry'
import { keyboardShortcuts } from './schema'
import { KeyboardShortcutConflictError } from './shortcut-conflict'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** Called after the existing user row lock. Checking defaults, saved overrides
 * and the whole patch together permits an atomic swap and serializes races. */
export async function writeKeyboardShortcuts(tx: Transaction, userId: string, values: Record<string, SettingValue | null>): Promise<void> {
  const entries = Object.entries(values).flatMap(([key, value]) => {
    const field = settingDefinition(key)
    return field.action ? [{ action: field.action, binding: value === null ? null : field.guard.parse(value) as string }] : []
  })
  if (!entries.length) return
  const saved = await tx.select().from(keyboardShortcuts).where(eq(keyboardShortcuts.userId, userId))
  const bindings: KeyboardShortcutBindings = {}
  for (const row of saved) {
    // Retired actions remain stored for rollback but do not claim an active key.
    const action = KEYBOARD_SHORTCUT_ACTIONS.find(value => value.action === row.actionId)
    if (!action) continue
    const field = settingDefinition(keyboardShortcutSettingKey(action.action))
    if (field.action) bindings[field.action] = row.binding === null ? null : field.guard.parse(row.binding) as string
  }
  for (const { action, binding } of entries) bindings[action] = binding
  const conflicts = keyboardShortcutConflicts(bindings)
  if (conflicts.length) throw new KeyboardShortcutConflictError(conflicts)
  for (const { action, binding } of entries) await tx.insert(keyboardShortcuts).values({ userId, actionId: action, binding })
    .onConflictDoUpdate({ target: [keyboardShortcuts.userId, keyboardShortcuts.actionId], set: { binding, updatedAt: new Date() } })
}
