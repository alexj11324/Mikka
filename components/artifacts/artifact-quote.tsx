'use client'

import { SquareDashedMousePointer, TextQuote, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import type { ArtifactQuote } from '@/lib/artifacts/quote'

const Icon = ({ quote }: { quote: ArtifactQuote }) => quote.kind === 'element'
  ? <SquareDashedMousePointer aria-hidden="true" className="size-3.5 shrink-0" />
  : <TextQuote aria-hidden="true" className="size-3.5 shrink-0" />

const words = (quote: ArtifactQuote) => quote.kind === 'element' ? quote.label ?? quote.text : quote.text

/** The quote waiting in the composer, above what the person types. */
export function ArtifactQuoteChip({ quote, onRemove }: { quote: ArtifactQuote; onRemove: () => void }) {
  const t = useTranslations('Artifact')
  return <div data-slot="artifact-quote-chip" className="flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md bg-muted pr-0.5 pl-2 text-xs text-muted-foreground">
    <Icon quote={quote} />
    <span className="min-w-0 flex-1 truncate" title={words(quote)}>{words(quote)}</span>
    <Button type="button" variant="ghost" size="icon-xs" aria-label={t('removeQuote')} onClick={onRemove}><X data-icon="inline-start" /></Button>
  </div>
}

/** The quote at the top of a sent message. */
export function ArtifactQuoteLine({ quote }: { quote: ArtifactQuote }) {
  const t = useTranslations('Artifact')
  return <span data-slot="artifact-quote" aria-label={t('quoteLabel', { text: words(quote) })} className="flex min-w-0 items-center gap-1.5 border-l-2 border-foreground/15 pl-2 text-xs text-muted-foreground">
    {quote.kind === 'element' && <Icon quote={quote} />}
    <span className="truncate">{words(quote)}</span>
  </span>
}
