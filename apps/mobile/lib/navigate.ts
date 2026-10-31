import { router, type Href } from 'expo-router'

/** A chat's path: the Coordinator's or a bot's. */
export const chatPath = (botId: string | null) => `/bots/${botId ?? 'coordinator'}`

/**
 * Opens a chat over 对话, from anywhere (a push, 新线程, a 建议 item): the stack
 * starts over at the bot list, so Back and the edge swipe return there and
 * never to a screen the person had left.
 */
export function openChat(href: Href) {
  if (router.canDismiss()) router.dismissAll()
  router.navigate('/chats')
  router.push(href)
}

/** Where a tapped push opens (lib/push-route.ts): a thread is pushed over what is open; a chat opens over 对话. */
export function openPush(href: string) {
  if (href.startsWith('/thread/')) router.push(href as Href)
  else openChat(href as Href)
}
