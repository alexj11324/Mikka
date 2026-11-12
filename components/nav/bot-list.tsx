'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { useLiveBotChatList, useLiveGroupList } from '@/hooks/use-live-lists'
import type { BotView } from '@/app/actions/bots'
import type { Thread } from '@/app/actions/task-runs'
import type { listIssues } from '@/app/actions/issues'
import type { TaskPresentation } from '@/lib/task-presentation'
import { CachedGroupAvatar } from './group-avatar'
import { botWorkTree, type BotWorkTask } from './bot-work-tree'
import { BotAvatar, CoordinatorAvatar } from './bot-avatar'

/**
 * What the center column shows: the Coordinator, a bot's chat (both on the
 * Coordinator harness), or a read-only older chat (reachable from ⌘K only).
 */
export type ChatTarget = { kind: 'coordinator' } | { kind: 'bot'; botId: string } | { kind: 'agent'; sessionId: string | null } | { kind: 'group'; id: string; title: string; workspaceId: string }

type Issue = Awaited<ReturnType<typeof listIssues>>[number]

/** The list's rows and unread dots: the Coordinator, then bots and group chats, most recent first. Shared with the frame's nav. */
function useChatRows({ bots, workspaceId, active, userId }: { bots: BotView[]; workspaceId: string | null; active: ChatTarget | null; userId: string }) {
  // Each bot's latest line gives its row its place in the list. The
  // Coordinator is one of these bots: its row reads the same summary, never its whole chat.
  const { data: chatList } = useLiveBotChatList(userId)
  const chats = chatList?.items ?? {}
  // Group chats sit among the bots (R-01), ordered by their latest message.
  const { data: groups = [], mutate: reloadGroups } = useLiveGroupList(userId, workspaceId)
  // The Coordinator's bot row is the entry pinned on top; the rest are the person's other bots.
  const rows = [...bots.filter(bot => !bot.coordinator).map(bot => ({ kind: 'bot' as const, bot, at: chats[bot.id]?.at ?? '' })), ...groups.map(group => ({ kind: 'group' as const, group, at: group.lastMessage?.createdAt ?? group.createdAt }))]
    .sort((a, b) => b.at.localeCompare(a.at) || (a.kind === 'bot' ? a.bot.name : a.group.title).localeCompare(b.kind === 'bot' ? b.bot.name : b.group.title))
  const latest: Record<string, string> = {}
  // The Coordinator's row is read as 'coordinator', from its bot's summary below.
  const coordinatorId = bots.find(bot => bot.coordinator)?.id
  const coordinator = coordinatorId ? chats[coordinatorId] : undefined
  for (const [botId, chat] of Object.entries(chats)) if (chat.at && botId !== coordinatorId) latest[botId] = chat.at
  for (const group of groups) if (group.lastMessage) latest[group.id] = group.lastMessage.createdAt
  if (coordinator?.at) latest.coordinator = coordinator.at
  const activeId = active?.kind === 'coordinator' ? 'coordinator' : active?.kind === 'bot' ? active.botId : active?.kind === 'group' ? active.id : null
  const unread = useUnread(activeId, latest)
  return { reloadGroups, rows, unread }
}

/** One row of the chat list as data, for a frame that draws its own navigation (RailProps.chats). */
export type ChatNavEntry = { id: string; kind: 'coordinator' | 'bot' | 'group'; name: string; unread: boolean; current: boolean; target: ChatTarget; avatar: ReactNode; work?: BotWorkTask[] }

/** The bot list's rows as data: what the hosted App Shell lists under Bots and 群聊, with the same unread dots. */
export function useChatNav({ bots, workspaceId, active, userId, threads = [], issues = [], presentations }: { bots: BotView[]; workspaceId: string | null; active: ChatTarget | null; userId: string; threads?: Thread[]; issues?: Issue[]; presentations: Readonly<Record<string, TaskPresentation>> }): { entries: ChatNavEntry[]; reloadGroups: () => Promise<unknown> } {
  const i18nText = useTranslations()
  const { rows, unread, reloadGroups } = useChatRows({ bots, workspaceId, active, userId })
  const coordinatorId = bots.find(bot => bot.coordinator)?.id
  const work = botWorkTree(workspaceId, bots.map(bot => bot.id), threads, issues, presentations)
  const coordinator: ChatNavEntry = { id: 'coordinator', kind: 'coordinator', name: i18nText('Nav.coordinator'), unread: unread('coordinator'), current: active?.kind === 'coordinator', target: { kind: 'coordinator' }, avatar: <CoordinatorAvatar size="row" />, work: coordinatorId ? work.get(coordinatorId) ?? [] : [] }
  const entries = [coordinator, ...rows.map((row): ChatNavEntry => row.kind === 'group'
    ? { id: row.group.id, kind: 'group', name: row.group.title || i18nText('Nav.untitledConversation'), unread: unread(row.group.id), current: active?.kind === 'group' && active.id === row.group.id, target: { kind: 'group', id: row.group.id, title: row.group.title, workspaceId: row.group.workspaceId }, avatar: <CachedGroupAvatar id={row.group.id} title={row.group.title || i18nText('Nav.untitledConversation')} /> }
    : { id: row.bot.id, kind: 'bot', name: row.bot.name, unread: unread(row.bot.id), current: active?.kind === 'bot' && active.botId === row.bot.id, target: { kind: 'bot', botId: row.bot.id }, avatar: <BotAvatar id={row.bot.id} color={row.bot.color} shape={row.bot.shape} size="row" still />, work: work.get(row.bot.id) ?? [] })]
  return { entries, reloadGroups }
}

const SEEN_KEY = 'mikka:conversations-seen'
type Seen = { since: string; at: Record<string, string> }

function readSeen(): Seen {
  try {
    const stored = JSON.parse(window.localStorage.getItem(SEEN_KEY) ?? 'null') as Seen | null
    if (stored?.since) return stored
  } catch { /* storage unavailable */ }
  return { since: new Date().toISOString(), at: {} }
}

/**
 * Unread dots. Nothing on the server records reading yet, so each browser
 * remembers when it last showed a bot's chat; anything newer is unread.
 */
function useUnread(activeId: string | null, latest: Record<string, string>) {
  const [seen, setSeen] = useState<Seen | null>(null)
  const activeLatest = activeId ? latest[activeId] : undefined
  useEffect(() => { setSeen(readSeen()) }, [])
  useEffect(() => {
    if (!activeId) return
    setSeen(current => {
      const next = { ...(current ?? readSeen()), at: { ...(current ?? readSeen()).at, [activeId]: new Date().toISOString() } }
      try { window.localStorage.setItem(SEEN_KEY, JSON.stringify(next)) } catch { /* storage unavailable */ }
      return next
    })
  }, [activeId, activeLatest])
  return (id: string) => !!seen && id !== activeId && !!latest[id] && latest[id] > (seen.at[id] ?? seen.since)
}
