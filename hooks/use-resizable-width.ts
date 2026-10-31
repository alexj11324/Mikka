'use client'

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'

type Options = {
  /** localStorage key for the width this device remembers. */
  storageKey: string
  min: number
  /** A number, or 'half' for half the window. */
  max: number | 'half'
  initial: number
  /** Which side of the column the handle sits on: 'end' grows toward the end, 'start' toward the start. */
  edge: 'start' | 'end'
}

const STEP = 16

function maxFor(max: Options['max']) {
  return max === 'half' ? Math.floor(window.innerWidth / 2) : max
}

/**
 * A column whose edge resizes it, as in Codex and Linear: drag the edge, use the
 * arrow keys on it, or double-click it to go back to the default width. The width
 * is remembered on this device.
 */
export function useResizableWidth({ storageKey, min, max, initial, edge }: Options) {
  const [width, setWidth] = useState(initial)
  const [limit, setLimit] = useState(typeof max === 'number' ? max : initial)
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
    if (max === 'half') window.addEventListener('resize', measure)
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

  function onPointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0) return
    const handle = event.currentTarget, startX = event.clientX, startWidth = clamp(width)
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
    const next = event.key === 'ArrowRight' ? clamp(width) + step * right
      : event.key === 'ArrowLeft' ? clamp(width) - step * right
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

  const value = clamp(width)
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
      'aria-valuenow': value,
      'aria-valuemin': min,
      'aria-valuemax': top,
      tabIndex: 0,
      onPointerDown,
      onKeyDown,
    } as const,
  }
}

/** The edge strip: invisible, with a hairline on hover that turns to the focus colour while dragged or focused. */
export const RESIZE_EDGE = 'z-20 w-2 cursor-col-resize outline-none ltr:translate-x-0 rtl:translate-x-0 after:absolute after:inset-y-3 after:w-px after:bg-border after:opacity-0 after:transition-opacity hover:after:opacity-100 focus-visible:after:inset-y-0 focus-visible:after:bg-ring focus-visible:after:opacity-100 active:after:inset-y-0 active:after:bg-ring active:after:opacity-100'
