'use client'

import { useEffect, useRef, useState } from 'react'
import useSWRInfinite from 'swr/infinite'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { listAgents } from '@/app/actions/agents'
import { ChatComposer } from '@/components/coordinator/chat-composer'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { ConversationPill } from '@/components/nav/conversation-pill'
import { GroupAvatar, useGroupMembers } from '@/components/nav/group-avatar'
import { LetterAvatar } from '@/components/nav/letter-avatar'
import { BotAvatar } from '@/components/nav/bot-avatar'
import { UserMessageText } from '@/components/workspace/user-message-text'
import { cn } from '@/lib/utils'
import { mentionsIn } from '@/lib/group-mentions'
import { authorRuns, chronological, fetchGroupMessages, GroupMessagesRequestError, postGroupMessage, stopGroupReply, type GroupMessagePage } from '@/lib/group-messages'
import { toast } from 'sonner'
import { useActionError } from '@/lib/use-action-error'

/** A message the person sent that the server has not stored yet; a failed one waits for 重试. */
type Pending = { key: string; body: string; failed: boolean; sentId?: string }

/** How often the chat reads again while a bot is answering; it does not poll otherwise. */
const ANSWER_POLL_MS = 2500

export type GroupChatRequest = { id: string; title: string; workspaceId: string }

/**
 * A group chat. It reads and sends through the group API (the phone's path),
 * which checks workspace and group membership on every request. A message goes
 * to the bots it @mentions, else to the ones the server judges should answer;
 * it shows at once and, if it fails, stays with 重试. While a bot is answering
 * the chat reads again every few seconds. Names and bot avatars come from the
 * group's member list, then the workspace's members and the person's agents.
 */
