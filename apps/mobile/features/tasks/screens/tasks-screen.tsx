import { mobileMessages } from '@/lib/messages'
import { useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { ListFilter, Plus } from 'lucide-react-native'
import { NavBar } from '@/components/NavBar'
import { openChat } from '@/lib/navigate'
import { colors } from '@/lib/theme'
import { TaskList } from '../components/task-list'
import { TASK_GROUPS, type TaskFilter } from '../model/task-groups'

/**
 * The 任务 tab (decisions/2026-11-07-2045-tasks-only-threads-inside.md, Figma 1085:2 M1): the title 任务 in the top row with +
 * and the filter on the right, then the tasks by group. + opens the Coordinator's composer, which dispatches a task.
 */
export function TasksScreen() {
  const [filter, setFilter] = useState<TaskFilter>('all')
  return (
    <View style={styles.screen}>
      <NavBar
        title={mobileMessages.Nav.tasks}
        topTitle
        right={[
          { icon: 'line.3.horizontal.decrease', label: mobileMessages.MobileCore.filter, web: <ListFilter size={20} color={colors.ink} strokeWidth={2} />, onOpen: () => {},
            items: [{ id: 'all' as const, title: mobileMessages.MobileCore.all }, ...TASK_GROUPS].map(group => ({ label: group.title, on: filter === group.id, onPress: () => setFilter(group.id) })) },
          { icon: 'plus', label: mobileMessages.Nav.newTask, web: <Plus size={22} color={colors.ink} strokeWidth={2} />, onPress: () => openChat({ pathname: '/bots/[id]', params: { id: 'coordinator', compose: '1',taskRequest:'1' } }) },
        ]}
      />
      <TaskList filter={filter} />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page },
})
