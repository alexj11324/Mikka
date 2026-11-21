import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { db } from '@/lib/db'
import { ownerKeyboardShortcutsChanged } from '@/lib/live/lists'
import type { SettingValue } from '@mikka/protocol/settings'
import { KEYBOARD_SHORTCUT_ACTIONS, keyboardShortcutConflicts, keyboardShortcutSettingKey, type KeyboardShortcutBindings } from '@mikka/protocol/keyboard-shortcuts'
import { keyboardShortcuts, personalSettingValues } from './schema'
import { KeyboardShortcutConflictError } from './shortcut-conflict'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
const activeActions = new Map<string, typeof KEYBOARD_SHORTCUT_ACTIONS[number]['action']>(
  KEYBOARD_SHORTCUT_ACTIONS.map(({ action }) => [keyboardShortcutSettingKey(action), action]))

/** Called after the existing user row lock. Checking defaults, saved overrides
 * and the whole patch together permits an atomic swap and serializes races. */
export async function validateAndMirrorKeyboardShortcuts(tx: Transaction, userId: string, values: Record<string, SettingValue | null>): Promise<void> {
  const entries = Object.entries(values).flatMap(([key, value]) => {
    const action = activeActions.get(key)
    return action && (value === null || typeof value === 'string') ? [{ action, binding: value }] : []
  })
  if (!entries.length) return
  const saved = await tx.select({ key: personalSettingValues.key, binding: personalSettingValues.textValue }).from(personalSettingValues)
    .where(and(eq(personalSettingValues.userId, userId), isNull(personalSettingValues.workspaceId),
      inArray(personalSettingValues.key, [...activeActions.keys()])))
  const bindings: KeyboardShortcutBindings = {}
  for (const row of saved) {
    const action = activeActions.get(row.key)
    if (action) bindings[action] = row.binding
  }
  for (const { action, binding } of entries) bindings[action] = binding
  const conflicts = keyboardShortcutConflicts(bindings)
  if (conflicts.length) throw new KeyboardShortcutConflictError(conflicts)
  for (const { action, binding } of entries) await tx.insert(keyboardShortcuts).values({ userId, actionId: action, binding })
    .onConflictDoUpdate({ target: [keyboardShortcuts.userId, keyboardShortcuts.actionId], set: { binding, updatedAt: new Date() } })
  await ownerKeyboardShortcutsChanged(tx, userId)
}
