'use client'

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { SelectionActions } from '@/components/artifacts/selection-actions'
import { quotable } from '@/lib/chat-quote'

/** Marks the element whose selected text can be quoted: a reply's words, not the person's own or a card's buttons. */
export const QUOTE_SOURCE_ATTR = 'data-quote-source'

type Picked = { text: string; range: Range; source: Element }

/** The quotable text selected inside `root`, its range and the reply it is in; null when nothing quotable is selected. */
export function selectedQuote(root: HTMLElement | null, selection: Selection | null): Picked | null {
  if (!root || !selection || selection.isCollapsed || !selection.rangeCount) return null
  const range = selection.getRangeAt(0)
  const common = range.commonAncestorContainer
  const element = common.nodeType === 1 ? common as Element : common.parentElement
  const source = element?.closest(`[${QUOTE_SOURCE_ATTR}]`)
  if (!source || !root.contains(source)) return null
  const text = quotable(selection.toString())
  return text ? { text, range: range.cloneRange(), source } : null
}

/**
 * 引用 / 复制 over a selection in a reply (Figma C2 `910:2`), the Artifact reader's popover (`SelectionActions`):
 * select words in an answer and it appears above them; 引用 puts them in the composer as a quote. It waits for the pointer to let
 * go, follows the words as the chat scrolls (the popover is anchored to the selected range), and leaves with the
 * selection or on Esc. Only text under `QUOTE_SOURCE_ATTR` inside `root` counts.
 */
export function SelectionQuote({ root, onQuote }: { root: RefObject<HTMLElement | null>; onQuote: (text: string) => void }) {
  const [picked, setPicked] = useState<Picked | null>(null)
  const dragging = useRef(false)
  const frame = useRef(0)
  const read = useCallback(() => {
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => setPicked(current => {
      const next = dragging.current ? null : selectedQuote(root.current, document.getSelection())
      // The same words still selected keep their popover where it is.
      return next && current && next.text === current.text && next.source === current.source ? current : next
    }))
  }, [root])
  useEffect(() => {
    const down = (event: PointerEvent) => {
      // A press on the button itself keeps the selection; anywhere else starts a new one.
      if ((event.target as Element | null)?.closest?.('[data-slot=selection-actions]')) return
      dragging.current = true
      setPicked(null)
    }
    const up = () => { dragging.current = false; read() }
    document.addEventListener('selectionchange', read)
    document.addEventListener('pointerdown', down)
    document.addEventListener('pointerup', up)
    return () => {
      cancelAnimationFrame(frame.current)
      document.removeEventListener('selectionchange', read)
      document.removeEventListener('pointerdown', down)
      document.removeEventListener('pointerup', up)
    }
  }, [read])
  return <SelectionActions selection={picked} onQuote={onQuote} onClose={() => setPicked(null)} />
}
