import { router, type Href } from 'expo-router'

/**
 * Goes to a drawer screen (a chat, 建议, 线程, 任务), starting the stack over
 * there, as picking a chat does in ChatGPT and Claude: Back and the edge swipe
 * never lead to a screen the person already left through the drawer. Closes
 * 设置 too when it is open.
 */
export function switchTo(href: Href) {
  if (router.canDismiss()) router.dismissAll()
  router.replace(href)
}

/** Where a tapped push opens (lib/push-route.ts): a thread is pushed over the chat; a chat becomes the screen. */
export function openPush(href: string) {
  if (href.startsWith('/threads/')) router.push(href as Href)
  else switchTo(href as Href)
}
