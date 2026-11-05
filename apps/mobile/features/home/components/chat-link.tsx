import type { ReactElement } from 'react'
import { Platform, Pressable, type PressableProps } from 'react-native'
import { Link, useRouter } from 'expo-router'
import type { HomeChat, useHomeChats } from '../model/use-home-chats'
import { chatMenu } from './chat-menu'
import { chatHref } from './chat-href'

type Actions = ReturnType<typeof useHomeChats>

/**
 * A home chat's press: on iOS a Link with the system transition, the live preview and the context menu. The web
 * build, used for screenshots, has neither, and a browser drags a link's anchor itself, which would swallow the
 * row's swipe and drag; there the row is a plain button that opens the chat.
 */
export function ChatLink({ chat, actions, ignore, children, ...pressable }: { chat: HomeChat; actions: Actions; ignore?: () => boolean; children: ReactElement } & Omit<PressableProps, 'children' | 'onPress'>) {
  const router = useRouter()
  const opened = () => { if (chat.markedUnread) void actions.setUnread(chat, false) }
  if (Platform.OS === 'web') {
    return <Pressable accessibilityRole="button" {...pressable} onPress={() => { if (ignore?.()) return; opened(); router.push(chatHref(chat)) }}>{children}</Pressable>
  }
  return (
    <Link href={chatHref(chat)} asChild onPress={opened}>
      <Link.Trigger>
        <Pressable accessibilityRole="button" {...pressable}>{children}</Pressable>
      </Link.Trigger>
      <Link.Preview />
      {chatMenu(chat, actions, router)}
    </Link>
  )
}
