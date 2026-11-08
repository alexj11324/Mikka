import { useRef, type ComponentRef } from 'react'
import { StyleSheet, View, type NativeSyntheticEvent } from 'react-native'
import { requireNativeView, requireOptionalNativeModule } from 'expo'
import { Text } from '@/components/Text'
import type { Rect } from '@/features/chat/model/chat-selection'
import { colors } from '@/lib/theme'

type Selected = NativeSyntheticEvent<{ text: string }>
type NativeProps = { text: string; color: string; fontSize: number; lineHeight: number; actionTitle: string; style?: object
  onAddToChat: (event: Selected) => void; onSelectionChange: (event: Selected) => void }

/** The module is in binaries built from this commit on; an older binary keeps the capsule (chat-selection-bar). */
const available = requireOptionalNativeModule('MikkaSelectableText') !== null
const Native = available ? requireNativeView<NativeProps>('MikkaSelectableText') : null

/** 添加到对话 is in the system edit menu, so the capsule above the composer is not drawn. */
export const NATIVE_ADD_TO_CHAT = available

/**
 * A message's words while the person selects part of them, on iOS: a read-only UITextView (modules/selectable-text)
 * whose system edit menu leads with 添加到对话. It opens with everything selected and the menu up. An invisible
 * Text of the same words, at the chat's size, gives the box its size; the native view fills it.
 */
export function NativeSelectableText({ text, color = colors.text, onSelect, onAddToChat, onRect }: {
  text: string; color?: string; onSelect: (selected: string) => void; onAddToChat: (selected: string) => void; onRect: (rect: Rect) => void
}) {
  const box = useRef<ComponentRef<typeof View>>(null)
  if (!Native) return null
  return (
    <View ref={box} onLayout={() => box.current?.measureInWindow((x, y, width, height) => onRect({ x, y, width, height }))}>
      <Text style={[styles.text, { opacity: 0 }]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">{text}</Text>
      <Native style={StyleSheet.absoluteFill} text={text} color={color} fontSize={styles.text.fontSize} lineHeight={styles.text.lineHeight} actionTitle="添加到对话"
        onSelectionChange={event => onSelect(event.nativeEvent.text || text)} onAddToChat={event => onAddToChat(event.nativeEvent.text || text)} />
    </View>
  )
}

const styles = StyleSheet.create({
  // The chat body: 16 on a 22 line, as ChatSelectableText.
  text: { fontSize: 16, lineHeight: 22 },
})
