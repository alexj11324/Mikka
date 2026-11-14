'use client'

import { useTranslations } from 'next-intl'
import { Copy, TextQuote } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent } from '@/components/ui/popover'

const copyFeedback = { id: 'selection-copy' }

/** A popover anchor on a live range: it moves with the words when their column scrolls. */
export function selectionAnchor(range: Range) {
  return { getBoundingClientRect: () => range.getBoundingClientRect() }
}

/**
 * 引用 / 复制 over selected words: the Artifact reader's and a chat reply's (Figma C2 `910:2`). One popover for both,
 * above the selection; 复制 copies the selected words and says 已复制, 引用 hands them to the composer.
 */
export function SelectionActions({ selection, onQuote, onClose }: { selection: { text: string; range: Range } | null; onQuote: (text: string) => void; onClose: () => void }) {
  const t = useTranslations('Artifact')
  function quote() {
    if (!selection) return
    onQuote(selection.text)
    window.getSelection()?.removeAllRanges()
    onClose()
  }
  async function copy() {
    if (!selection) return
    try {
      await navigator.clipboard.writeText(selection.text)
    } catch {
      toast.error(t('copyFailed'), copyFeedback)
      return
    }
    toast.success(t('copied'), copyFeedback)
    onClose()
  }
  return <Popover open={selection != null} onOpenChange={open => { if (!open) onClose() }}>
    {selection && <PopoverContent data-slot="selection-actions" anchor={selectionAnchor(selection.range)} side="top" sideOffset={8} initialFocus={false} finalFocus={false} aria-label={t('quote')}
      className="w-auto flex-row gap-0.5 p-1" onMouseUp={event => event.stopPropagation()}>
      <Button size="sm" variant="ghost" onMouseDown={event => event.preventDefault()} onClick={quote}><TextQuote data-icon="inline-start" />{t('quote')}</Button>
      <Button size="sm" variant="ghost" onMouseDown={event => event.preventDefault()} onClick={() => void copy()}><Copy data-icon="inline-start" />{t('copy')}</Button>
    </PopoverContent>}
  </Popover>
}
