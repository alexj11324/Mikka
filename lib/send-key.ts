// The chat composer's send key (偏好设置, 发送消息快捷键), stored in
// user_preferences."sendKey". Kept free of server imports: the composer uses it.

export const SEND_KEYS = ['enter', 'modEnter'] as const
export type SendKey = (typeof SEND_KEYS)[number]

/** The parts of a keydown the composer looks at. */
export interface ComposerKey {
  key: string
  shiftKey: boolean
  metaKey: boolean
  ctrlKey: boolean
  isComposing: boolean
}

/**
 * Whether a keydown in the chat composer sends. 'enter': Enter sends,
 * Shift+Enter breaks the line. 'modEnter': ⌘/Ctrl+Enter sends, Enter breaks
 * the line. Never while an IME is composing.
 */
export function sendsMessage(event: ComposerKey, sendKey: SendKey = 'enter'): boolean {
  if (event.key !== 'Enter' || event.isComposing || event.shiftKey) return false
  return sendKey === 'enter' || event.metaKey || event.ctrlKey
}
