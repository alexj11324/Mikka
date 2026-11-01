'use client'

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'

export type ResizableWidthOptions = {
  /** localStorage key for the width this device remembers. */
  storageKey: string
  min: number
  /** A number, 'half' for half the window, or a share of the window such as '70%'. */
  max: number | 'half' | `${number}%`
  /** The default width; null leaves it to the column's own CSS (a 50/50 split) until the edge is moved. */
  initial: number | null
  /** Which side of the column the handle sits on: 'end' grows toward the end, 'start' toward the start. */
  edge: 'start' | 'end'
}
type Options = ResizableWidthOptions

const STEP = 16

function maxFor(max: Options['max']) {
  if (typeof max === 'number') return max
  const share = max === 'half' ? 50 : Number(max.slice(0, -1))
  return Math.floor(window.innerWidth * share / 100)
}

/**
 * A column whose edge resizes it, as in Codex and Linear: drag the edge, use the
 * arrow keys on it, or double-click it to go back to the default width. The width
 * is remembered on this device.
 */
export function useResizableWidth(options: Options & { initial: number }): ResizableWidth<number>
export function useResizableWidth(options: Options): ResizableWidth<number | null>
export function useResizableWidth({ storageKey, min, max, initial, edge }: Options): ResizableWidth<number | null> {
  const [width, setWidth] = useState<number | null>(initial)
  const [limit, setLimit] = useState(typeof max === 'number' ? max : initial ?? min)
  const [dragging, setDragging] = useState(false)
  // The remembered width is applied on load without a spring.
  const [restored, setRestored] = useState(false)
  const moved = useRef(false)
  const top = Math.max(min, limit)
  const clamp = (value: number) => Math.round(Math.min(top, Math.max(min, value)))

  useEffect(() => {
    const measure = () => setLimit(maxFor(max))
    measure()
    try {
      const stored = Number(window.localStorage.getItem(storageKey))
      if (stored) setWidth(stored)
    } catch { /* storage unavailable */ }
    const frame = requestAnimationFrame(() => setRestored(true))
    if (typeof max !== 'number') window.addEventListener('resize', measure)
    return () => { cancelAnimationFrame(frame); window.removeEventListener('resize', measure) }
  }, [storageKey, max])

  function remember(value: number) {
    try { window.localStorage.setItem(storageKey, String(value)) } catch { /* storage unavailable */ }
  }
  /** +1 when moving the pointer right grows the column. */
  function sign(element: Element) {
    const rtl = getComputedStyle(element).direction === 'rtl' ? -1 : 1
    return edge === 'end' ? rtl : -rtl
  }

  /** The width now: the chosen one, or what the column's CSS gives it before one is chosen. */
  function current(handle: HTMLElement) {
    return clamp(width ?? handle.parentElement?.getBoundingClientRect().width ?? min)
  }

  function onPointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0) return
    // No text selection, and no native drag of a selection a double-click left behind: either would cancel the pointer mid-drag.
    event.preventDefault()
    window.getSelection()?.removeAllRanges()
    const handle = event.currentTarget, startX = event.clientX, startWidth = current(handle)
    const direction = sign(handle)
    let latest = startWidth
    moved.current = false
    handle.setPointerCapture(event.pointerId)
    const move = (next: PointerEvent) => {
      const delta = (next.clientX - startX) * direction
      // A few pixels of jitter is still a click.
      if (!moved.current && Math.abs(delta) < 3) return
      if (!moved.current) { moved.current = true; setDragging(true) }
      latest = clamp(startWidth + delta)
      setWidth(latest)
    }
    const end = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', end)
      handle.removeEventListener('pointercancel', end)
      if (!moved.current) return
      setDragging(false)
      remember(latest)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    const right = sign(event.currentTarget)
    const step = event.shiftKey ? STEP * 4 : STEP
    const now = current(event.currentTarget)
    const next = event.key === 'ArrowRight' ? now + step * right
      : event.key === 'ArrowLeft' ? now - step * right
      : event.key === 'Home' ? min
      : event.key === 'End' ? top
      : null
    if (next === null) return
    event.preventDefault()
    const value = clamp(next)
    setWidth(value)
    remember(value)
  }

  function reset() {
    setWidth(initial)
    try { window.localStorage.removeItem(storageKey) } catch { /* storage unavailable */ }
  }

  /** True once for the click that ends a drag, so that click does nothing else. */
  function endedDrag() {
    const was = moved.current
    moved.current = false
    return was
  }

  /** Sets the width for now without remembering it, as the 加宽 button does. */
  function resizeTo(next: number) { setWidth(clamp(next)) }

  const value = width === null ? null : clamp(width)
  return {
    width: value,
    max: top,
    resizeTo,
    dragging,
    /** No spring while the edge follows the pointer, or while the remembered width loads. */
    instant: dragging || !restored,
    endedDrag,
    reset,
    handleProps: {
      role: 'separator',
      'aria-orientation': 'vertical',
      'aria-valuenow': value ?? undefined,
      'aria-valuemin': min,
      'aria-valuemax': top,
      tabIndex: 0,
      onPointerDown,
      onKeyDown,
    },
  }
}

export type ResizableWidth<W extends number | null> = {
  width: W
  max: number
  resizeTo: (next: number) => void
  dragging: boolean
  instant: boolean
  endedDrag: () => boolean
  reset: () => void
  handleProps: {
    role: 'separator'
    'aria-orientation': 'vertical'
    'aria-valuenow': number | undefined
    'aria-valuemin': number
    'aria-valuemax': number
    tabIndex: 0
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
    onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void
  }
}

/** The edge strip: invisible, with a hairline on hover that turns to the focus colour while dragged or focused. */
export const RESIZE_EDGE = 'z-20 w-2 cursor-col-resize outline-none ltr:translate-x-0 rtl:translate-x-0 after:absolute after:inset-y-0 after:w-px after:bg-border after:opacity-0 after:transition-opacity hover:after:opacity-100 focus-visible:after:bg-ring focus-visible:after:opacity-100 active:after:bg-ring active:after:opacity-100'
