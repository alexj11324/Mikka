import { Link, type useRouter } from 'expo-router'
import type { HomeChat, useHomeChats } from '../model/use-home-chats'
import { unreadOf } from '../model/home-list'

type Router = ReturnType<typeof useRouter>

type Actions = Pick<ReturnType<typeof useHomeChats>, 'togglePin' | 'setHidden' | 'setUnread' | 'copyId' | 'pinsFull'>

/**
 * A home chat's long-press menu, the system's context menu over its live preview: 标为已读 / 未读, 置顶, 隐藏, 信息,
 * and 更多 › 复制 ID. 信息 is a bot's page; a group chat has no page of its own, so it has no 信息. Mikka has no
 * 复制一个 or 删除 for a chat, so the menu has neither.
 *
 * A plain function, not a component: a Link keeps only its own element types (Trigger, Preview, Menu) as children.
 */
export function chatMenu(chat: HomeChat, actions: Actions, router: Router) {
  const unread = unreadOf(chat) > 0
  return (
    <Link.Menu>
      <Link.MenuAction icon={unread ? 'envelope.open' : 'envelope.badge'} onPress={() => void actions.setUnread(chat, !unread)}>
        {unread ? '标为已读' : '标为未读'}
      </Link.MenuAction>
      <Link.MenuAction icon={chat.pinned ? 'pin.slash' : 'pin'} disabled={!chat.pinned && actions.pinsFull} onPress={() => void actions.togglePin(chat, false)}>
        {chat.pinned ? '取消置顶' : '置顶'}
      </Link.MenuAction>
      <Link.MenuAction icon="eye.slash" onPress={() => void actions.setHidden(chat, true)}>隐藏</Link.MenuAction>
      {chat.row.kind === 'bot' ? (
        <Link.MenuAction icon="info.circle" onPress={() => router.push({ pathname: '/bots/[id]/info', params: { id: chat.row.kind === 'bot' && chat.row.bot.coordinator ? 'coordinator' : chat.key } })}>信息</Link.MenuAction>
      ) : null}
      <Link.Menu icon="ellipsis" title="更多">
        <Link.MenuAction icon="doc.on.doc" onPress={() => actions.copyId(chat)}>复制 ID</Link.MenuAction>
      </Link.Menu>
    </Link.Menu>
  )
}
