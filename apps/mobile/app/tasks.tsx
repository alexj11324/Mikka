import { View } from 'react-native'
import { NavBar } from '@/components/NavBar'
import { TaskList } from '@/features/tasks/components/task-list'
import { colors } from '@/lib/theme'

/** 任务 on its own page, opened from a chat's task card; the 线程 tab shows the same list under its 任务 segment. */
export default function TasksScreen() {
  return (
    <View style={{ flex: 1, backgroundColor: colors.page }}>
      <NavBar title="任务" large />
      <TaskList />
    </View>
  )
}
