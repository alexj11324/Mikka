import { useCallback, useEffect, useSyncExternalStore, type SetStateAction } from 'react'
import { uuid } from 'expo'
import { CryptoDigestAlgorithm, digest } from 'expo-crypto'
import { MyBubble, OutgoingBubble } from '@/components/chat'
import { api, apiConnection, ApiError } from '@/lib/api'
import { apiCache } from '@/lib/api-cache'
import { useHome } from '@/lib/home'
import { sendFailureState } from '@/lib/outbox'
import { threadSendErrorLine } from '@/lib/thread-send-error'
import { submitConversation, type ConversationCommand, type ConversationTarget } from '@/lib/conversation-submission'
import { groupSubmissionMessageId } from '../../../../../lib/group-submission'
import { useChatDeliveryState, type ChatDelivery } from '../../../../../lib/hooks/chat-delivery-state'

type Row = ChatDelivery<ConversationCommand>
const empty: Row[] = []
const uncertain = '发送未确认'
const listeners = new Set<() => void>()
function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function conversationAccessDenied(error: unknown) {
  return error instanceof ApiError && [401, 403, 404].includes(error.status)
}

/** Native screens use the same delivery transitions as Web, with the signed-in account's existing cache. */
export function useConversationDelivery(target: ConversationTarget | null, received: readonly string[], reload: () => Promise<void>) {
  const home = useHome().data
  const owner = home?.user.id
  const workspace = home?.workspace.id
  const context = apiCache.context()
  const key = JSON.stringify(['conversation-send', owner, workspace, target?.kind,
    target?.kind === 'thread' ? target.issueId ?? target.id : target?.id])
  const read = useCallback(() => apiCache.context() === context ? apiCache.get<Row[]>(key) ?? empty : empty, [context, key])
  const rows = useSyncExternalStore(subscribe, read, () => empty)
  const update = useCallback((next: SetStateAction<Row[]>) => {
    apiCache.commit(context, () => {
      apiCache.set(key, typeof next === 'function' ? next(read()) : next, context)
      for (const listener of listeners) listener()
    })
  }, [context, key, read])
  const journal = useChatDeliveryState(rows, update, uncertain)
  const visible = rows.filter(row => !received.includes(row.storedId ?? row.id))
  useEffect(() => {
    if (rows.some(row => received.includes(row.storedId ?? row.id))) {
      update(current => current.filter(row => !received.includes(row.storedId ?? row.id)))
    }
  }, [rows, received, update])

  async function deliver(command: ConversationCommand) {
    if (!target || owner !== command.expectedOwnerId || workspace !== command.expectedWorkspaceId ||
        apiCache.context() !== context || !journal.begin(command)) return
    const connection = apiConnection()
    try {
      const storedId = command.target.kind === 'group'
        ? await groupSubmissionMessageId(command.expectedOwnerId, command.target.id, command.id, data => digest(CryptoDigestAlgorithm.SHA256, data))
        : command.id
      if (apiCache.context() !== context) throw new Error('submissionUnconfirmed')
      update(current => current.map(row => row.id === command.id ? { ...row, storedId } : row))
      await submitConversation(command, (path, init) => api(path, init, connection), storedId)
      journal.finish(command.id, { storedId })
    } catch (failure) {
      const error = failure as { code?: string; status?: number } | null
      const line = sendFailureState(error) === 'unconfirmed' ? uncertain : error?.status === 429 ? '发送过于频繁，请稍后重试。'
        : error?.status && [401, 403, 404].includes(error.status) ? '此会话已无法访问。' : threadSendErrorLine(error?.code ?? null)
      journal.finish(command.id, { error: line })
      return
    }
    if (apiCache.context() === context) void reload().catch(() => undefined)
  }

  function send(text: string, mentions: ConversationCommand['mentions'] = []) {
    if (!target || !owner || !workspace || !text.trim()) return false
    const previous = read().find(row => row.phase !== 'accepted' && row.text === text)
    void deliver(previous ?? { target, id: uuid.v4(), text, at: Date.now(), expectedOwnerId: owner, expectedWorkspaceId: workspace, mentions })
    return true
  }

  return { send, bubbles: visible.map(row => row.phase === 'accepted'
    ? <MyBubble key={row.id} text={row.text} />
    : <OutgoingBubble key={row.id} text={row.text} failed={row.phase === 'failed'} unconfirmed={row.error === uncertain}
        error={row.error === uncertain ? undefined : row.error} onRetry={() => void deliver(row)} />) }
}
