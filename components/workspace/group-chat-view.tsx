'use client'

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
import { authorRuns, chronological, fetchGroupMessages, GroupMessagesRequestError, type GroupMessagePage } from '@/lib/group-messages'

export type GroupChatRequest = { id: string; title: string; workspaceId: string }

/**
 * A group chat, read-only. It opens from a search hit and reads the real
 * message history through the group API, which checks workspace and group
 * membership on every page. Sending is not wired yet, so it ends in the
 * standard composer, disabled (R-10), with no line explaining it (R-40). Names
 * and bot avatars come from the group's member list, then the workspace's
 * members and the person's agents.
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
  const { data: pages, error, size, setSize, isValidating, mutate } = useSWRInfinite<GroupMessagePage>(
    (index, previous: GroupMessagePage | null) => index === 0 ? ['group-messages', group.id, null] : previous?.nextBefore ? ['group-messages', group.id, previous.nextBefore] : null,
    ([, id, before]: [string, string, string | null]) => fetchGroupMessages(id, before),
    { revalidateOnFocus: false, revalidateFirstPage: false },
  )
  const messages = pages ? chronological(pages) : []
  const older = pages?.at(-1)?.nextBefore ?? null
  const loadingOlder = isValidating && !!pages && size > pages.length
  const code = error instanceof GroupMessagesRequestError ? error.code : error ? 'unavailable' : null
  const authorName = (type: 'user' | 'agent' | 'bot', id: string) => type === 'user'
    ? id === userId ? t('you') : member(type, id)?.name || people.get(id) || t('member')
    : member(type, id)?.name ?? (type === 'agent' ? agents.find(agent => agent.id === id)?.name : undefined) ?? t('bot')

  return <section aria-label={group.title || t('untitled')} data-testid="group-chat" className="relative flex size-full min-h-0 flex-col">
    <ConversationPill name={group.title || t('untitled')} avatar={<GroupAvatar title={group.title || t('untitled')} members={members} />} />
    <div aria-hidden="true" className="hidden h-14 shrink-0 md:block" />
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 pb-6">
        {code === 'not_found' ? <p role="alert" className="py-6 text-sm">{t('notFound')}</p>
          : code ? <div role="alert" className="flex items-center gap-3 py-6 text-sm"><span>{code === 'unauthorized' ? t('authRequired') : t('loadError')}</span>{code !== 'unauthorized' && <Button variant="outline" size="sm" onClick={() => { void mutate() }}>{t('retry')}</Button>}</div>
            : !pages ? <div aria-busy="true" className="flex flex-col gap-3 py-4"><Skeleton className="h-9 w-2/3" /><Skeleton className="ml-auto h-9 w-1/2" /><Skeleton className="h-9 w-3/5" /></div>
              : messages.length === 0 ? <p className="py-6 text-sm text-muted-foreground">{t('empty')}</p>
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
                  </ol>
                </>}
      </div>
    </div>
    <div className="mx-auto w-full max-w-3xl shrink-0 px-4 pb-4">
      <ChatComposer ref={null} value="" onChange={() => {}} onSubmit={() => {}} label={t('composer')} disabled />
    </div>
  </section>
}
