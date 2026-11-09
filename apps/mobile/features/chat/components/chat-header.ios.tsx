import { mobileMessages } from '@/lib/messages'
import { NavBar } from '@/components/NavBar'
import { Symbol } from '@/components/Symbol'
import { tap } from '@/lib/haptics'
import { colors } from '@/lib/theme'
import { displayTitle } from '@/lib/display-title'
import { taskSymbol } from '@/features/chat/model/chat-header-menu'
import { ChatTitlePill } from './chat-title-pill'
import type { ChatHeaderProps } from './chat-header.types'

/**
 * The chat's bar on iOS (Alex 2026-11-08, after Grok): one centred title, the bot's avatar and name in a glass pill
 * that opens its page, and ⋯ on the right as a system bar button (a glass circle on iOS 26) with the bot's open
 * tasks, 全部任务 and 资料. Back and its edge swipe are the system's (decision 0120: one title, buttons on the right).
 */
export function ChatHeader({ name, color, shape, botId, coordinator, tasks, onTask, onAllTasks, onInfo, scrolled }: ChatHeaderProps) {
  return (
    <NavBar title={name} scrolled={scrolled} titleView={<ChatTitlePill name={name} color={color} shape={shape} botId={botId} coordinator={coordinator} onPress={onInfo} />}
      right={name ? {
        icon: 'ellipsis', label: mobileMessages.Nav.more, web: <Symbol name="ellipsis" size={18} color={colors.ink} />, onOpen: () => {},
        items: [
          ...(tasks ?? []).map(task => ({ label: displayTitle(task.title), icon: taskSymbol(task), onPress: () => { tap(); onTask(task.id) } })),
          { label: mobileMessages.MobileCore.allTasks, icon: 'checklist', onPress: () => { tap(); onAllTasks() } },
          { label: mobileMessages.MobileCore.info, icon: 'person.crop.circle', onPress: () => { tap(); onInfo() } },
        ],
      } : undefined} />
  )
}
