import type { ReactElement } from 'react'
import { Platform, Pressable, type PressableProps } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { Link, useRouter } from 'expo-router'
import { api } from '@/lib/api'
import { press, tap } from '@/lib/haptics'
import type { Thread } from '@/lib/types'

/**
 * A thread row's press: on iOS a Link with the system transition, a live preview of the thread on a long press and
 * its menu: 停止 while it runs, and 复制 ID. Mikka has no rename or delete for a thread, so the menu has neither. The
 * web build draws a plain button.
 */
export function ThreadLink({ thread, onStopped, children, ...pressable }: { thread: Thread; onStopped?: () => void; children: ReactElement } & Omit<PressableProps, 'children' | 'onPress'>) {
  const router = useRouter()
  const href = `/thread/${thread.id}` as const
  if (Platform.OS === 'web') return <Pressable accessibilityRole="button" {...pressable} onPress={() => router.push(href)}>{children}</Pressable>
  const stop = () => { press(); void api(`/api/mobile/threads/${thread.id}/stop`, { method: 'POST' }).then(onStopped, () => undefined) }
  return (
    <Link href={href} asChild>
      <Link.Trigger>
        <Pressable accessibilityRole="button" {...pressable}>{children}</Pressable>
      </Link.Trigger>
      <Link.Preview />
      <Link.Menu>
        {thread.status === 'running' ? <Link.MenuAction icon="stop.circle" destructive onPress={stop}>停止</Link.MenuAction> : null}
        <Link.MenuAction icon="doc.on.doc" onPress={() => { void Clipboard.setStringAsync(thread.id); tap() }}>复制 ID</Link.MenuAction>
      </Link.Menu>
    </Link>
  )
}
