'use client'

import type { ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { useLiveBotChatList, useLiveGroupList } from '@/hooks/use-live-lists'
import type { BotView } from '@/app/actions/bots'
import useSWR, { unstable_serialize } from 'swr'
import { useLiveKey } from '@/hooks/use-live-key'
import { listConversationSidebar } from '@/app/actions/task-runs'
import type { Thread } from '@/app/actions/task-runs'
import type { listIssues } from '@/app/actions/issues'
import type { TaskPresentation } from '@/lib/task-presentation'
import { CachedGroupAvatar } from './group-avatar'
import type { BotWorkTask } from './bot-work-tree'
import { BotAvatar, CoordinatorAvatar } from './bot-avatar'

/**
 * What the center column shows: the Coordinator, a bot's chat (both on the
 * Coordinator harness), or a read-only older chat (reachable from ⌘K only).
 */
export type ChatTarget = { kind: 'coordinator' } | { kind: 'bot'; botId: string } | { kind: 'agent'; sessionId: string | null } | { kind: 'group'; id: string; title: string; workspaceId: string }

type Issue = Awaited<ReturnType<typeof listIssues>>[number]

/** The list's rows and unread dots: the Coordinator, then bots and group chats, most recent first. Shared with the frame's nav. */
function useChatRows({ bots, workspaceId, userId }: { bots: BotView[]; workspaceId: string | null; active: ChatTarget | null; userId: string }) {
  // Each bot's latest line gives its row its place in the list. The
  // Coordinator is one of these bots: its row reads the same summary, never its whole chat.
  const { data: chatList } = useLiveBotChatList(userId)
  const chats = chatList?.items ?? {}
  // Group chats sit among the bots (R-01), ordered by their latest message.
  const { data: groups = [], mutate: reloadGroups } = useLiveGroupList(userId, workspaceId)
  // The Coordinator's bot row is the entry pinned on top; the rest are the person's other bots.
  const rows = [...bots.filter(bot => !bot.coordinator).map(bot => ({ kind: 'bot' as const, bot, at: chats[bot.id]?.at ?? '' })), ...groups.filter(group => group.creationPurpose !== 'conversation').map(group => ({ kind: 'group' as const, group, at: group.lastMessage?.createdAt ?? group.createdAt }))]
    .sort((a, b) => b.at.localeCompare(a.at) || (a.kind === 'bot' ? a.bot.name : a.group.title).localeCompare(b.kind === 'bot' ? b.bot.name : b.group.title))
  const unreadCount = (id: string) => chats[id]?.unreadCount ?? 0
  return { reloadGroups, rows, unreadCount }

}

/** One row of the chat list as data, for a frame that draws its own navigation (RailProps.chats). */
export type ChatNavEntry = { id: string; kind: 'coordinator' | 'bot' | 'group'; name: string; unread: boolean; unreadCount?: number; current: boolean; target: ChatTarget; avatar: ReactNode; work?: BotWorkTask[]; moreBotId?: string }

/** The bot list's rows as data: what the hosted App Shell lists under Bots and 群聊, with the same unread dots. */
export function useChatNav({ bots, workspaceId, active, userId, presentations }: { bots: BotView[]; workspaceId: string | null; active: ChatTarget | null; userId: string; threads?: Thread[]; issues?: Issue[]; presentations: Readonly<Record<string, TaskPresentation>> }): { entries: ChatNavEntry[]; reloadGroups: () => Promise<unknown> } {
  const i18nText = useTranslations()
  const { rows, unreadCount, reloadGroups } = useChatRows({ bots, workspaceId, active, userId })
  const coordinatorId = bots.find(bot => bot.coordinator)?.id
  const sidebarKey = workspaceId ? ['conversation-sidebar',userId,workspaceId] : null
  const {data: sidebar} = useSWR(sidebarKey, () => listConversationSidebar(), {revalidateOnFocus:true})
  useLiveKey('thread_list', workspaceId, sidebarKey ? [unstable_serialize(sidebarKey)] : [], workspaceId)
  const workFor = (botId: string | undefined) => {
    const group = botId ? sidebar?.[botId] : undefined
    return { moreBotId: group?.more ? botId : undefined, work: group?.items.map(row => {
      const task = row.issueId ? presentations[row.issueId] : undefined
      return { id:row.id, issueId:row.issueId, name:row.title, fullName:row.title,
        status:row.status, state:task?.state ?? null, reason:task?.reason ?? null,
        unread:row.unread,unreadCount:Number(row.unread), activity: row.state === 'waiting' ? 'waiting' as const : row.state === 'working' ? 'working' as const : row.state === 'failed' ? 'error' as const : null,
        runs:[{id:row.id,name:row.title,harness:row.harness}] }
    }) ?? [] }
  }
  const botUnread = (id:string) => { const count=unreadCount(id)+(sidebar?.[id]?.items ?? []).reduce((sum,row)=>sum+Number(row.unread),0); return {unread:count>0,unreadCount:count} }
  const coordinator: ChatNavEntry = { id: 'coordinator', kind: 'coordinator', name: i18nText('Nav.coordinator'), ...botUnread(coordinatorId ?? ''), current: active?.kind === 'coordinator', target: { kind: 'coordinator' }, avatar: <CoordinatorAvatar size="row" />, ...workFor(coordinatorId) }
  const entries = [coordinator, ...rows.map((row): ChatNavEntry => row.kind === 'group'
    ? { id: row.group.id, kind: 'group', name: row.group.title || i18nText('Nav.untitledConversation'), unread: Boolean(Number(row.group.unreadCount) || row.group.markedUnread), unreadCount: Number(row.group.unreadCount) || Number(Boolean(row.group.markedUnread)), current: active?.kind === 'group' && active.id === row.group.id, target: { kind: 'group', id: row.group.id, title: row.group.title, workspaceId: row.group.workspaceId }, avatar: <CachedGroupAvatar id={row.group.id} title={row.group.title || i18nText('Nav.untitledConversation')} /> }
    : { id: row.bot.id, kind: 'bot', name: row.bot.name, ...botUnread(row.bot.id), current: active?.kind === 'bot' && active.botId === row.bot.id, target: { kind: 'bot', botId: row.bot.id }, avatar: <BotAvatar id={row.bot.id} color={row.bot.color} shape={row.bot.shape} size="row" still />, ...workFor(row.bot.id) })]
  return { entries, reloadGroups }
}
