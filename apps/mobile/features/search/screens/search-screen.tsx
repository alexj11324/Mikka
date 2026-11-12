import { useState } from 'react'
import { SectionList, StyleSheet, View } from 'react-native'
import { useRouter } from 'expo-router'
import { ChatRowView, rowKey, useChatRows, type ChatRow } from '@/components/ChatList'
import { NavBar, underBar } from '@/components/NavBar'
import { ReadNotice } from '@/components/ReadNotice'
import { Spinner } from '@/components/icons'
import { mobileMessages } from '@/lib/messages'
import { Text } from '@/components/Text'
import { TaskListContinuation, TaskRowView, useTasks } from '@/features/tasks/components/task-list'
import { botPath } from '@/lib/pins'
import type { Task } from '@/lib/types'
import { colors } from '@/lib/theme'
import { ListSectionHeader } from '@/shared/components/list-section'

type Section = { title: string; data: ({ kind: 'chat'; row: ChatRow } | { kind: 'task'; task: Task })[] }

/**
 * 搜索, the tab bar's search tab (docs/design/mobile-comma-redesign.md, 20): the system search field above the
 * keyboard, and the Bots, group chats and tasks whose names match, each kind in its own section. Threads are never
 * results of their own: a thread's name is its task's title, so a thread shows as its task (2026-11-07). It reads
 * only what the chat list and 任务 already read.
 */
export function SearchScreen() {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const chats = useChatRows(needle)
  const tasks = useTasks(Boolean(needle))
  const loading = chats.loading || tasks.loading
  const complete = !loading && !chats.error && !tasks.error && !tasks.paging.hasMore
  const sections: Section[] = needle ? [
    { title: 'Bot', data: chats.rows.filter(row => row.kind === 'bot').map(row => ({ kind: 'chat' as const, row })) },
    { title: '群聊', data: chats.rows.filter(row => row.kind === 'group').map(row => ({ kind: 'chat' as const, row })) },
    { title: '任务', data: tasks.paging.items.filter(task => `${task.identifier ?? ''} ${task.title}`.toLowerCase().includes(needle)).map(task => ({ kind: 'task' as const, task })) },
  ].filter(section => section.data.length) : []
  return (
    <View style={styles.screen}>
      <NavBar title="搜索" topTitle search={{ placeholder: 'Bot、群聊、任务', onChange: setQuery }} />
      <SectionList
        sections={sections}
        keyExtractor={item => item.kind === 'chat' ? rowKey(item.row) : item.task.id}
        {...underBar}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        stickySectionHeadersEnabled={false}
        contentContainerStyle={{ paddingBottom: 24 }}
        ListHeaderComponent={needle ? <>
          <ReadNotice error={chats.error} hasData={chats.rows.length > 0} label={mobileMessages.MobileCore.chatList} onRetry={chats.reload} />
          <ReadNotice error={tasks.error} hasData={Boolean(tasks.data)} label={mobileMessages.Nav.tasks} onRetry={tasks.reload} />
        </> : undefined}
        ListFooterComponent={needle ? <TaskListContinuation paging={tasks.paging} /> : undefined}
        ListEmptyComponent={!needle ? undefined : loading ? <View style={styles.loading}><Spinner /></View>
          : complete ? <Text style={styles.none}>{mobileMessages.Shell.searchEmpty}</Text> : undefined}
        renderSectionHeader={({ section }) => <ListSectionHeader title={section.title} count={section.data.length} />}
        renderItem={({ item }) => item.kind === 'chat'
          ? <ChatRowView row={item.row} onPress={() => router.push(item.row.kind === 'bot' ? botPath(item.row.bot) : `/groups/${item.row.group.id}`)} />
          : <TaskRowView task={item.task} />}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page },
  loading: { paddingTop: 40, alignItems: 'center' },
  none: { paddingTop: 40, textAlign: 'center', fontSize: 15, color: colors.secondary },
})
