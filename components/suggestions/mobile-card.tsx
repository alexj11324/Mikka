'use client'

import { useTranslations } from 'next-intl'
import type { SuggestionSource } from '@/lib/db/schema'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { GitHubIcon, GmailIcon, LinearIcon, NotionIcon, SlackIcon } from '@/components/icons/brand-icons'
import { cardExtras, cardParts, SOURCE_NAMES, type SuggestionCard } from '@/lib/suggestions/card'
import { cn } from '@/lib/utils'

/** The app's own mark, 12px (R-21: the app's icon inline). */
export function SourceMark({ source }: { source: SuggestionSource }) {
  if (source === 'slack') return <SlackIcon />
  const Icon = source === 'gmail' ? GmailIcon : source === 'github' ? GitHubIcon : source === 'notion' ? NotionIcon : LinearIcon
  return <Icon className="size-3 shrink-0" />
}

/** The app named inside the sentence: its mark only, so a bold name does not read as part of the sentence (R-21); the name is for screen readers. 4px either side keeps the mark off the words. */
function SourceMention({ source }: { source: SuggestionSource }) {
  return <span data-slot="source-mention" className="mx-1 inline-flex h-5.5 items-center align-bottom"><SourceMark source={source} /><span className="sr-only">{SOURCE_NAMES[source]}</span></span>
}

/**
 * A 建议 item as a mobile-style card (Figma F8 `420:5831`, R-21): a verb chip,
 * then one sentence with the app named inline. The same card heads the
 * person's message in the Coordinator chat once tapped.
 */
export function SuggestionCardBody({ card }: { card: SuggestionCard }) {
  const t = useTranslations('SuggestionsPage')
  const { verb, parts } = cardParts(card, t(`action.${card.action}`))
  return <span className="flex min-w-0 items-start gap-2.5 text-left text-sm leading-5.5 font-normal whitespace-normal text-foreground">
    {verb && <span className="shrink-0 rounded-md bg-muted px-2 text-sm leading-5.5">{verb}</span>}
    <span data-slot="suggestion-words" className="line-clamp-3 min-w-0 wrap-anywhere">{parts.map((part, index) => part.kind === 'source' ? <SourceMention key={index} source={part.source} /> : <span key={index}>{part.text}</span>)}</span>
  </span>
}

/** The card's frame: one 1px line, no shadow, a 16px radius. */
export const CARD_FRAME = 'rounded-[16px] border border-border bg-background px-5 py-4'

/**
 * A card the person tapped, as their message in the Coordinator chat: the
 * same card, then a bubble only for what the card does not already show (the
 * source's own words, the link). With nothing to add, the card stands alone.
 */
export function SentSuggestion({ card, compact }: { card: SuggestionCard; compact: boolean }) {
  const t = useTranslations('SuggestionsPage')
  const { original, url } = cardExtras(card)
  const width = compact ? 'max-w-[90%]' : 'max-w-[min(26rem,80%)]'
  return <>
    <div data-slot="suggestion-card" className={cn(CARD_FRAME, 'self-end', width)}><SuggestionCardBody card={card} /></div>
    {(original || url) && <Bubble variant="secondary" align="end" className={cn('*:data-[slot=bubble-content]:bg-sidebar-primary *:data-[slot=bubble-content]:text-sidebar-primary-foreground', width)}>
      <BubbleContent className="flex flex-col gap-1.5 rounded-2xl px-4 py-3 break-words">
        {original && <span>{t('original', { title: original })}</span>}
        {url && <a href={url} target="_blank" rel="noopener noreferrer" className="break-all underline underline-offset-2">{url}</a>}
      </BubbleContent>
    </Bubble>}
  </>
}
