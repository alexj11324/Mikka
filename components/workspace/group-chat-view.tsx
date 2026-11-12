'use client'

import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import useSWRInfinite, { unstable_serialize as infiniteKey } from 'swr/infinite'
import useSWR, { unstable_serialize } from 'swr'
import { useTranslations } from 'next-intl'
import { listAgents } from '@/app/actions/agents'
import { ChatComposer } from '@/components/coordinator/chat-composer'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { CHAT_SURFACE, ChatMessage } from '@ui-slot/chat-message'
import { Button } from '@/components/ui/button'
import { GroupLeaveAction } from './group-leave-action'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { ConversationPill } from '@/components/nav/conversation-pill'
import { GroupAvatar, groupMembersKey, memberAvatar, useGroupMembers } from '@/components/nav/group-avatar'
import { useLiveKey } from '@/hooks/use-live-key'
import { LetterAvatar } from '@/components/nav/letter-avatar'
import { BotAvatar } from '@/components/nav/bot-avatar'
import { UserMessageText } from '@/components/workspace/user-message-text'
import { CollapsibleMessage } from '@/components/chat/collapsible-message'
import { AgentMarkdown } from '@/components/workspace/agent-markdown'
import { MessageReactions, useMessageReactions } from '@/components/workspace/message-reactions'
import { cn } from '@/lib/utils'
import { mentionsIn } from '@/lib/group-mentions'
import { authorRuns, chronological, fetchGroupMessages, mergeGroupPoll, mayLeaveGroup, newestGroupPosition, GroupMessagesRequestError, postGroupMessage, stopGroupReply, type GroupMessagePage } from '@/lib/group-messages'
import { toast } from 'sonner'
import { useViewScroll, useViewState } from '@/lib/hooks/view-state'
import { useChatDelivery, type ChatSubmission } from '@/lib/hooks/chat-delivery'
import { checkPageBuildBeforeAction } from '@/lib/app-build'
import { groupSubmissionMessageId } from '@/lib/group-submission'
import { useActionError } from '@/lib/use-action-error'
import { readAccessFailure } from '@/lib/swr/persistent-cache'

/** A message the person sent that the server has not stored yet; a failed one waits for 重试. */
type GroupSend = ChatSubmission & { mentions: ReturnType<typeof mentionsIn> }

/** The newest page and the members re-read on the group's live key, at most this often while a reply streams in. */
const GROUP_MERGE_MS = 500

/** The newest page's key, then each older page before the last one shown. */
const pageKey = (groupId: string) => (index: number, previous: GroupMessagePage | null) => index === 0 ? ['group-messages', groupId, null] : previous?.nextBefore ? ['group-messages', groupId, previous.nextBefore] : null

export type GroupChatRequest = { id: string; title: string; workspaceId: string }

/**
 * A group chat. It reads and sends through the group API (the phone's path),
 * which checks workspace and group membership on every request. A message goes
 * to the bots it @mentions, else to the ones the server judges should answer;
 * it shows at once and, if it fails, stays with 重试. A stored message, a
 * member change or the reply starting or ending pushes the group's key; no
 * timer reads it (#1212). Names and bot avatars come from the
 * group's member list, then the workspace's members and the person's agents.
 */
