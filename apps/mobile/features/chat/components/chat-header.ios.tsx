import { Button, Divider, HStack, Host, Image, Menu, Section, Text } from '@expo/ui/swift-ui'
import { buttonStyle, font, foregroundStyle, lineLimit } from '@expo/ui/swift-ui/modifiers'
import { NavBar } from '@/components/NavBar'
import { Spinner } from '@/components/icons'
import { tap } from '@/lib/haptics'
import { colors } from '@/lib/theme'
import { THREAD_SYMBOL } from '@/features/chat/model/chat-header-menu'
import type { ChatHeaderProps } from './chat-header.types'

/**
 * The chat's bar on iOS: the bot's name is the title and a system pull-down menu, as in Messages' contact title.
 * The menu lists the bot's open threads, then 「全部线程」, then 「资料」. Back and its edge swipe are the system's.
 */
export function ChatHeader({ name, threads, onThread, onAllThreads, onInfo }: ChatHeaderProps) {
  const title = name ? (
    <Host matchContents>
      <Menu label={<HStack spacing={4}><Text modifiers={[font({ size: 17, weight: 'semibold' }), lineLimit(1), foregroundStyle(colors.ink)]}>{name}</Text><Image systemName="chevron.down" size={11} color={colors.secondary} /></HStack>}
        modifiers={[buttonStyle('plain')]}>
        {threads?.length ? (
          <Section title="线程">
            {threads.map(thread => <Button key={thread.id} label={thread.name} systemImage={THREAD_SYMBOL[thread.status]} onPress={() => { tap(); onThread(thread.id) }} />)}
          </Section>
        ) : null}
        <Button label="全部线程" systemImage="checklist" onPress={() => { tap(); onAllThreads() }} />
        <Divider />
        <Button label="资料" systemImage="person.crop.circle" onPress={() => { tap(); onInfo() }} />
      </Menu>
    </Host>
  ) : <Spinner size={14} />
  return <NavBar material titleView={title} />
}
