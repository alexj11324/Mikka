import { useCallback, useState } from 'react'
import { ChatScreen } from '@/components/ChatScreen'
import type { Message } from '@/components/chat'
import { nowTime } from '@/lib/clock'
import { coordinator } from '@/lib/mock'

/**
 * The Coordinator chat, the app's home (mobile.md). The 08:00 briefing is one
 * bubble in Hark's tone (R-46); proactive cards carry the next step; after a
 * thread finishes an item the Coordinator reports and asks about the rest
 * (Figma 00, 01, 08).
 */
const initial: Message[] = [
  { id: 'date', kind: 'label', text: '今日简报 · 10月27日 星期二' },
  {
    id: 'briefing', kind: 'bot', time: '08:00',
    parts: [
      ['早上好，Alex。今天有 4 件事：'],
      ['Kevin 来信 ', { mention: '会议改期', source: 'gmail' }, ' ，想把周四的会挪到周三下午，他明天中午前要定行程。我可以按你的日历先起草一封回复。'],
      [{ mention: 'PR #212', source: 'github', href: '/threads/pr-212' }, ' 的类型检查没过，你说过今天要合并，我可以开个线程先把它修好。'],
      ['Jason 在 ', { mention: '#mikka-dev', source: 'slack' }, ' 问发布前要不要冻结 main，大家在等你拍板。'],
      [{ mention: '发布清单', source: 'notion' }, ' 新加了 3 项 iOS 上架检查，我可以整理成这周的任务。'],
      ['先从 Kevin 那封开始吗？'],
    ],
  },
  {
    id: 'kevin', kind: 'card', time: '10:24', source: 'gmail', from: 'Gmail · 投资人 Kevin Li',
    body: [['Kevin 问能不能把周四的会改到周三下午，他明天中午前要定行程。不回的话这周就约不上了。']],
    question: '要我按你的日历起草回复吗？',
    actions: ['起草回复', '晚点再说', '不用了'],
  },
  {
    id: 'pr', kind: 'card', time: '10:24', source: 'github', from: 'GitHub · alexj11324/Mikka #212',
    body: [['PR #212 的类型检查没过。你说过今天要合并，不修的话合不了。']],
    question: '要我修吗？',
    actions: ['修复', '晚点再说', '不用了'],
    answer: '修复', answerNote: '已派出线程',
  },
  { id: 'pr-ack', kind: 'bot', time: '10:31', parts: [['开了个线程去修，好了跟你说。']] },
  { id: 'pr-thread', kind: 'thread', time: '10:31', threadId: 'pr-212', title: '修复 PR #212 类型检查', status: 'running' },
]

let seq = 0
const id = () => `m${++seq}`

export default function CoordinatorScreen() {
  const [messages, setMessages] = useState<Message[]>(initial)
  const add = (...next: Message[]) => setMessages(list => [...list, ...next])
  const answer = (messageId: string, action: string, note?: string) =>
    setMessages(list => list.map(m => m.id === messageId && m.kind === 'card' ? { ...m, answer: action, answerNote: note } : m))

  const onAction = useCallback((messageId: string, action: string) => {
    if (action === '不用了') return answer(messageId, action)
    if (action === '晚点再说') {
      answer(messageId, action)
      return add({ id: id(), kind: 'bot', time: nowTime(), parts: [['好，明天上午 10 点再提醒你，在截止时间之前。']] })
    }
    answer(messageId, action, '已派出线程')
    if (messageId === 'kevin') {
      const threadMessage = id()
      add({ id: threadMessage, kind: 'thread', time: nowTime(), threadId: 'kevin-reply', title: '回复 Kevin：会议改到周三', status: 'running' })
      // The thread finishes; the Coordinator reports and asks about what is left (Figma 08).
      setTimeout(() => {
        setMessages(list => list.map(m => m.id === threadMessage && m.kind === 'thread' ? { ...m, status: 'done' } : m))
        add(
          { id: id(), kind: 'bot', time: nowTime(), parts: [['Kevin 那边办好了：会挪到了周三下午 3 点，回复已经发出，日历也同步改了。']] },
          {
            id: 'rest', kind: 'card', time: nowTime(), heading: '还有两件',
            body: [
              ['Jason 在 ', { mention: '#mikka-dev', source: 'slack' }, ' 等你决定发布前要不要冻结 main。'],
              [{ mention: '发布清单', source: 'notion' }, ' 新加的 3 项 iOS 检查，有空过一眼就行。'],
            ],
            question: '要我先帮你回 Jason 吗？',
            actions: ['回复 Jason', '过发布清单', '不用了'],
          },
        )
      }, 2200)
      return
    }
    const title = action === '回复 Jason' ? '回复 Jason：发布前冻结 main' : action === '过发布清单' ? '整理发布清单的 3 项 iOS 检查' : action
    add({ id: id(), kind: 'thread', time: nowTime(), threadId: 'pr-212', title, status: 'running' })
  }, [])

  const onSend = (text: string) => {
    add({ id: id(), kind: 'me', time: nowTime(), text })
    setTimeout(() => add({ id: id(), kind: 'bot', time: nowTime(), parts: [['收到，我来安排，有结果跟你说。']] }), 700)
  }

  return <ChatScreen bot={coordinator} messages={messages} onAction={onAction} onSend={onSend} waiting />
}
