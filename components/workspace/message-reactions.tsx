'use client'

import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { fetchMessageReactions, reactionUrls, type MessageReaction, type MessageReactions as Reactions } from '@/lib/message-reactions'
import { cn } from '@/lib/utils'

/** Reactions on these messages, read again when the set of stored messages changes. */
export function useMessageReactions(messageIds: readonly (string | null | undefined)[]): Reactions {
  const urls = reactionUrls(messageIds)
  const { data } = useSWR(urls.length ? ['message-reactions', ...urls] : null, ([, ...keys]: string[]) => fetchMessageReactions(keys))
  return data ?? {}
}

/**
 * The reactions under a message, as the phone shows them (decision
 * 2026-11-01-0030-mobile-reactions): one chip per emoji, a count past one,
 * the person's own tinted. Shown only; reacting stays on the phone for now.
 */
export function MessageReactions({ reactions, align = 'start' }: { reactions?: readonly MessageReaction[]; align?: 'start' | 'end' }) {
  const t = useTranslations('Reactions')
  if (!reactions?.length) return null
  return <ul aria-label={t('list')} data-slot="message-reactions" className={cn('flex flex-wrap gap-1.5', align === 'end' && 'justify-end self-end')}>
    {reactions.map(reaction => <li key={reaction.emoji}
      aria-label={reaction.mine ? t('mine', { emoji: reaction.emoji, others: reaction.count - 1 }) : t('others', { emoji: reaction.emoji, count: reaction.count })}
      data-mine={reaction.mine ? '' : undefined}
      className={cn('flex h-7 items-center gap-1 rounded-full px-2.5 text-sm tabular-nums', reaction.mine ? 'bg-sidebar-primary/15 text-foreground' : 'bg-muted text-muted-foreground')}>
      <span aria-hidden="true">{reaction.emoji}</span>
      {reaction.count > 1 && <span aria-hidden="true" className="text-xs">{reaction.count}</span>}
    </li>)}
  </ul>
}
