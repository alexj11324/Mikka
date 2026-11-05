import type { ReactElement } from 'react'
import { Pressable } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { Link, useRouter } from 'expo-router'
import { tap } from '@/lib/haptics'
import { holdMessage, REACTIONS, type HeldMessage } from '@/lib/message-actions'

/** iOS draws a message's long press as the system context menu (UIContextMenu, through Expo Router's Link.Menu). */
export const NATIVE_MESSAGE_MENU = true

/**
 * A long press on a message lifts it and opens the system context menu, as in Messages (expo-router skill: context
 * menus are `Link.Menu`, never rebuilt in JS). The native menu attaches to the bubble's own React Native view
 * (`display: contents`), so nothing is hosted in SwiftUI and the list keeps its layout. The reactions are one
 * palette row, UIKit's own horizontal menu section; then 回复, 复制 and 选择文本. A tap does nothing: the link
 * navigates nowhere (`preventDefault`), and the bubble's own links and chips keep their taps.
 */
export function MessageMenu({ message, children }: { message?: HeldMessage; children: ReactElement }) {
  const router = useRouter()
  if (!message) return children
  const react = message.react
  return (
    <Link href="/message" asChild onPress={event => event.preventDefault()}>
      <Link.Trigger>
        <Pressable accessible={false}>{children}</Pressable>
      </Link.Trigger>
      <Link.Menu>
        {react ? (
          <Link.Menu title="回应" palette inline>
            {REACTIONS.map(emoji => (
              <Link.MenuAction key={emoji} isOn={react.current === emoji} onPress={() => { tap(); react.set(react.current === emoji ? null : emoji) }}>{emoji}</Link.MenuAction>
            ))}
          </Link.Menu>
        ) : null}
        <Link.MenuAction icon="arrowshape.turn.up.left" onPress={message.onQuote}>回复</Link.MenuAction>
        <Link.MenuAction icon="doc.on.doc" onPress={() => { void Clipboard.setStringAsync(message.text); tap() }}>复制</Link.MenuAction>
        <Link.MenuAction icon="character.cursor.ibeam" onPress={() => { holdMessage(message); router.push('/message-text') }}>选择文本</Link.MenuAction>
      </Link.Menu>
    </Link>
  )
}
