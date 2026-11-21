import type { KeyboardShortcutConflict } from '@mikka/protocol/keyboard-shortcuts'

/** A safe business refusal; the response contains action IDs and key names only. */
export class KeyboardShortcutConflictError extends Error {
  readonly code = 'keyboardShortcutConflict' as const
  constructor(readonly conflicts: KeyboardShortcutConflict[]) {
    super('keyboardShortcutConflict')
    this.name = 'KeyboardShortcutConflictError'
  }
}
