'use client'

import { useTranslations } from 'next-intl'
import type { SuggestionSource } from '@/lib/db/schema'
import { cardParts, SOURCE_NAMES, type SuggestionCard } from '@/lib/suggestions/card'
import { cn } from '@/lib/utils'

/** The app's mark: a small square in its colour. */
export function SourceMark({ source }: { source: SuggestionSource }) {
  return <span aria-hidden="true" className={cn('inline-block size-3 shrink-0 rounded-xs',
    source === 'gmail' && 'bg-destructive', source === 'github' && 'bg-muted-foreground', source === 'linear' && 'bg-label-violet',
    source === 'notion' && 'bg-foreground', source === 'slack' && 'bg-avatar-2')} />
}

/** The app named inside the sentence: its mark and name, in bold, inline. */
function SourceMention({ source }: { source: SuggestionSource }) {
  return <span data-slot="source-mention" className="mx-0.5 inline-flex items-center gap-1 align-bottom font-semibold whitespace-nowrap"><SourceMark source={source} />{SOURCE_NAMES[source]}</span>
}

/**
 * A 建议 item as a mobile-style card (Figma F8 `420:5831`, R-21): a verb chip,
 * then one sentence with the app named inline. The same card heads the
 * person's message in the Coordinator chat once tapped.
 */
export function SuggestionCardBody({ card }: { card: SuggestionCard }) {
  const t = useTranslations('SuggestionsPage')
  const { verb, parts } = cardParts(card, t(`action.${card.action}`))
  return <span className="flex min-w-0 items-start gap-2.5 text-left text-sm leading-6 font-normal whitespace-normal text-foreground">
    {verb && <span className="shrink-0 rounded-md bg-muted px-2 text-sm leading-6">{verb}</span>}
    <span className="min-w-0 break-words">{parts.map((part, index) => part.kind === 'source' ? <SourceMention key={index} source={part.source} /> : <span key={index}>{part.text}</span>)}</span>
  </span>
}

/** The card's frame: one 1px line, no shadow, a soft radius. */
export const CARD_FRAME = 'rounded-2xl border border-border bg-background px-5 py-4'
