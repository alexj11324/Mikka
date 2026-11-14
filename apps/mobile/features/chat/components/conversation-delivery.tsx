import { useCallback, useEffect, useLayoutEffect, useSyncExternalStore, type SetStateAction } from 'react'
import { uuid } from 'expo'
import { CryptoDigestAlgorithm, digest } from 'expo-crypto'
import { MyBubble, OutgoingBubble } from '@/components/chat'
import { api, apiConnection, ApiError } from '@/lib/api'
import { apiCache } from '@/lib/api-cache'
import { useHome } from '@/lib/home'
import { sendFailureState } from '@/lib/outbox'
import { conversationJournal } from '@/lib/config'
import { mobileMessages as copy } from '@/lib/messages'
import { sameConversationCommand, submitConversation, type ConversationCommand, type ConversationTarget } from '@/lib/conversation-submission'
import { groupSubmissionMessageId } from '../../../../../lib/group-submission'
import { useChatDeliveryState, type ChatDelivery } from '../../../../../lib/hooks/chat-delivery-state'

type Row = ChatDelivery<ConversationCommand>
const empty: Row[] = []
const uncertain = copy.Coordinator.sendUncertain
const listeners = new Set<() => void>()
function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function conversationAccessDenied(error: unknown) {
  return error instanceof ApiError && [401, 403, 404].includes(error.status)
}

/** Native screens use the same delivery transitions as Web, with the signed-in account's existing cache. */
export function useConversationDelivery(target: ConversationTarget | null, received: readonly string[], reload: () => Promise<void>, revokedGroupId?: string) {
  const home = useHome().data
  const owner = home?.user.id
  const workspace = home?.workspace.id
  const context = apiCache.context()
  const scope = revokedGroupId ? { kind: 'group' as const, id: revokedGroupId } : target
  const kind = scope?.kind === 'thread' && scope.issueId ? 'task' : scope?.kind
  const id = scope?.kind === 'thread' ? scope.issueId ?? scope.id : scope?.id
  const key = JSON.stringify(['conversation-send', owner, workspace, kind, id])
  const revision = apiCache.revision(key)
  const current = useCallback(() => apiCache.context() === context && apiCache.revision(key) === revision, [context, key, revision])
  useLayoutEffect(() => {
    if (!revokedGroupId || !owner || !workspace || apiCache.context() !== context) return
    apiCache.revoke(key, context, new Error('conversationAccessDenied'))
    try { conversationJournal.forget(key) } catch { /* Retry the scoped deletion before restoring a durable queue. */ }
    for (const listener of listeners) listener()
  }, [context, key, owner, workspace, revokedGroupId])
  const authorized = Boolean(owner && workspace && target)
  const read = useCallback(() => {
    if (!authorized || !current()) return empty
    if (apiCache.denial(key)) {
      try { conversationJournal.forget(key) } catch { return empty }
      // The server has authorized the group again. Start its queue afresh.
      apiCache.storeRead(key, empty, context)
    }
    const cached = apiCache.get<Row[]>(key)
    if (cached) return cached
    let saved: Row[] = empty
    try { saved = conversationJournal.read(key).map(row => ({ ...row, phase: 'failed', error: uncertain })) } catch { /* A write will check durable storage before transport. */ }
    apiCache.set(key, saved, context)
    return saved
  }, [authorized, context, key, current])
  const rows = useSyncExternalStore(subscribe, read, () => empty)
  const update = useCallback((next: SetStateAction<Row[]>) => {
    apiCache.commit(context, () => {
      if (!current()) return
      apiCache.set(key, typeof next === 'function' ? next(read()) : next, context)
      for (const listener of listeners) listener()
    })
  }, [context, key, read, current])
  const journal = useChatDeliveryState(rows, update, uncertain)
  const visible = rows.filter(row => !received.includes(row.storedId ?? row.id))
  useEffect(() => {
    const shown = rows.filter(row => received.includes(row.storedId ?? row.id))
    if (shown.length) {
      try { conversationJournal.forget(key, shown.map(row => row.id)) } catch { /* Readback remains authoritative. */ }
      update(current => current.filter(row => !received.includes(row.storedId ?? row.id)))
    }
  }, [rows, received, update, key])

  async function deliver(command: ConversationCommand) {
    if (!target || owner !== command.expectedOwnerId || workspace !== command.expectedWorkspaceId ||
        !current() || !journal.begin(command)) return
    const connection = apiConnection()
    try {
      const storedId = command.target.kind === 'group'
        ? await groupSubmissionMessageId(command.expectedOwnerId, command.target.id, command.id, data => digest(CryptoDigestAlgorithm.SHA256, data))
        : command.id
      if (!current()) throw new Error('submissionUnconfirmed')
      update(current => current.map(row => row.id === command.id ? { ...row, storedId } : row))
      try { conversationJournal.remember(key, { ...command, storedId }) }
      catch { journal.finish(command.id, { error: copy.Workspace.detail.autosaveFailed }); return }
      await submitConversation(command, (path, init) => api(path, init, connection), storedId)
      journal.finish(command.id, { storedId })
      if (current()) {
        try { conversationJournal.forget(key, [command.id]) } catch { /* The next authorized read also retires this ID. */ }
      }
    } catch (failure) {
      const error = failure as { code?: string; status?: number } | null
      const messages: Record<string, string> = copy.Errors
      const line = sendFailureState(error) === 'unconfirmed' ? uncertain : error?.status === 429 ? copy.Coordinator.sendRateLimited
        : error?.status && [401, 403, 404].includes(error.status) ? copy.Coordinator.sendAccessDenied : messages[error?.code ?? ''] ?? copy.GroupChat.notSent
      journal.finish(command.id, { error: line })
      return
    }
    if (current()) void reload().catch(() => undefined)
  }

  function send(text: string, mentions: ConversationCommand['mentions'] = []) {
    if (!target || !owner || !workspace || !current() || apiCache.denial(key) || !text.trim()) return false
    const previous = read().find(row => row.phase === 'failed' && sameConversationCommand(row, target, text, mentions))
    void deliver(previous ?? { target, id: uuid.v4(), text, at: Date.now(), expectedOwnerId: owner, expectedWorkspaceId: workspace, mentions })
    return true
  }

  return { send, bubbles: visible.map(row => row.phase === 'accepted'
    ? <MyBubble key={row.id} text={row.text} />
    : <OutgoingBubble key={row.id} text={row.text} failed={row.phase === 'failed'} unconfirmed={row.error === uncertain}
        error={row.error === uncertain ? undefined : row.error} onRetry={() => void deliver(row)} />) }
}
