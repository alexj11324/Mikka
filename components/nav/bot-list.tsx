'use client'

import type { ReactNode } from 'react'
import { useMemo, useRef } from 'react'
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
import { ChatRowActionError, chatPlace, copyPlaceLink, openPlaceInNewTab, setChatPreference, setChatUnread, setThreadUnread, threadPlace, type ChatNavAction } from './chat-row-actions'
import { setConversationOrganization } from '@/app/actions/task-runs'

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
  // Group chats sit among the bots (R-01), ordered by their latest message.
  const { data: groupList, error: groupsError, mutate: reloadGroups } = useLiveGroupList(userId, workspaceId)
  // `?? {}` / `?? []` would be a new identity on every render and defeat the memo below.
  const chats = useMemo(() => chatList?.items ?? {}, [chatList])
  const groups = useMemo(() => groupList ?? [], [groupList])
  // Everything here is read straight off the two reads, so the rows only change when they do.
  return useMemo(() => {
    // The Coordinator's bot row is the entry pinned on top; the rest are the person's other bots and group chats:
    // the ones they pinned first (in their pin order, then newest), then the rest newest first. Hidden ones list apart.
    const all = [...bots.filter(bot => !bot.coordinator).map(bot => ({ kind: 'bot' as const, bot, at: chats[bot.id]?.at ?? '',
      pinned: Boolean(chats[bot.id]?.pinned), pinOrder: chats[bot.id]?.pinOrder ?? null, hidden: Boolean(chats[bot.id]?.hidden) })),
    ...groups.filter(group => group.creationPurpose !== 'conversation').map(group => ({ kind: 'group' as const, group, at: group.lastMessage?.createdAt ?? group.createdAt,
      pinned: Boolean(group.pinned), pinOrder: group.pinOrder ?? null, hidden: Boolean(group.hidden) }))]
      .sort((a, b) => Number(b.pinned) - Number(a.pinned)
        || (a.pinned && a.pinOrder !== null && b.pinOrder !== null ? a.pinOrder - b.pinOrder : 0)
        || b.at.localeCompare(a.at) || (a.kind === 'bot' ? a.bot.name : a.group.title).localeCompare(b.kind === 'bot' ? b.bot.name : b.group.title))
    const rows = all.filter(row => !row.hidden)
    const hiddenRows = all.filter(row => row.hidden)
    const unreadCount = (id: string) => chats[id]?.unreadCount ?? 0
    const latestMessage = (id: string) => chats[id]?.messageId
    const summary = (id: string) => chats[id]
    const muted = (id: string) => Boolean(chats[id]?.muted)
    return { reloadGroups, rows, hiddenRows, unreadCount, latestMessage, summary, muted, referenceGroups: groupsError ? [] : groups }
  }, [bots, chats, groups, groupsError, reloadGroups])
}

/** One row of the chat list as data, for a frame that draws its own navigation (RailProps.chats). */
/**
 * One row of the chat list as data. As Capy's Captain row (decision 2026-11-18-1200): `unread` only makes the name stronger, never a number;
 * `preview` is the latest line and `at` its time; `working` is a live turn; `waitingCount` counts the threads under it that wait on the person.
 */
export type ChatNavEntry = { id: string; kind: 'coordinator' | 'bot' | 'group'; name: string; unread: boolean; preview?: string | null; at?: string | null; working?: boolean; waitingCount?: number; /** The row's picture at Capy's two densities: 详细 (32px) and 紧凑 (20px). */ face?: (density: 'detailed' | 'compact') => ReactNode; current: boolean; target: ChatTarget; avatar: ReactNode; work?: BotWorkTask[]; moreBotId?: string; actions?: ChatNavAction[] }
export type { ChatNavAction }

/** The bot list's rows as data: what the hosted App Shell lists under Bots and 群聊, with the same unread dots. */
/** What the person can do to the bot itself from its row (lib/bot-lifecycle.ts): archive or restore it, or ask to delete it. */
export type BotLifecycle = { archive: (bot: BotView, archived: boolean) => void; askDelete: (bot: BotView) => void }
/** What a row's menu asks the page for: a Bot's profile (its chat's 概览), and a thread's new title. */
export type ChatNavPage = { openProfile: (target: ChatTarget) => void; renameThread: (thread: { target: { kind: 'run' | 'chat'; id: string }; title: string }) => void }

