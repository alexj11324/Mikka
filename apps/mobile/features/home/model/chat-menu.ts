/**
 * The row's context menu (#1408), mapped onto Mikka. Groups have no pin and no 资料 page.
 * Hide, duplicate and delete are not menu entries: Mikka has no such action for a chat.
 */

export type ChatMenuAction = 'read' | 'unread' | 'pin' | 'unpin' | 'info' | 'copy-id'

export function chatMenu(row: { kind: 'bot' | 'group'; pinned: boolean; unread: number }): ChatMenuAction[] {
  const read: ChatMenuAction = row.unread > 0 ? 'read' : 'unread'
  if (row.kind === 'group') return [read, 'copy-id']
  return [read, row.pinned ? 'unpin' : 'pin', 'info', 'copy-id']
}

export function menuLabel(action: ChatMenuAction): string {
  switch (action) {
    case 'read': return '标为已读'
    case 'unread': return '标为未读'
    case 'pin': return '置顶'
    case 'unpin': return '取消置顶'
    case 'info': return '资料'
    case 'copy-id': return '复制 ID'
  }
}
