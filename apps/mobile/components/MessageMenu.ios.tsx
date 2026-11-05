import type { ReactElement } from 'react'
import { View } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { useRouter } from 'expo-router'
import { Button, ContextMenu, ControlGroup, Host, RNHostView, Toggle, Text } from '@expo/ui/swift-ui'
import { tap } from '@/lib/haptics'
import { holdMessage, REACTIONS, type HeldMessage } from '@/lib/message-actions'

/** iOS draws a message's long press as the system context menu (UIContextMenu via SwiftUI). */
export const NATIVE_MESSAGE_MENU = true

/**
 * A long press on a message lifts it and opens the system context menu, as in Messages (#1386, native first):
 * the reactions first, as two compact rows of three (iOS has no reaction bar on a context menu; this is the closest
 * system layout), then 回复, 复制 and 选择文本. The bubble is hosted inside SwiftUI so the system lifts the real
 * view; its swipe to quote still runs on the React Native side.
 */
export function MessageMenu({ message, children }: { message?: HeldMessage; children: ReactElement }) {
  const router = useRouter()
  if (!message) return children
  const react = message.react
  const reaction = (emoji: string) => (
    <Toggle key={emoji} isOn={react?.current === emoji} onIsOnChange={() => { tap(); react?.set(react.current === emoji ? null : emoji) }}>
      <Text>{emoji}</Text>
    </Toggle>
  )
  return (
    <Host matchContents={{ vertical: true }} style={{ alignSelf: 'stretch' }}>
      <ContextMenu>
        <ContextMenu.Trigger>
          <RNHostView matchContents={{ vertical: true }}><View>{children}</View></RNHostView>
        </ContextMenu.Trigger>
        <ContextMenu.Items>
          {react ? <ControlGroup>{REACTIONS.slice(0, 3).map(reaction)}</ControlGroup> : null}
          {react ? <ControlGroup>{REACTIONS.slice(3).map(reaction)}</ControlGroup> : null}
          <Button label="回复" systemImage="arrowshape.turn.up.left" onPress={message.onQuote} />
          <Button label="复制" systemImage="doc.on.doc" onPress={() => { void Clipboard.setStringAsync(message.text); tap() }} />
          <Button label="选择文本" systemImage="character.cursor.ibeam" onPress={() => { holdMessage(message); router.push('/message-text') }} />
        </ContextMenu.Items>
      </ContextMenu>
    </Host>
  )
}
