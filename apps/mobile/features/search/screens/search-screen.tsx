import { useState } from 'react'
import { SectionList, StyleSheet, View } from 'react-native'
import { useRouter } from 'expo-router'
import { ChatRowView, rowKey, useChatRows, type ChatRow } from '@/components/ChatList'
import { NavBar, underBar } from '@/components/NavBar'
import { Text } from '@/components/Text'
import { ThreadRow } from '@/components/ThreadsScreen'
import { useHome } from '@/lib/home'
import { threadsLive } from '@/lib/live-keys'
import { botPath } from '@/lib/pins'
import type { Thread, Threads } from '@/lib/types'
import { useLiveApi } from '@/lib/useApi'
import { colors } from '@/lib/theme'
import { ListSectionHeader } from '@/shared/components/list-section'

type Section = { title: string; data: ({ kind: 'chat'; row: ChatRow } | { kind: 'thread'; thread: Thread })[] }

/**
 * 搜索, the tab bar's search tab (docs/design/mobile-comma-redesign.md, 20): the system search field above the
 * keyboard, and the Bots, group chats and threads whose names match, each kind in its own section. It reads only
 * what the chat list and 线程 already read.
 */
export function SearchScreen() {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const { rows } = useChatRows(needle)
  const home = useHome().data
  const threads = useLiveApi<Threads>(needle ? '/api/mobile/threads' : null, current => threadsLive(current, home?.live?.workspaceId))
  const sections: Section[] = needle ? [
    { title: 'Bot', data: rows.filter(row => row.kind === 'bot').map(row => ({ kind: 'chat' as const, row })) },
    { title: '群聊', data: rows.filter(row => row.kind === 'group').map(row => ({ kind: 'chat' as const, row })) },
    { title: '线程', data: (threads.data?.threads ?? []).filter(thread => thread.name.toLowerCase().includes(needle)).map(thread => ({ kind: 'thread' as const, thread })) },
  ].filter(section => section.data.length) : []
  return (
    <View style={styles.screen}>
      <NavBar title="搜索" large search={{ placeholder: 'Bot、群聊、线程', onChange: setQuery }} />
      <SectionList
        sections={sections}
        keyExtractor={item => item.kind === 'chat' ? rowKey(item.row) : item.thread.id}
        {...underBar}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        stickySectionHeadersEnabled={false}
        contentContainerStyle={{ paddingBottom: 24 }}
        ListEmptyComponent={needle ? <Text style={styles.none}>没有匹配的结果</Text> : undefined}
        renderSectionHeader={({ section }) => <ListSectionHeader title={section.title} count={section.data.length} />}
        renderItem={({ item }) => item.kind === 'chat'
          ? <ChatRowView row={item.row} onPress={() => router.push(item.row.kind === 'bot' ? botPath(item.row.bot) : `/groups/${item.row.group.id}`)} />
          : <ThreadRow thread={item.thread} />}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page },
  none: { paddingTop: 40, textAlign: 'center', fontSize: 15, color: colors.secondary },
})
