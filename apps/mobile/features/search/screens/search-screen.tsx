import { useState } from 'react'
import { SectionList, StyleSheet, View } from 'react-native'
import { useRouter } from 'expo-router'
import { ChatRowView, rowKey, useChatRows, type ChatRow } from '@/components/ChatList'
import { NavBar, underBar } from '@/components/NavBar'
import { Text } from '@/components/Text'
import { TaskRowView, useTasks } from '@/features/tasks/components/task-list'
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
  const { rows } = useChatRows(needle)
  const tasks = useTasks(Boolean(needle))
  const sections: Section[] = needle ? [
    { title: 'Bot', data: rows.filter(row => row.kind === 'bot').map(row => ({ kind: 'chat' as const, row })) },
    { title: '群聊', data: rows.filter(row => row.kind === 'group').map(row => ({ kind: 'chat' as const, row })) },
    { title: '任务', data: (tasks.data?.tasks ?? []).filter(task => `${task.identifier ?? ''} ${task.title}`.toLowerCase().includes(needle)).map(task => ({ kind: 'task' as const, task })) },
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
        ListEmptyComponent={needle ? <Text style={styles.none}>没有匹配的结果</Text> : undefined}
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
  none: { paddingTop: 40, textAlign: 'center', fontSize: 15, color: colors.secondary },
})
