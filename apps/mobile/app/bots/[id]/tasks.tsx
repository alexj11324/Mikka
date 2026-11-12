import { StyleSheet, View } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { NavBar } from '@/components/NavBar'
import { TaskList } from '@/features/tasks/components/task-list'
import { useHome } from '@/lib/home'
import { colors } from '@/lib/theme'

/** One bot's tasks, pushed over its chat (back returns to it); its threads are inside each task (2026-11-07). */
export default function BotTasks() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const bots = useHome().data?.bots
  // The Coordinator's page is addressed as `coordinator`; its tasks carry its bot row's id.
  const bot = id === 'coordinator' ? bots?.find(item => item.coordinator) : bots?.find(item => item.id === id)
  return (
    <View style={styles.screen}>
      <NavBar title={`${id === 'coordinator' ? 'Coordinator' : bot?.name ?? ''} 的任务`} />
      <TaskList bot={bot?.id ?? null} />
    </View>
  )
}

const styles = StyleSheet.create({ screen: { flex: 1, backgroundColor: colors.page } })
