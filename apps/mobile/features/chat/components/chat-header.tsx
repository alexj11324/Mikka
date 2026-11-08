import { Ellipsis } from 'lucide-react-native'
import { NavBar } from '@/components/NavBar'
import { colors } from '@/lib/theme'
import { taskSymbol } from '@/features/chat/model/chat-header-menu'
import { displayTitle } from '@/lib/display-title'
import { ChatTitlePill } from './chat-title-pill'
import type { ChatHeaderProps } from './chat-header.types'

/** The chat's bar on the web build: the same glass title pill and ⋯ menu as iOS (chat-header.ios.tsx), drawn in RN. */
export function ChatHeader({ name, color, shape, botId, coordinator, tasks, onTask, onAllTasks, onInfo }: ChatHeaderProps) {
  return (
    <NavBar titleView={<ChatTitlePill name={name} color={color} shape={shape} botId={botId} coordinator={coordinator} onPress={onInfo} />}
      right={name ? {
        icon: 'ellipsis', label: '更多', web: <Ellipsis size={20} color={colors.ink} />, onOpen: () => {},
        items: [
          ...(tasks ?? []).map(task => ({ label: displayTitle(task.title), icon: taskSymbol(task), onPress: () => onTask(task.id) })),
          { label: '全部任务', icon: 'checklist', onPress: onAllTasks },
          { label: '资料', icon: 'person.crop.circle', onPress: onInfo },
        ],
      } : undefined} />
  )
}
