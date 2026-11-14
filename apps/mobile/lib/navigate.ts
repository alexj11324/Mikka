import { router, type Href } from 'expo-router'
import { api, apiConnection, ApiError, saveWorkspace, savedWorkspace } from './api'
import { apiCache } from './api-cache'
import { currentAccount } from './config'
import { showSystemAlert } from './system-alert'
import { mobileMessages } from './messages'

/** A chat's path: the Coordinator's or a bot's. */
export const chatPath = (botId: string | null) => `/bots/${botId ?? 'coordinator'}`

/**
 * Opens a chat over the home screen, from anywhere (a push, 新线程, a 建议 item): the stack
 * starts over at the chat list, so Back and the edge swipe return there and
 * never to a screen the person had left.
 */
export function openChat(href: Href) {
  if (router.canDismiss()) router.dismissAll()
  router.navigate('/')
  router.push(href)
}

/** Where a tapped push opens (lib/push-route.ts): a task or a thread is pushed over what is open; a chat opens over the home screen. */
export async function openPush(href: string) {
  if (href.startsWith('/thread/') || href.startsWith('/task/')) {
    router.push(href as Href)
    return
  }
  const botId = href.split('?')[0].slice('/bots/'.length)
  // Old notifications carried no bot id for the Coordinator.
  if (botId === 'coordinator') { openChat(href as Href); return }
  const connection = apiConnection()
  const context = apiCache.context()
  const signedIn = () => Boolean(connection.account.user && currentAccount().id === connection.account.id
    && currentAccount().user?.id === connection.account.user.id)
  if (!signedIn()) return
  try {
    const source = await api<{ botId: string; workspaceId: string }>(`/api/mobile/bots/${botId}?view=notification`, {}, connection)
    if (context !== apiCache.context() || !signedIn()) return
    // Before the notification view shipped, a successful bot-page read already
    // required the exact bot, signed-in owner and selected workspace.
    if (source.botId && source.botId !== botId) throw new ApiError(404, 'botNotFound')
    if (source.workspaceId && await savedWorkspace(connection.account) !== source.workspaceId) {
      if (context !== apiCache.context() || !signedIn()) return
      await saveWorkspace(source.workspaceId)
    }
    if (signedIn()) openChat(href as Href)
  } catch (error) {
    if (context !== apiCache.context() || !signedIn() || (error instanceof ApiError && error.status === 401)) return
    showSystemAlert(error instanceof ApiError && [403, 404].includes(error.status)
      ? mobileMessages.Errors.botNotFound : mobileMessages.AgentCopy.requestFailedPleaseTryAgain)
  }
}