export function GroupChatView({ group, userId, people, onLeft }: {
  group: GroupChatRequest
  onLeft?: (id: string) => void
  userId: string
  /** Display names of the group's workspace members, when that workspace is the loaded one. */
  people: Map<string, string>
}) {
  const t = useTranslations('GroupChat')
  const feedback = useTranslations('Coordinator')
  const { data: agents = [] } = useSWR('agents', listAgents)
  // The pill's avatar is the members' bloubs (R-36); the right column's 详情 reads the same request.
  const { data: members = [] } = useGroupMembers(group.id)
  const member = (type: 'user' | 'agent' | 'bot', id: string) => members.find(item => item.memberType === type && item.id === id)
  const [draft, setDraft] = useViewState(`group:${group.id}:draft`, '')
  // Navigation keeps unsent text and the same in-flight promise's result; it never resends.
  const delivery = useChatDelivery<GroupSend>(`group:${userId}:${group.workspaceId}:${group.id}`, feedback('sendUncertain'))
  const submittedDraft = useRef<string | null>(null)
  const [accessRejected, setAccessRejected] = useState(false)
  const departed = useRef(false)
  const shown = useRef<{ id: string; page: GroupMessagePage } | null>(null)
  const { data: pages, error, size, setSize, isValidating, mutate } = useSWRInfinite<GroupMessagePage>(
    pageKey(group.id),
    async ([, id, before]: [string, string, string | null]) => {
      if (before) return fetchGroupMessages(id, before)
      const known = shown.current?.id === id ? shown.current.page : null
      const after = known ? newestGroupPosition(known.messages) : null
      const page = await fetchGroupMessages(id, null, fetch, after)
      const merged = mergeGroupPoll(known, page)
      shown.current = { id, page: merged }
      return merged
    },
    // The first page carries new messages and who is answering; it is read again when the group's key arrives.
    { revalidateOnFocus: false },
  )
  // While the live channel is down, the live layer falls back to one read a minute.
  // Only the pages hold the group's revision (its newest page); the members always read.
  const pagesKey = infiniteKey(pageKey(group.id))
  useLiveKey('group_chat', group.id, [pagesKey, unstable_serialize(groupMembersKey(group.id))], group.workspaceId, { minIntervalMs: GROUP_MERGE_MS, revisions: { [pagesKey]: pages?.[0]?.revision } })
  const messages = useMemo(() => pages ? chronological(pages) : [], [pages])
  const receivedIds = useMemo(() => new Set(messages.map(message => message.id)), [messages])
  useEffect(() => {
    if (delivery.rows.some(row => row.storedId && receivedIds.has(row.storedId))) delivery.setRows(current => current.filter(row => !row.storedId || !receivedIds.has(row.storedId)))
  }, [delivery.rows, delivery.setRows, receivedIds])
  const reactions = useMessageReactions(messages.map(message => message.id))
  const older = pages?.at(-1)?.nextBefore ?? null
  const loadingOlder = isValidating && !!pages && size > pages.length
  const code = error instanceof GroupMessagesRequestError ? error.code : error ? 'unavailable' : null
  const refused = !!readAccessFailure(error)
  // A transport failure cannot restore access after a refusal. A successful
  // deduplicated read clears SWR's error even if its original view unmounted.
  useEffect(() => {
    if (refused) setAccessRejected(true)
    else if (!error) setAccessRejected(false)
  }, [refused, error])
  const backgroundFailed = !!pages && code === 'unavailable' && !refused && !accessRejected
  const blockingCode = backgroundFailed ? null : code
  // A failed background read leaves the transcript and composer in place.
  // Keep its retry outside document flow so reading history does not jump.
  useEffect(() => {
    const id = `group-read-error:${userId}:${group.id}`
    if (backgroundFailed) toast.error(t('loadError'), { id, duration: Infinity, action: { label: t('retry'), onClick: event => { event.preventDefault(); void mutate() } } })
    else toast.dismiss(id)
    return () => { toast.dismiss(id) }
  }, [backgroundFailed, userId, group.id, t, mutate])
  const deliver = async (item: GroupSend, release?: () => void) => {
    if (departed.current || blockingCode || accessRejected || refused || !delivery.begin(item)) return
    release?.()
    try {
      if (navigator.onLine === false) { delivery.finish(item.id, { error: feedback('sendOffline') }); return }
      if (!await checkPageBuildBeforeAction()) { delivery.finish(item.id, { error: feedback('sendUpdateRequired') }); return }
      if (departed.current) { delivery.finish(item.id, {}); return }
      void groupSubmissionMessageId(userId, group.id, item.id).then(storedId => {
        delivery.setRows(current => current.map(row => row.id === item.id && !row.storedId ? { ...row, storedId } : row))
      }).catch(() => undefined)
      const sent = await postGroupMessage(group.id, item.text, item.mentions, fetch, { requestId: item.id, expectedOwnerId: userId, expectedWorkspaceId: group.workspaceId })
      delivery.finish(item.id, { storedId: sent.id })
      if (!departed.current) void mutate().catch(() => undefined)
    } catch (error) {
      const status = error instanceof GroupMessagesRequestError ? error.status : undefined
      const reason = status === 429 ? feedback('sendRateLimited') : status && [401, 403, 404].includes(status) ? feedback('sendAccessDenied')
        : status && status < 500 ? t('notSent') : feedback('sendUncertain')
      delivery.finish(item.id, { error: reason })
    }
  }
  const send = () => {
    const text = draft.trim()
    if (!text || submittedDraft.current === draft) return
    void deliver({ id: crypto.randomUUID(), at: Date.now(), text, mentions: mentionsIn(text, members) }, () => {
      submittedDraft.current = draft
      setDraft('')
    })
  }
  const first = pages?.[0]
  // 停止: the reply ends on the server; the button waits until the group stops answering.
  const actionError = useActionError()
  const [stopping, setStopping] = useState(false)
  const replying = !!first?.agentStatus
  useEffect(() => { if (!replying) setStopping(false) }, [replying])
  const stop = async () => {
    setStopping(true)
    try { await stopGroupReply(group.id) } catch { setStopping(false); toast.error(actionError()) }
    await mutate()
  }
  const unsent = delivery.rows.filter(item => !item.storedId || !receivedIds.has(item.storedId))
  // The newest message, a sent one or a bot answering keeps the chat at its end; loading older ones does not move it.
  const [following, setFollowing] = useViewState(`group:${group.id}:following`, true)
  const scroller = useViewScroll<HTMLDivElement>(`group:${group.id}:messages`, !!pages)
  const end = `${messages.at(-1)?.id}:${unsent.length}:${!!first?.agentStatus}`
  useEffect(() => { if (following) scroller.current?.scrollTo({ top: scroller.current.scrollHeight }) }, [end, following, scroller])
  const authorName = (type: 'user' | 'agent' | 'bot', id: string) => type === 'user'
    ? id === userId ? t('you') : member(type, id)?.name || people.get(id) || t('member')
    : member(type, id)?.name ?? (type === 'agent' ? agents.find(agent => agent.id === id)?.name : undefined) ?? t('bot')

  // Whom the person's messages go to, for the chat-message slot: the group.
  const speaker = { id: group.id, name: group.title || t('untitled') }

  return <section aria-label={group.title || t('untitled')} data-testid="group-chat" className={cn('relative flex min-h-0 w-full flex-1 flex-col', CHAT_SURFACE)}>
    <ConversationPill name={group.title || t('untitled')} avatar={<GroupAvatar title={group.title || t('untitled')} members={members} />} />
    {onLeft && !refused && !accessRejected && mayLeaveGroup(members, userId)
      ? <div className="flex h-14 shrink-0 items-center justify-end px-4">
          <GroupLeaveAction group={group} userId={userId} onLeft={() => {
            departed.current = true
            shown.current = null
            delivery.setRows([])
            setDraft('')
            onLeft(group.id)
          }} />
        </div>
      : <div aria-hidden="true" className="hidden h-14 shrink-0 md:block" />}
    <div ref={scroller} onScroll={event => { const node = event.currentTarget; const next = node.scrollHeight - node.scrollTop - node.clientHeight < 56; if (next !== following) setFollowing(next) }} className="min-h-0 flex-1 overflow-y-auto scroll-fade-y">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 pb-6">
        {blockingCode === 'not_found' ? <p role="alert" className="py-6 text-sm">{t('notFound')}</p>
          : blockingCode ? <div role="alert" className="flex items-center gap-3 py-6 text-sm"><span>{blockingCode === 'unauthorized' ? t('authRequired') : t('loadError')}</span>{blockingCode !== 'unauthorized' && <Button variant="outline" size="sm" onClick={() => { void mutate() }}>{t('retry')}</Button>}</div>
            : !pages ? <div aria-busy="true" className="flex flex-col gap-3 py-4"><Skeleton className="h-9 w-2/3" /><Skeleton className="ml-auto h-9 w-1/2" /><Skeleton className="h-9 w-3/5" /></div>
              : messages.length === 0 && !unsent.length ? <p className="py-6 text-sm text-muted-foreground">{t('empty')}</p>
                : <>
                  {older && <Button variant="ghost" size="sm" className="self-center text-muted-foreground" disabled={loadingOlder} onClick={() => { void setSize(size + 1) }}>{loadingOlder && <Spinner data-icon="inline-start" role="presentation" aria-hidden="true" />}{loadingOlder ? t('loadingOlder') : t('older')}</Button>}
                  <ol aria-label={t('messages')} className="flex flex-col gap-4">
                    {authorRuns(messages).map(run => {
                      const mine = run.authorType === 'user' && run.authorId === userId
                      const name = authorName(run.authorType, run.authorId)
                      const bot = run.authorType === 'bot' ? member('bot', run.authorId) : undefined
                      return <li key={run.key} className={cn('flex', mine ? 'flex-col items-end gap-1' : 'items-end gap-2')}>
                        {!mine && (bot ? <BotAvatar {...memberAvatar(bot)} size="message" still /> : <LetterAvatar name={name} size="message" />)}
                        <div className={cn('flex min-w-0 flex-col gap-1', mine ? 'max-w-[min(26rem,80%)] items-end' : 'max-w-[min(35rem,85%)]')}>
                          {mine ? <span className="sr-only">{name}</span> : <span className="text-xs font-medium text-muted-foreground">{name}</span>}
                          {/* The person's own words are drawn by the chat-message slot, as in a 1:1 chat. */}
                          {run.messages.map(message => mine
                            ? <ChatMessage key={message.id} from="person" speaker={speaker} body={<CollapsibleMessage><UserMessageText text={message.body} /></CollapsibleMessage>} after={<MessageReactions reactions={reactions[message.id]} align="end" />} />
                            : <Fragment key={message.id}>
                              <Bubble variant="muted" align="start" className="max-w-full">
                                <BubbleContent className="rounded-2xl px-4 py-3 whitespace-pre-wrap">{run.authorType === 'user' ? <CollapsibleMessage><UserMessageText text={message.body} /></CollapsibleMessage> : <AgentMarkdown text={message.body} />}</BubbleContent>
                              </Bubble>
                              <MessageReactions reactions={reactions[message.id]} align="start" />
                            </Fragment>)}
                        </div>
                      </li>
                    })}
                    {unsent.map(item => <li key={item.id} data-pending={item.phase} className={cn('flex flex-col items-end gap-1', item.phase === 'sending' && 'opacity-60')}>
                      <ChatMessage from="person" speaker={speaker} body={<CollapsibleMessage><UserMessageText text={item.text} /></CollapsibleMessage>} />
                      {item.phase === 'failed' && <span role="alert" className="flex items-center gap-2 text-xs text-destructive-foreground">{item.error}<Button variant="ghost" size="xs" onClick={() => { void deliver(item) }}>{t('retry')}</Button></span>}
                    </li>)}
                    {first?.agentStatus && <li aria-label={t('answering')} className="flex"><span className="rounded-2xl bg-muted px-4 py-3"><Spinner aria-hidden="true" /></span></li>}
                  </ol>
                  {first?.routingError && !first.agentStatus && <p className="text-center text-xs text-muted-foreground">{t('noTaker')}</p>}
                  {first?.stopped && !first.agentStatus && <p role="status" className="text-center text-xs text-muted-foreground">{t('stopped')}</p>}
                </>}
      </div>
    </div>
    <div className="mx-auto w-full max-w-3xl shrink-0 px-4 pb-4">
      <ChatComposer ref={null} value={draft} onChange={value => { submittedDraft.current = null; setDraft(value) }} onSubmit={send} label={t('composer', { name: group.title || t('untitled') })} disabled={!!blockingCode} attachmentScope={{ kind: 'group', id: group.id }}
        sending={stopping} editableWhileSending={stopping} running={replying && !stopping} onStop={replying && !stopping ? () => { void stop() } : undefined} />
    </div>
  </section>
}