export function GroupChatView({ group, userId, people }: {
  group: GroupChatRequest
  userId: string
  /** Display names of the group's workspace members, when that workspace is the loaded one. */
  people: Map<string, string>
}) {
  const t = useTranslations('GroupChat')
  const { data: agents = [] } = useSWR('agents', listAgents)
  // The pill's avatar is the members' bloubs (R-36); the right column's 详情 reads the same request.
  const { data: members = [] } = useGroupMembers(group.id)
  const member = (type: 'user' | 'agent' | 'bot', id: string) => members.find(item => item.memberType === type && item.id === id)
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState<Pending[]>([])
  const [answering, setAnswering] = useState(false)
  const { data: pages, error, size, setSize, isValidating, mutate } = useSWRInfinite<GroupMessagePage>(
    (index, previous: GroupMessagePage | null) => index === 0 ? ['group-messages', group.id, null] : previous?.nextBefore ? ['group-messages', group.id, previous.nextBefore] : null,
    ([, id, before]: [string, string, string | null]) => fetchGroupMessages(id, before),
    // The first page carries new messages and who is answering; only it is read again while a bot answers.
    { revalidateOnFocus: false, refreshInterval: answering ? ANSWER_POLL_MS : 0, onSuccess: data => setAnswering(!!data[0]?.agentStatus) },
  )
  const messages = pages ? chronological(pages) : []
  const older = pages?.at(-1)?.nextBefore ?? null
  const loadingOlder = isValidating && !!pages && size > pages.length
  const code = error instanceof GroupMessagesRequestError ? error.code : error ? 'unavailable' : null
  const deliver = async (item: Pending) => {
    setPending(list => list.map(entry => entry.key === item.key ? { ...entry, failed: false } : entry))
    let sentId: string
    try { sentId = (await postGroupMessage(group.id, item.body, mentionsIn(item.body, members))).id }
    catch {
      setPending(list => list.map(entry => entry.key === item.key ? { ...entry, failed: true } : entry))
      return
    }
    // Stored: never offered for 重试 again. It stays, hidden behind the stored copy once that is read, so it never flickers.
    setPending(list => list.map(entry => entry.key === item.key ? { ...entry, sentId } : entry))
    await mutate()
  }
  const send = () => {
    const body = draft.trim()
    if (!body) return
    const item = { key: crypto.randomUUID(), body, failed: false }
    setDraft('')
    setPending(list => [...list, item])
    void deliver(item)
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
  const unsent = pending.filter(item => !item.sentId || !messages.some(message => message.id === item.sentId))
  // The newest message, a sent one or a bot answering keeps the chat at its end; loading older ones does not move it.
  const scroller = useRef<HTMLDivElement>(null)
  const end = `${messages.at(-1)?.id}:${unsent.length}:${!!first?.agentStatus}`
  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight }) }, [end])
  const authorName = (type: 'user' | 'agent' | 'bot', id: string) => type === 'user'
    ? id === userId ? t('you') : member(type, id)?.name || people.get(id) || t('member')
    : member(type, id)?.name ?? (type === 'agent' ? agents.find(agent => agent.id === id)?.name : undefined) ?? t('bot')

  return <section aria-label={group.title || t('untitled')} data-testid="group-chat" className="relative flex size-full min-h-0 flex-col">
    <ConversationPill name={group.title || t('untitled')} avatar={<GroupAvatar title={group.title || t('untitled')} members={members} />} />
    <div aria-hidden="true" className="hidden h-14 shrink-0 md:block" />
    <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 pb-6">
        {code === 'not_found' ? <p role="alert" className="py-6 text-sm">{t('notFound')}</p>
          : code ? <div role="alert" className="flex items-center gap-3 py-6 text-sm"><span>{code === 'unauthorized' ? t('authRequired') : t('loadError')}</span>{code !== 'unauthorized' && <Button variant="outline" size="sm" onClick={() => { void mutate() }}>{t('retry')}</Button>}</div>
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
                        {!mine && (bot ? <BotAvatar color={bot.color} shape={bot.shape} size="message" still /> : <LetterAvatar name={name} size="message" />)}
                        <div className={cn('flex min-w-0 flex-col gap-1', mine ? 'max-w-[min(26rem,80%)] items-end' : 'max-w-[min(35rem,85%)]')}>
                          {mine ? <span className="sr-only">{name}</span> : <span className="text-xs font-medium text-muted-foreground">{name}</span>}
                          {run.messages.map(message => <Bubble key={message.id} variant={mine ? 'secondary' : 'muted'} align={mine ? 'end' : 'start'} className={cn('max-w-full', mine && '*:data-[slot=bubble-content]:bg-sidebar-primary *:data-[slot=bubble-content]:text-sidebar-primary-foreground')}>
                            <BubbleContent className="rounded-2xl px-4 py-3 whitespace-pre-wrap">{run.authorType === 'user' ? <UserMessageText text={message.body} /> : message.body}</BubbleContent>
                          </Bubble>)}
                        </div>
                      </li>
                    })}
                    {unsent.map(item => <li key={item.key} data-pending={item.failed ? 'failed' : 'sending'} className="flex flex-col items-end gap-1">
                      <Bubble variant="secondary" align="end" className={cn('max-w-[min(26rem,80%)] *:data-[slot=bubble-content]:bg-sidebar-primary *:data-[slot=bubble-content]:text-sidebar-primary-foreground', !item.failed && 'opacity-60')}>
                        <BubbleContent className="rounded-2xl px-4 py-3 whitespace-pre-wrap"><UserMessageText text={item.body} /></BubbleContent>
                      </Bubble>
                      {item.failed && <span role="alert" className="flex items-center gap-2 text-xs text-destructive">{t('notSent')}<Button variant="ghost" size="xs" onClick={() => { void deliver(item) }}>{t('retry')}</Button></span>}
                    </li>)}
                    {first?.agentStatus && <li aria-label={t('answering')} className="flex"><span className="rounded-2xl bg-muted px-4 py-3"><Spinner aria-hidden="true" /></span></li>}
                  </ol>
                  {first?.routingError && !first.agentStatus && <p className="text-center text-xs text-muted-foreground">{t('noTaker')}</p>}
                  {first?.stopped && !first.agentStatus && <p role="status" className="text-center text-xs text-muted-foreground">{t('stopped')}</p>}
                </>}
      </div>
    </div>
    <div className="mx-auto w-full max-w-3xl shrink-0 px-4 pb-4">
      <ChatComposer ref={null} value={draft} onChange={setDraft} onSubmit={send} label={t('composer', { name: group.title || t('untitled') })} disabled={!!code}
        sending={stopping} editableWhileSending={stopping} running={replying && !stopping} onStop={replying && !stopping ? () => { void stop() } : undefined} />
    </div>
  </section>
}
