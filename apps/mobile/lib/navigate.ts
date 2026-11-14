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

// The newest tap owns navigation. A later tap only waits for a workspace
// preference write already in flight, never for a previous bot lookup.
let latestPush = 0
let savingWorkspace = Promise.resolve()

/** A task or thread opens over the current screen. A chat opens over home. */
export async function openPush(href: string) {
  const tap = ++latestPush
  const connection = apiConnection()
  const current = () => tap === latestPush && Boolean(connection.account.user) && currentAccount() === connection.account
  await savingWorkspace
  if (!current()) return
  if (href.startsWith('/thread/') || href.startsWith('/task/')) {
    router.push(href as Href)
    return
  }
  const botId = href.split('?')[0].slice('/bots/'.length)
  // Historical notifications carried no bot id for the Coordinator.
  if (botId === 'coordinator') { openChat(href as Href); return }
  const context = apiCache.context()
  try {
    const source = await api<{ botId: string; workspaceId: string } | { threads: unknown[] }>(
      `/api/mobile/bots/${botId}?view=notification`, {}, connection)
    if (context !== apiCache.context() || !current()) return
    if ('botId' in source) {
      if (source.botId !== botId || !source.workspaceId) throw new ApiError(404, 'botNotFound')
      const selected = await savedWorkspace(connection.account)
      if (context !== apiCache.context() || !current()) return
      if (selected !== source.workspaceId) {
        const write = saveWorkspace(source.workspaceId)
        savingWorkspace = write.catch(() => {})
        await write
      }
    } else if (!Array.isArray(source.threads)) {
      // Old servers returned their bot page only for the exact bot owned in
      // the current workspace; its threads array is present even when empty.
      throw new ApiError(404, 'botNotFound')
    }
    if (current()) openChat(href as Href)
  } catch (error) {
    if (context !== apiCache.context() || !current() || (error instanceof ApiError && error.status === 401)) return
    showSystemAlert(error instanceof ApiError && [403, 404].includes(error.status)
      ? mobileMessages.Errors.botNotFound : mobileMessages.AgentCopy.requestFailedPleaseTryAgain)
  }
}