export function useChatNav({ bots, archivedBots = [], workspaceId, active, userId, presentations, onLeaveGroup, lifecycle, page }: { bots: BotView[]; archivedBots?: BotView[]; workspaceId: string | null; active: ChatTarget | null; userId: string; threads?: Thread[]; issues?: Issue[]; presentations: Readonly<Record<string, TaskPresentation>>; onLeaveGroup?: (group: GroupSummary) => void; lifecycle?: BotLifecycle; page?: ChatNavPage }): { entries: ChatNavEntry[]; archived: ChatNavEntry[]; hidden: ChatNavEntry[]; reloadGroups: () => Promise<unknown>; referenceGroups: GroupSummary[] } {
  const i18nText = useTranslations()
  const chatRows = useChatRows({ bots, workspaceId, active, userId })
  const { rows, hiddenRows, unreadCount, latestMessage, summary, muted, reloadGroups, referenceGroups } = chatRows
  const coordinatorId = bots.find(bot => bot.coordinator)?.id
  const sidebarKey = workspaceId ? ['conversation-sidebar',userId,workspaceId] : null
  const {data: sidebar} = useSWR(sidebarKey, () => listConversationSidebar(), {revalidateOnFocus:false})
  useLiveKey('thread_list', workspaceId, sidebarKey ? [unstable_serialize(sidebarKey)] : [], workspaceId)
  useLiveKey('group_list', workspaceId, sidebarKey ? [unstable_serialize(sidebarKey)] : [], workspaceId)
  // A row's highlight reads exactly two facts about `active`, and the page builds that object afresh on
  // every render: depend on the two values, not on the object, or these rows could never be reused.
  const activeKind = active?.kind ?? null
  const activeId = active?.kind === 'bot' ? active.botId : active?.kind === 'group' ? active.id : active?.kind === 'agent' ? active.sessionId : null
  // What a row's menu does is the page's business, not the row's: the callbacks are read from here when a menu
  // item runs, so the page can hand over fresh ones on every render without rebuilding every row.
  const menu = useRef({ onLeaveGroup, lifecycle, page })
  menu.current = { onLeaveGroup, lifecycle, page }
  // The rows, their avatars and their menus: rebuilt only when the people, the chats or the workspace change.
  const model = useMemo(() => {
    // A row's right-click menu (Capy's Captain and thread rows): only what the existing writers do, and what the list then shows.
    const failed = (error: unknown) => toast.error(i18nText(error instanceof ChatRowActionError && error.status === 409 ? 'Nav.botMenu.pinLimit' : 'Nav.botMenu.failed'))
    const runChange = (change: Promise<unknown>) => { void change.catch(failed) }
    const copyLink = (place: Parameters<typeof copyPlaceLink>[0]) => runChange(copyPlaceLink(place).then(() => { toast.success(i18nText('Nav.botMenu.linkCopied')) }))
    const organize = (target: { kind: 'run' | 'chat'; id: string }, field: 'archived' | 'pinned', value: boolean, done?: () => void) =>
      runChange(setConversationOrganization(target, { field, value }).then(state => { if (!state) throw new ChatRowActionError(404); done?.() }))
    const threadActions = (row: NonNullable<typeof sidebar>[string]['items'][number], place: ReturnType<typeof threadPlace>): ChatNavAction[] => {
      const target = { kind: row.kind === 'chat' ? 'chat' as const : 'run' as const, id: row.id }
      return [
        { id: 'openNewTab', label: i18nText('IssueDetail.menu.openNewTab'), run: () => openPlaceInNewTab(place) },
        { id: 'copyLink', label: i18nText('Nav.botMenu.copyLink'), run: () => copyLink(place) },
        row.pinned
          ? { id: 'unpin', label: i18nText('Nav.botMenu.unpin'), run: () => organize(target, 'pinned', false) }
          : { id: 'pin', label: i18nText('Nav.botMenu.pin'), run: () => organize(target, 'pinned', true) },
        ...(menu.current.page ? [{ id: 'rename' as const, label: i18nText('Nav.botMenu.rename'), run: () => menu.current.page?.renameThread({ target, title: row.title }) }] : []),
        row.unread
          ? { id: 'markRead', label: i18nText('HostedThread.markRead'), run: () => runChange(setThreadUnread(row, false)) }
          : { id: 'markUnread', label: i18nText('ConversationDirectory.markUnread'), run: () => runChange(setThreadUnread(row, true)) },
        { id: 'archive', label: i18nText('Nav.botMenu.archive'), run: () => organize(target, 'archived', true, () => toast.success(i18nText('Nav.botMenu.threadArchived', { name: row.title || i18nText('Nav.untitledConversation') }))) },
      ]
    }
    const workFor = (botId: string | undefined) => {
      const group = botId ? sidebar?.[botId] : undefined
      return { moreBotId: group?.more ? botId : undefined, work: group?.items.map(row => {
        const task = row.issueId ? presentations[row.issueId] : undefined
        const runs = row.kind === 'chat' ? [] : [{id:row.id,name:row.title,harness:row.harness}]
        const place = threadPlace({ kind: row.kind, id: row.id, issueId: row.issueId, runs })
        return { actions: threadActions(row, place.mainThread && botId ? { ...place, bot: botId } : place),
          kind:row.kind, id:row.id, issueId:row.issueId, name:row.title, fullName:row.title, at: row.at, identifier: row.identifier ?? null,
          ...(row.kind === 'chat' && workspaceId ? {
            conversationTarget: { kind: 'group' as const, id: row.id, title: row.title, workspaceId },
          } : {}),
          pullState: row.pulls?.length ? pullRequestsState(row.pulls) : undefined,
          status:row.status, state:task?.state ?? null, reason:task?.reason ?? null,
          unread:row.unread, activity: row.state === 'waiting' ? 'waiting' as const : row.state === 'working' ? 'working' as const : row.state === 'failed' ? 'error' as const : null,
          runs }
      }) ?? [] }
    }
    // A Bot's row: its own chat's unread (the name in bold), latest line and time, a live turn, and how many of its threads wait on the person.
    const botRow = (id: string) => {
      const chat = summary(id)
      const waitingCount = sidebar?.[id]?.items.filter(row => row.state === 'waiting').length ?? 0
      return { unread: unreadCount(id) > 0, preview: chat?.line ?? null, at: chat?.at ?? null, working: Boolean(chat?.working), waitingCount }
    }
    const chatUnreadActions = (chat: Parameters<typeof setChatUnread>[0], unread: boolean): ChatNavAction[] => [unread
      ? { id: 'markRead', label: i18nText('HostedThread.markRead'), run: () => runChange(setChatUnread(chat, false)) }
      : { id: 'markUnread', label: i18nText('ConversationDirectory.markUnread'), run: () => runChange(setChatUnread(chat, true)) }]
    const linkActions = (target: ChatTarget): ChatNavAction[] => [
      { id: 'openNewTab', label: i18nText('IssueDetail.menu.openNewTab'), run: () => openPlaceInNewTab(chatPlace(target)) },
      { id: 'copyLink', label: i18nText('Nav.botMenu.copyLink'), run: () => copyLink(chatPlace(target)) },
    ]
    const preference = (chat: Parameters<typeof setChatPreference>[0], change: Parameters<typeof setChatPreference>[1]) => () => runChange(setChatPreference(chat, change))
    const pinActions = (chat: Parameters<typeof setChatPreference>[0], pinned: boolean): ChatNavAction[] => [pinned
      ? { id: 'unpin', label: i18nText('Nav.botMenu.unpin'), run: preference(chat, { pinned: false }) }
      : { id: 'pin', label: i18nText('Nav.botMenu.pin'), run: preference(chat, { pinned: true }) }]
    const hideActions = (chat: Parameters<typeof setChatPreference>[0], hidden: boolean): ChatNavAction[] => [hidden
      ? { id: 'unhide', label: i18nText('Nav.botMenu.unhide'), run: preference(chat, { hidden: false }) }
      : { id: 'hide', label: i18nText('Nav.botMenu.hide'), run: preference(chat, { hidden: true }) }]
    const botActions = (botId: string | undefined, target: ChatTarget, unread: boolean, bot?: BotView, state?: { pinned: boolean; hidden: boolean }): ChatNavAction[] => [
      ...linkActions(target),
      ...(menu.current.page ? [{ id: 'profile' as const, label: i18nText('Nav.botMenu.profile'), run: () => menu.current.page?.openProfile(target) }] : []),
      ...(botId ? [
        muted(botId)
          ? { id: 'unmute' as const, label: i18nText('Nav.botMenu.unmute'), run: preference({ kind: 'bot', botId }, { muted: false }) }
          : { id: 'mute' as const, label: i18nText('Nav.botMenu.mute'), run: preference({ kind: 'bot', botId }, { muted: true }) },
        // The Coordinator stays on top: it is neither pinned nor hidden, archived nor deleted; its row passes no bot.
        ...(bot && state ? pinActions({ kind: 'bot', botId }, state.pinned) : []),
        { id: 'viewAll' as const, label: i18nText('ConversationDirectory.viewAll'), run: () => navigate({ section: 'conversations', directoryBot: botId, issue: null, task: null, thread: null, threads: null }) },
        ...chatUnreadActions({ kind: 'bot', botId, latestMessageId: latestMessage(botId) }, unread),
        ...(bot && state ? hideActions({ kind: 'bot', botId }, state.hidden) : []),
      ] : []),
      ...(bot && menu.current.lifecycle ? [
        { id: 'archive' as const, label: i18nText('Nav.botMenu.archive'), run: () => menu.current.lifecycle?.archive(bot, true) },
        { id: 'delete' as const, label: i18nText('Nav.botMenu.delete'), danger: true, run: () => menu.current.lifecycle?.askDelete(bot) },
      ] : []),
    ]
    const groupActions = (group: GroupSummary, target: ChatTarget, unread: boolean): ChatNavAction[] => [
      ...linkActions(target),
      ...pinActions({ kind: 'group', id: group.id }, Boolean(group.pinned)),
      ...chatUnreadActions({ kind: 'group', id: group.id, latestMessageId: group.lastMessage?.id }, unread),
      ...hideActions({ kind: 'group', id: group.id }, Boolean(group.hidden)),
      ...(menu.current.onLeaveGroup && group.createdBy !== userId ? [{ id: 'leave' as const, label: i18nText('GroupChat.leave'), danger: true, run: () => menu.current.onLeaveGroup?.(group) }] : []),
    ]
    const coordinator: ChatNavEntry = { id: 'coordinator', kind: 'coordinator', name: i18nText('Nav.coordinator'), ...botRow(coordinatorId ?? ''), current: activeKind === 'coordinator', target: { kind: 'coordinator' }, avatar: <CoordinatorAvatar size="row" />, face: density => <CoordinatorAvatar size={density === 'detailed' ? 'list' : 'pill'} />, ...workFor(coordinatorId),
      actions: botActions(coordinatorId, { kind: 'coordinator' }, unreadCount(coordinatorId ?? '') > 0) }
    const entry = (row: (typeof rows)[number]): ChatNavEntry => {
      if (row.kind === 'group') {
        const target: ChatTarget = { kind: 'group', id: row.group.id, title: row.group.title, workspaceId: row.group.workspaceId }
        const unread = Boolean(Number(row.group.unreadCount) || row.group.markedUnread)
        return { id: row.group.id, kind: 'group', name: row.group.title || i18nText('Nav.untitledConversation'), unread, preview: row.group.lastMessage?.body ?? null, at: row.group.lastMessage?.createdAt ?? row.group.createdAt, current: activeKind === 'group' && activeId === row.group.id, target, avatar: <CachedGroupAvatar id={row.group.id} title={row.group.title || i18nText('Nav.untitledConversation')} />, actions: groupActions(row.group, target, unread) }
      }
      const target: ChatTarget = { kind: 'bot', botId: row.bot.id }
      // 标为已读 reads the Bot's own chat; its threads' unread stay with the threads.
      return { id: row.bot.id, kind: 'bot', name: row.bot.name, ...botRow(row.bot.id), current: activeKind === 'bot' && activeId === row.bot.id, target, avatar: <BotAvatar id={row.bot.id} color={row.bot.color} shape={row.bot.shape} size="row" still />, face: density => <BotAvatar id={row.bot.id} color={row.bot.color} shape={row.bot.shape} size={density === 'detailed' ? 'list' : 'pill'} still />, ...workFor(row.bot.id), actions: botActions(row.bot.id, target, unreadCount(row.bot.id) > 0, row.bot, row) }
    }
    const entries = [coordinator, ...rows.map(entry)]
    // 已隐藏: chats the person hid. They still open; their menu brings them back (取消隐藏).
    const hidden = hiddenRows.map(row => ({ ...entry(row), work: undefined, moreBotId: undefined }))
    // 已归档: the person's archived bots. They open nothing; their menu restores or deletes them.
    const archived = menu.current.lifecycle ? archivedBots.map((bot): ChatNavEntry => ({ id: bot.id, kind: 'bot', name: bot.name, unread: false, current: false, target: { kind: 'bot', botId: bot.id },
      avatar: <BotAvatar id={bot.id} color={bot.color} shape={bot.shape} size="row" still />,
      face: density => <BotAvatar id={bot.id} color={bot.color} shape={bot.shape} size={density === 'detailed' ? 'list' : 'pill'} still />,
      actions: [
        { id: 'unarchive', label: i18nText('Nav.botMenu.unarchive'), run: () => menu.current.lifecycle?.archive(bot, false) },
        { id: 'delete', label: i18nText('Nav.botMenu.delete'), danger: true, run: () => menu.current.lifecycle?.askDelete(bot) },
      ] })) : []
    return { entries, archived, hidden }
  // Every value the rows read. The menu callbacks are read through `menu`, so their identity (always new)
  // never rebuilds a row — only whether the page offers them at all, which is what the three flags carry.
  }, [bots, archivedBots, workspaceId, userId, presentations, i18nText, sidebar, chatRows, activeKind, activeId, Boolean(onLeaveGroup), Boolean(lifecycle), Boolean(page)]) // eslint-disable-line react-hooks/exhaustive-deps -- `menu` holds the callbacks themselves
  return { ...model, reloadGroups, referenceGroups }
}
