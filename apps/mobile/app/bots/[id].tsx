import { useState } from 'react'
import { useLocalSearchParams } from 'expo-router'
import { ChatScreen } from '@/components/ChatScreen'
import type { Message } from '@/components/chat'
import { nowTime } from '@/lib/clock'
import { bots, threads } from '@/lib/mock'

/** A chat with one bot: its threads appear as cards (R-15). */
export default function BotChat() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const bot = bots.find(b => b.id === id) ?? bots[0]
  const own = threads.filter(t => t.bot === bot.name && !t.archived)
  const [messages, setMessages] = useState<Message[]>(() => [
    { id: 'hello', kind: 'bot', time: '09:12', parts: [[own.length ? `手上有 ${own.length} 个线程，有新进展会在这里说。` : '有事直接找我。']] },
    ...own.map(t => ({ id: t.id, kind: 'thread' as const, time: '09:12', threadId: t.id, title: t.title, status: t.status })),
  ])
  const onSend = (text: string) => {
    setMessages(list => [...list, { id: `me-${list.length}`, kind: 'me', time: nowTime(), text }])
    setTimeout(() => setMessages(list => [...list, { id: `bot-${list.length}`, kind: 'bot', time: nowTime(), parts: [['好，我开个线程去做。']] }]), 700)
  }
  return <ChatScreen bot={bot} messages={messages} onSend={onSend} waiting={own.some(t => t.unread)} />
}
