import { Button, Divider, HStack, Host, Image, Menu, Section, Text } from '@expo/ui/swift-ui'
import { accessibilityLabel, buttonStyle, font, foregroundStyle, lineLimit } from '@expo/ui/swift-ui/modifiers'
import { StyleSheet } from 'react-native'
import { NavBar } from '@/components/NavBar'
import { Spinner } from '@/components/icons'
import { tap } from '@/lib/haptics'
import { colors } from '@/lib/theme'
import { taskSymbol } from '@/features/chat/model/chat-header-menu'
import { displayTitle } from '@/lib/display-title'
import type { ChatHeaderProps } from './chat-header.types'

/**
 * The chat's bar on iOS: the bot's name is the title and a system pull-down menu, as in Messages' contact title.
 * The menu lists the bot's open tasks, then 「全部任务」, then 「资料」. Back and its edge swipe are the system's.
 */
export function ChatHeader({ name, tasks, onTask, onAllTasks, onInfo }: ChatHeaderProps) {
  const title = name ? (
    // A fixed frame rather than matchContents: the chat showed no name on device (Alex 2026-11-08), and a Host sized
    // by its SwiftUI content can be laid out at zero size in the bar. The name centres in the frame and truncates.
    <Host style={styles.title}>
      <Menu label={<HStack spacing={4}><Text modifiers={[font({ size: 17, weight: 'semibold' }), lineLimit(1), foregroundStyle(colors.ink)]}>{name}</Text><Image systemName="chevron.down" size={11} color={colors.secondary} /></HStack>}
        modifiers={[buttonStyle('plain'), accessibilityLabel(name)]}>
        {tasks?.length ? (
          <Section title="任务">
            {tasks.map(task => <Button key={task.id} label={displayTitle(task.title)} systemImage={taskSymbol(task)} onPress={() => { tap(); onTask(task.id) }} />)}
          </Section>
        ) : null}
        <Button label="全部任务" systemImage="checklist" onPress={() => { tap(); onAllTasks() }} />
        <Divider />
        <Button label="资料" systemImage="person.crop.circle" onPress={() => { tap(); onInfo() }} />
      </Menu>
    </Host>
  ) : <Spinner size={14} />
  return <NavBar title={name ?? ''} titleView={title} />
}

const styles = StyleSheet.create({
  title: { width: 220, height: 44 },
})
