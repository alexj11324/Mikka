import { withBasePath } from '@/lib/base-path'
import { workspaceSearch, type WorkspaceLocation } from '@/components/workspace/workspace-navigation'
import type { ChatTarget } from './bot-list'

/**
 * A sidebar row's right-click menu (Capy's Captain row): what the frame lists for one Bot or group chat.
 * `id` lets the frame pick the item's icon; `label` is already in the person's language.
 */
export type ChatNavActionId = 'openNewTab' | 'copyLink' | 'profile' | 'pin' | 'unpin' | 'mute' | 'unmute' | 'markRead' | 'markUnread' | 'viewAll'
  | 'rename' | 'hide' | 'unhide' | 'leave' | 'archive' | 'unarchive' | 'delete'
export type ChatNavAction = { id: ChatNavActionId; label: string; danger?: boolean; run: () => void }

/** The place a chat opens at, as an address (the same one the row opens). */
export function chatPlace(target: ChatTarget): Partial<WorkspaceLocation> | null {
  if (target.kind === 'coordinator') return { section: 'coordinator' }
  if (target.kind === 'bot') return { section: 'coordinator', bot: target.botId }
  if (target.kind === 'group') return { section: 'group', group: target.id }
  return null
}

/** A sidebar thread row's place: a group opens its chat, a run opens the main conversation, and a task with no run opens the task. */
export function threadPlace(work: { kind?: 'run' | 'chat'; id: string; issueId: string | null; runs: readonly { id: string }[] }): Partial<WorkspaceLocation> {
  if (work.kind === 'chat') return { section: 'group', group: work.id }
  if (!work.kind && work.issueId === work.id && !work.runs.length) return { task: work.issueId }
  return { section: 'coordinator', mainThread: work.kind ? work.id : work.runs[0]?.id ?? work.id }
}

/** The address of a place in this app, as a link to copy or open. */
export function placeLink(place: Partial<WorkspaceLocation>) {
  const url = new URL(window.location.href)
  url.search = workspaceSearch(place)
  url.hash = ''
  return url.href
}

/** Opens a place in a new browser tab, as a task's 在新标签页中打开 does (issue-detail-actions.tsx). */
export function openPlaceInNewTab(place: Partial<WorkspaceLocation> | null) {
  if (place) window.open(placeLink(place), '_blank', 'noopener,noreferrer')
}

/** Opens the chat in a new browser tab. */
export function openChatInNewTab(target: ChatTarget) {
  openPlaceInNewTab(chatPlace(target))
}

/** 复制链接: the place's address on the clipboard. Rejects when the browser refuses the clipboard. */
export async function copyPlaceLink(place: Partial<WorkspaceLocation> | null) {
  if (!place) throw new ChatRowActionError(0)
  await navigator.clipboard.writeText(placeLink(place))
}

export class ChatRowActionError extends Error {
  constructor(readonly status: number) { super(`chat row action failed: ${status}`) }
}

async function send(path: string, method: 'PATCH' | 'POST', body: unknown) {
  const response = await fetch(withBasePath(path), { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!response.ok) throw new ChatRowActionError(response.status)
}

/**
 * 标为未读 / 标为已读 through the writers the chats already have: the person's own mark
 * (lib/chat-preferences.ts, PATCH /api/mobile/bots|groups/<id>) and the read position
 * (POST /api/conversations/<id>/read). Each writer pushes the list change itself.
 */
export async function setChatUnread(chat: { kind: 'bot'; botId: string; latestMessageId?: string } | { kind: 'group'; id: string; latestMessageId?: string }, unread: boolean) {
  const path = chat.kind === 'bot' ? `/api/mobile/bots/${encodeURIComponent(chat.botId)}` : `/api/mobile/groups/${encodeURIComponent(chat.id)}`
  if (unread) return send(path, 'PATCH', { markedUnread: true })
  // Reading up to the latest message also clears a manual mark; a chat with no message only has the mark.
  if (!chat.latestMessageId) return send(path, 'PATCH', { markedUnread: false })
  const conversation = chat.kind === 'bot' ? `bot:${chat.botId}` : chat.id
  return send(`/api/conversations/${encodeURIComponent(conversation)}/read`, 'POST', { messageId: chat.latestMessageId })
}

/** The person's own 置顶 / 通知 / 隐藏 for a chat, through the chat preference writer (lib/chat-preferences.ts). */
export async function setChatPreference(chat: { kind: 'bot'; botId: string } | { kind: 'group'; id: string }, change: { pinned?: boolean; muted?: boolean; hidden?: boolean }) {
  return send(chat.kind === 'bot' ? `/api/mobile/bots/${encodeURIComponent(chat.botId)}` : `/api/mobile/groups/${encodeURIComponent(chat.id)}`, 'PATCH', change)
}

/** A thread row's 标为已读 / 标为未读 through the thread read writer (lib/thread-reads.ts): a run reads up to its latest activity. */
export async function setThreadUnread(work: { kind?: 'run' | 'chat'; id: string }, unread: boolean) {
  const change = work.kind === 'chat'
    ? { action: unread ? 'unread' : 'read', chatId: work.id }
    : unread ? { action: 'unread', runId: work.id } : { action: 'readLatest', runId: work.id }
  return send('/api/conversations/read-state', 'POST', change)
}
