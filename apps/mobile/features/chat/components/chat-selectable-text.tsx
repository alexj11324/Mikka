import { useEffect, useRef } from 'react'
import { Platform, StyleSheet, TextInput, type TextInputInstance } from 'react-native'
import { selectedPart, type Rect } from '@/features/chat/model/chat-selection'
import { colors, font } from '@/lib/theme'

/**
 * A message's words while the person selects part of them (选择文本): a read-only field that reports the selected
 * part, because React Native's Text cannot say what is selected. It opens with everything selected and no keyboard,
 * in the chat's text size. `onRect` reports where it sits on screen, so a tap elsewhere can end the selection.
 */
export function ChatSelectableText({ text, color = colors.text, onSelect, onRect }: { text: string; color?: string; onSelect: (selected: string) => void; onRect: (rect: Rect) => void }) {
  const field = useRef<TextInputInstance>(null)
  const measured = useRef(false)
  useEffect(() => { onSelect(text) }, [onSelect, text])
  const measure = () => field.current?.measureInWindow((x, y, width, height) => onRect({ x, y, width, height }))
  return (
    <TextInput ref={field} accessibilityLabel="选择文本" value={text} onChangeText={() => {}} multiline scrollEnabled={false}
      showSoftInputOnFocus={false} caretHidden autoFocus selectTextOnFocus contextMenuHidden={false}
      onLayout={() => {
        measure()
        if (!measured.current) { measured.current = true; field.current?.setSelection(0, text.length) }
      }}
      onSelectionChange={event => { const { start, end } = event.nativeEvent.selection; onSelect(selectedPart(text, start, end)); measure() }}
      style={[styles.text, { color }]} />
  )
}

const styles = StyleSheet.create({
  // The chat body: 16 on a 22 line (DESIGN.md § Text), no padding of its own inside the bubble.
  text: { fontFamily: font, fontSize: 16, lineHeight: 22, padding: 0, margin: 0, textAlignVertical: 'top', ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) } as never,
})
