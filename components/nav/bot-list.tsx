'use client'

import type { ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { useLiveBotChatList, useLiveGroupList } from '@/hooks/use-live-lists'
import type { BotView } from '@/app/actions/bots'
import useSWR, { unstable_serialize } from 'swr'
import { useLiveKey } from '@/hooks/use-live-key'
import { pullRequestsState } from '@/lib/directory-pulls'
import { listConversationSidebar } from '@/app/actions/task-runs'
import type { Thread } from '@/app/actions/task-runs'
import type { GroupSummary } from '@/lib/group-messages'
import type { listIssues } from '@/app/actions/issues'
import type { TaskPresentation } from '@/lib/task-presentation'
import { CachedGroupAvatar } from './group-avatar'
import type { BotWorkTask } from './bot-work-tree'
import { BotAvatar, CoordinatorAvatar } from './bot-avatar'
import { toast } from 'sonner'
import { navigate } from '@/components/workspace/workspace-navigation'
import { openChatInNewTab, setChatUnread, type ChatNavAction } from './chat-row-actions'

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
  const { data: groups = [], error: groupsError, mutate: reloadGroups } = useLiveGroupList(userId, workspaceId)
  // The Coordinator's bot row is the entry pinned on top; the rest are the person's other bots.
  const rows = [...bots.filter(bot => !bot.coordinator).map(bot => ({ kind: 'bot' as const, bot, at: chats[bot.id]?.at ?? '' })), ...groups.filter(group => group.creationPurpose !== 'conversation').map(group => ({ kind: 'group' as const, group, at: group.lastMessage?.createdAt ?? group.createdAt }))]
    .sort((a, b) => b.at.localeCompare(a.at) || (a.kind === 'bot' ? a.bot.name : a.group.title).localeCompare(b.kind === 'bot' ? b.bot.name : b.group.title))
  const unreadCount = (id: string) => chats[id]?.unreadCount ?? 0
  const latestMessage = (id: string) => chats[id]?.messageId
  return { reloadGroups, rows, unreadCount, latestMessage, referenceGroups: groupsError ? [] : groups }

}

/** One row of the chat list as data, for a frame that draws its own navigation (RailProps.chats). */
export type ChatNavEntry = { id: string; kind: 'coordinator' | 'bot' | 'group'; name: string; unread: boolean; unreadCount?: number; current: boolean; target: ChatTarget; avatar: ReactNode; work?: BotWorkTask[]; moreBotId?: string; actions?: ChatNavAction[] }
export type { ChatNavAction }

/** The bot list's rows as data: what the hosted App Shell lists under Bots and 群聊, with the same unread dots. */
/** What the person can do to the bot itself from its row (lib/bot-lifecycle.ts): archive or restore it, or ask to delete it. */
export type BotLifecycle = { archive: (bot: BotView, archived: boolean) => void; askDelete: (bot: BotView) => void }

