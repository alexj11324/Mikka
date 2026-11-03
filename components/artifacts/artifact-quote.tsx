'use client'

import type { ReactNode } from 'react'
import { SquareDashedMousePointer, TextQuote, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import type { ArtifactQuote } from '@/lib/artifacts/quote'

const Icon = ({ quote }: { quote: ArtifactQuote }) => quote.kind === 'element'
  ? <SquareDashedMousePointer aria-hidden="true" className="size-3.5 shrink-0" />
  : <TextQuote aria-hidden="true" className="size-3.5 shrink-0" />

const words = (quote: ArtifactQuote) => quote.kind === 'element' ? quote.label ?? quote.text : quote.text

/** A quote waiting in the composer, above what the person types: an artifact's, or words from a reply. */
export function QuoteChip({ text, icon = <TextQuote aria-hidden="true" className="size-3.5 shrink-0" />, onRemove, slot = 'quote-chip' }: { text: string; icon?: ReactNode; onRemove: () => void; slot?: string }) {
  const t = useTranslations('Artifact')
  return <div data-slot={slot} className="flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md bg-control pr-0.5 pl-2 text-xs text-muted-foreground">
    {icon}
    <span className="min-w-0 flex-1 truncate" title={text}>{text}</span>
    <Button type="button" variant="ghost" size="icon-xs" aria-label={t('removeQuote')} onClick={onRemove}><X data-icon="inline-start" /></Button>
  </div>
}

/** A quote at the top of a sent message. */
export function QuoteLine({ text, icon, slot = 'quote' }: { text: string; icon?: ReactNode; slot?: string }) {
  const t = useTranslations('Artifact')
  return <span data-slot={slot} aria-label={t('quoteLabel', { text })} className="flex min-w-0 items-center gap-1.5 border-l-2 border-foreground/15 pl-2 text-xs text-muted-foreground">
    {icon}
    <span className="truncate">{text}</span>
  </span>
}

/** The artifact quote waiting in the composer. */
export function ArtifactQuoteChip({ quote, onRemove }: { quote: ArtifactQuote; onRemove: () => void }) {
  return <QuoteChip slot="artifact-quote-chip" text={words(quote)} icon={<Icon quote={quote} />} onRemove={onRemove} />
}

/** The artifact quote at the top of a sent message. */
export function ArtifactQuoteLine({ quote }: { quote: ArtifactQuote }) {
  return <QuoteLine slot="artifact-quote" text={words(quote)} icon={quote.kind === 'element' ? <Icon quote={quote} /> : undefined} />
}
