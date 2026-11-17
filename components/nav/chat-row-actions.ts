import { withBasePath } from '@/lib/base-path'
import { workspaceSearch, type WorkspaceLocation } from '@/components/workspace/workspace-navigation'
import type { ChatTarget } from './bot-list'

/**
 * A sidebar row's right-click menu (Capy's Captain row): what the frame lists for one Bot or group chat.
 * `id` lets the frame pick the item's icon; `label` is already in the person's language.
 */
export type ChatNavAction = { id: 'openNewTab' | 'markRead' | 'markUnread' | 'viewAll' | 'leave'; label: string; danger?: boolean; run: () => void }

/** The place a chat opens at, as an address (the same one the row opens). */
export function chatPlace(target: ChatTarget): Partial<WorkspaceLocation> | null {
  if (target.kind === 'coordinator') return { section: 'coordinator' }
  if (target.kind === 'bot') return { section: 'coordinator', bot: target.botId }
  if (target.kind === 'group') return { section: 'group', group: target.id }
  return null
}

/** Opens the chat in a new browser tab, as a task's 在新标签页中打开 does (issue-detail-actions.tsx). */
export function openChatInNewTab(target: ChatTarget) {
  const place = chatPlace(target)
  if (!place) return
  const url = new URL(window.location.href)
  url.search = workspaceSearch(place)
  window.open(url.href, '_blank', 'noopener,noreferrer')
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
