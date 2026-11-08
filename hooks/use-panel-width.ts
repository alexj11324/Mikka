'use client'

import * as panelHeaderSlot from '@ui-slot/panel-header'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ResizableWidth } from './use-resizable-width'

/** The area right of the left sidebar: from the main column's start edge to the window's end, the right column included. */
function mainAreaWidth() {
  const main = document.querySelector<HTMLElement>('main[data-slot="sidebar-inset"]')
  if (!main) return window.innerWidth
  const box = main.getBoundingClientRect()
  return getComputedStyle(main).direction === 'rtl' ? box.right : window.innerWidth - box.left
}

/**
 * The right column's default width (概览, a group's panel, a thread or task): `fallback` in this repository; a UI
 * layer may size it from the main area (the panel-header slot's optional PANEL_INITIAL_WIDTH). The server and the
 * first render use `fallback`, so it is SSR-safe. Only the default moves: a width the person chose and
 * useResizableWidth remembers still wins.
 */
export function usePanelInitialWidth(fallback: number) {
  const size = panelHeaderSlot.PANEL_INITIAL_WIDTH ?? null
  const [width, setWidth] = useState(fallback)
  useEffect(() => {
    if (!size) return
    const measure = () => setWidth(Math.round(size(mainAreaWidth())))
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [size])
  return size ? width : fallback
}

const WIDE = 520

/**
 * ⤢ for a right column, as 概览 does it: widening remembers the width it replaced and toggling again puts it back;
 * from WIDE or more it goes to the column's maximum. `reset` forgets it (a double-click on the edge).
 */
export function useWidenToggle({ width, max, resizeTo }: Pick<ResizableWidth<number>, 'width' | 'max' | 'resizeTo'>) {
  const [beforeWide, setBeforeWide] = useState<number | null>(null)
  // The toggle stays one function, so a header that reads it does not redraw while the edge is dragged.
  const latest = useRef({ width, max, resizeTo, beforeWide })
  useLayoutEffect(() => { latest.current = { width, max, resizeTo, beforeWide } })
  const onToggle = useCallback(() => {
    const now = latest.current
    if (now.beforeWide !== null) { now.resizeTo(now.beforeWide); setBeforeWide(null); return }
    setBeforeWide(now.width)
    now.resizeTo(now.width >= WIDE ? now.max : WIDE)
  }, [])
  const reset = useCallback(() => setBeforeWide(null), [])
  return { wide: beforeWide !== null, onToggle, reset }
}
