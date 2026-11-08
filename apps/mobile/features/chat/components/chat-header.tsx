import { StyleSheet, View } from 'react-native'
import { ChevronDown } from 'lucide-react-native'
import { NavBar } from '@/components/NavBar'
import { WebBarMenu } from '@/components/WebBarMenu'
import { Spinner } from '@/components/icons'
import { Text } from '@/components/Text'
import { colors } from '@/lib/theme'
import { taskSymbol } from '@/features/chat/model/chat-header-menu'
import { displayTitle } from '@/lib/display-title'
import type { ChatHeaderProps } from './chat-header.types'

/** The chat's bar on the web build: the same title menu as iOS (chat-header.ios.tsx), drawn as a panel. */
export function ChatHeader({ name, tasks, onTask, onAllTasks, onInfo }: ChatHeaderProps) {
  const title = name ? (
    <WebBarMenu plain item={{
      icon: 'chevron.down', label: name, onOpen: () => {},
      web: <View style={styles.title}><Text style={styles.name} numberOfLines={1}>{name}</Text><ChevronDown size={14} color={colors.secondary} strokeWidth={2.4} /></View>,
      items: [
        ...(tasks ?? []).map(task => ({ label: displayTitle(task.title), icon: taskSymbol(task), onPress: () => onTask(task.id) })),
        { label: '全部任务', icon: 'checklist', onPress: onAllTasks },
        { label: '资料', icon: 'person.crop.circle', onPress: onInfo },
      ],
    }} />
  ) : <Spinner size={14} />
  return <NavBar material titleView={title} />
}

const styles = StyleSheet.create({
  title: { flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: 240 },
  name: { fontSize: 17, fontWeight: '600', flexShrink: 1 },
})
