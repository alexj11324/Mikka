import { useEffect, useRef } from 'react'
import { ScrollView, StyleSheet, View, type ScrollViewInstance } from 'react-native'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ListChecks } from 'lucide-react-native'
import { useDrawer } from '@/components/Drawer'
import { BotAvatar, MenuIcon } from '@/components/icons'
import { BotBubble, DateLabel, MyBubble, ProactiveCard, Rich, ThreadCard, TimedRow, useTimeReveal, type Message, type Part } from '@/components/chat'
import { Text } from '@/components/Text'
import { Composer, Header, RoundButton } from '@/components/ui'
import type { Bot } from '@/lib/mock'
import { colors, lift } from '@/lib/theme'

/**
 * A chat with a bot (the Coordinator is one, R-06): the bot's name in a pill,
 * its threads behind the right button, the composer at the bottom.
 */
export function ChatScreen({ bot, messages, onAction, onSend, waiting }: {
  bot: Bot
  messages: Message[]
  onAction?: (messageId: string, action: string) => void
  onSend?: (text: string) => void
  waiting?: boolean
}) {
  const drawer = useDrawer()
  const router = useRouter()
  const scroll = useRef<ScrollViewInstance>(null)
  const insets = useSafeAreaInsets()
  const { offset, handlers } = useTimeReveal()
  const openMention = (part: Exclude<Part, string>) => { if (part.href) router.push(part.href as never) }

  useEffect(() => {
    const timer = setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 60)
    return () => clearTimeout(timer)
  }, [messages.length])

  return (
    <View style={styles.screen}>
      <Header
        style={styles.header}
        left={<RoundButton label="菜单" onPress={drawer.open}><MenuIcon /></RoundButton>}
        title={
          <View style={styles.pill}>
            <BotAvatar look={bot.look} size={22} />
            <Text style={styles.pillText} numberOfLines={1}>{bot.name}</Text>
          </View>
        }
        right={<RoundButton label="线程" dot={waiting} onPress={() => router.push('/threads')}><ListChecks size={21} color={colors.ink} strokeWidth={2} /></RoundButton>}
      />
      <View style={{ flex: 1, overflow: 'hidden' }} {...handlers}>
        <ScrollView ref={scroll} contentContainerStyle={[styles.list, { paddingTop: insets.top + 76 }]} onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}>
          {messages.map(message => {
            switch (message.kind) {
              case 'label': return <DateLabel key={message.id} text={message.text} />
              case 'bot':
                return (
                  <TimedRow key={message.id} time={message.time} offset={offset}>
                    <BotBubble>
                      <Rich paragraphs={message.parts} onMention={openMention} />
                      {message.bold ? <Text style={styles.bold}>{message.bold}</Text> : null}
                    </BotBubble>
                  </TimedRow>
                )
              case 'me':
                return <TimedRow key={message.id} time={message.time} offset={offset} align="right"><MyBubble text={message.text} /></TimedRow>
              case 'card':
                return (
                  <TimedRow key={message.id} time={message.time} offset={offset}>
                    <ProactiveCard message={message} onAction={action => onAction?.(message.id, action)} onMention={openMention} />
                  </TimedRow>
                )
              case 'thread':
                return (
                  <TimedRow key={message.id} time={message.time} offset={offset}>
                    <ThreadCard message={message} onPress={() => router.push(`/threads/${message.threadId}`)} />
                  </TimedRow>
                )
            }
          })}
        </ScrollView>
      </View>
      <Composer placeholder={`给 ${bot.name} 发消息`} onSend={onSend} />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page },
  // Floats over the messages; a light veil keeps text from showing through the buttons.
  header: { position: 'absolute', top: 0, left: 0, right: 0, backgroundColor: 'rgba(255,255,255,0.94)' },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 44, paddingHorizontal: 16, borderRadius: 22, backgroundColor: '#fff', maxWidth: 220, ...lift },
  pillText: { fontSize: 16, fontWeight: '600' },
  // Room under the floating header, and space above the composer (适度留白).
  list: { paddingBottom: 28, paddingHorizontal: 16, gap: 12 },
  bold: { fontSize: 16, lineHeight: 25, fontWeight: '600', marginTop: 8 },
})
