import type { Rect } from '@/features/chat/model/chat-selection'

/** Only iOS has the native edit menu (native-selectable-text.ios.tsx); elsewhere 添加到对话 is a capsule. */
export const NATIVE_ADD_TO_CHAT = false

export function NativeSelectableText(_: { text: string; color?: string; onSelect: (selected: string) => void; onAddToChat: (selected: string) => void; onRect: (rect: Rect) => void }) {
  return null
}