export function useChatNav({ bots, archivedBots = [], workspaceId, active, userId, presentations, onLeaveGroup, lifecycle }: { bots: BotView[]; archivedBots?: BotView[]; workspaceId: string | null; active: ChatTarget | null; userId: string; threads?: Thread[]; issues?: Issue[]; presentations: Readonly<Record<string, TaskPresentation>>; onLeaveGroup?: (group: GroupSummary) => void; lifecycle?: BotLifecycle }): { entries: ChatNavEntry[]; archived: ChatNavEntry[]; reloadGroups: () => Promise<unknown>; referenceGroups: GroupSummary[] } {
  const i18nText = useTranslations()
  const { rows, unreadCount, latestMessage, reloadGroups, referenceGroups } = useChatRows({ bots, workspaceId, active, userId })
  const coordinatorId = bots.find(bot => bot.coordinator)?.id
  const sidebarKey = workspaceId ? ['conversation-sidebar',userId,workspaceId] : null
  const {data: sidebar} = useSWR(sidebarKey, () => listConversationSidebar(), {revalidateOnFocus:false})
  useLiveKey('thread_list', workspaceId, sidebarKey ? [unstable_serialize(sidebarKey)] : [], workspaceId)
  useLiveKey('group_list', workspaceId, sidebarKey ? [unstable_serialize(sidebarKey)] : [], workspaceId)
  const workFor = (botId: string | undefined) => {
    const group = botId ? sidebar?.[botId] : undefined
    return { moreBotId: group?.more ? botId : undefined, work: group?.items.map(row => {
      const task = row.issueId ? presentations[row.issueId] : undefined
      return { kind:row.kind, id:row.id, issueId:row.issueId, name:row.title, fullName:row.title,
        ...(row.kind === 'chat' && workspaceId ? {
          conversationTarget: { kind: 'group' as const, id: row.id, title: row.title, workspaceId },
        } : {}),
        pullState: row.pulls?.length ? pullRequestsState(row.pulls) : undefined,
        status:row.status, state:task?.state ?? null, reason:task?.reason ?? null,
        unread:row.unread,unreadCount:Number(row.unread), activity: row.state === 'waiting' ? 'waiting' as const : row.state === 'working' ? 'working' as const : row.state === 'failed' ? 'error' as const : null,
        runs:row.kind === 'chat' ? [] : [{id:row.id,name:row.title,harness:row.harness}] }
    }) ?? [] }
  }
  const botUnread = (id: string) => {
    const group = sidebar?.[id]
    const childCount = group?.unreadCount ?? group?.items.filter(row => row.unread).length ?? 0
    const count = unreadCount(id) + childCount
    return { unread: count > 0, unreadCount: count }
  }
  // The row's right-click menu (Capy's Captain row): only what the chat's existing writers do, and what the list then shows.
  const runChange = (change: Promise<void>) => { void change.catch(() => toast.error(i18nText('ConversationDirectory.writeError'))) }
  const chatUnreadActions = (chat: Parameters<typeof setChatUnread>[0], unread: boolean): ChatNavAction[] => [unread
    ? { id: 'markRead', label: i18nText('HostedThread.markRead'), run: () => runChange(setChatUnread(chat, false)) }
    : { id: 'markUnread', label: i18nText('ConversationDirectory.markUnread'), run: () => runChange(setChatUnread(chat, true)) }]
  const botActions = (botId: string | undefined, target: ChatTarget, unread: boolean, bot?: BotView): ChatNavAction[] => [
    { id: 'openNewTab', label: i18nText('IssueDetail.menu.openNewTab'), run: () => openChatInNewTab(target) },
    ...(botId ? [
      { id: 'viewAll' as const, label: i18nText('ConversationDirectory.viewAll'), run: () => navigate({ section: 'conversations', directoryBot: botId, issue: null, task: null, thread: null, threads: null }) },
      ...chatUnreadActions({ kind: 'bot', botId, latestMessageId: latestMessage(botId) }, unread),
    ] : []),
    // The Coordinator is neither archived nor deleted; its row passes no bot.
    ...(bot && lifecycle ? [
      { id: 'archive' as const, label: i18nText('Nav.botMenu.archive'), run: () => lifecycle.archive(bot, true) },
      { id: 'delete' as const, label: i18nText('Nav.botMenu.delete'), danger: true, run: () => lifecycle.askDelete(bot) },
    ] : []),
  ]
  const groupActions = (group: GroupSummary, target: ChatTarget, unread: boolean): ChatNavAction[] => [
    { id: 'openNewTab', label: i18nText('IssueDetail.menu.openNewTab'), run: () => openChatInNewTab(target) },
    ...chatUnreadActions({ kind: 'group', id: group.id, latestMessageId: group.lastMessage?.id }, unread),
    ...(onLeaveGroup && group.createdBy !== userId ? [{ id: 'leave' as const, label: i18nText('GroupChat.leave'), danger: true, run: () => onLeaveGroup(group) }] : []),
  ]
  const coordinatorUnread = botUnread(coordinatorId ?? '')
  const coordinator: ChatNavEntry = { id: 'coordinator', kind: 'coordinator', name: i18nText('Nav.coordinator'), ...coordinatorUnread, current: active?.kind === 'coordinator', target: { kind: 'coordinator' }, avatar: <CoordinatorAvatar size="row" />, ...workFor(coordinatorId),
    actions: botActions(coordinatorId, { kind: 'coordinator' }, unreadCount(coordinatorId ?? '') > 0) }
  const entries = [coordinator, ...rows.map((row): ChatNavEntry => {
    if (row.kind === 'group') {
      const target: ChatTarget = { kind: 'group', id: row.group.id, title: row.group.title, workspaceId: row.group.workspaceId }
      const unread = Boolean(Number(row.group.unreadCount) || row.group.markedUnread)
      return { id: row.group.id, kind: 'group', name: row.group.title || i18nText('Nav.untitledConversation'), unread, unreadCount: Number(row.group.unreadCount) || Number(Boolean(row.group.markedUnread)), current: active?.kind === 'group' && active.id === row.group.id, target, avatar: <CachedGroupAvatar id={row.group.id} title={row.group.title || i18nText('Nav.untitledConversation')} />, actions: groupActions(row.group, target, unread) }
    }
    const target: ChatTarget = { kind: 'bot', botId: row.bot.id }
    // 标为已读 reads the Bot's own chat; its threads' unread stay with the threads.
    return { id: row.bot.id, kind: 'bot', name: row.bot.name, ...botUnread(row.bot.id), current: active?.kind === 'bot' && active.botId === row.bot.id, target, avatar: <BotAvatar id={row.bot.id} color={row.bot.color} shape={row.bot.shape} size="row" still />, ...workFor(row.bot.id), actions: botActions(row.bot.id, target, unreadCount(row.bot.id) > 0, row.bot) }
  })]
  // 已归档: the person's archived bots. They open nothing; their menu restores or deletes them.
  const archived = lifecycle ? archivedBots.map((bot): ChatNavEntry => ({ id: bot.id, kind: 'bot', name: bot.name, unread: false, current: false, target: { kind: 'bot', botId: bot.id },
    avatar: <BotAvatar id={bot.id} color={bot.color} shape={bot.shape} size="row" still />,
    actions: [
      { id: 'unarchive', label: i18nText('Nav.botMenu.unarchive'), run: () => lifecycle.archive(bot, false) },
      { id: 'delete', label: i18nText('Nav.botMenu.delete'), danger: true, run: () => lifecycle.askDelete(bot) },
    ] })) : []
  return { entries, archived, reloadGroups, referenceGroups }
}
