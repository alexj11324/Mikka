import { StyleSheet } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { Button, ControlGroup, Host, Image, Menu, Text, Toggle } from '@expo/ui/swift-ui'
import { accessibilityLabel, buttonStyle } from '@expo/ui/swift-ui/modifiers'
import { tap } from '@/lib/haptics'
import { REACTIONS, type HeldMessage } from '@/lib/message-actions'
import { colors } from '@/lib/theme'

/**
 * ⋯ under a message (Alex 2026-11-08) as the system pull-down menu: the reactions first, as two compact rows of three,
 * then 回复 (quotes it in the composer), 复制 and 选择文本. A long press no longer opens anything but the selection.
 * The Host has a fixed frame: one sized by its SwiftUI content can be laid out at zero size (chat-header.ios.tsx).
 */
export function MessageMenu({ message }: { message: HeldMessage }) {
  const react = message.react
  const reaction = (emoji: string) => (
    <Toggle key={emoji} isOn={react?.current === emoji} onIsOnChange={() => { tap(); react?.set(react.current === emoji ? null : emoji) }}>
      <Text>{emoji}</Text>
    </Toggle>
  )
  return (
    <Host style={styles.button}>
      <Menu label={<Image systemName="ellipsis" size={14} color={colors.secondary} />} modifiers={[buttonStyle('plain'), accessibilityLabel('更多')]}>
        {react ? <ControlGroup>{REACTIONS.slice(0, 3).map(reaction)}</ControlGroup> : null}
        {react ? <ControlGroup>{REACTIONS.slice(3).map(reaction)}</ControlGroup> : null}
        <Button label="回复" systemImage="arrowshape.turn.up.left" onPress={() => { tap(); message.onQuote() }} />
        <Button label="复制" systemImage="doc.on.doc" onPress={() => { void Clipboard.setStringAsync(message.text); tap() }} />
        {message.onSelect ? <Button label="选择文本" systemImage="character.cursor.ibeam" onPress={() => message.onSelect?.()} /> : null}
      </Menu>
    </Host>
  )
}

const styles = StyleSheet.create({
  button: { width: 32, height: 32 },
})
