'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { conversationReadSource, type ConversationRead, type ConversationReadSource } from '@/lib/conversation-reads'
import { arrivedSinceLeftBottom, createReadReporter, dividerPosition, lastVisiblePosition, mergeReadPosition, unreadBelowDivider, type UnreadItem } from '@/lib/unread'

const AT_BOTTOM_PX = 24
export const MESSAGE_POSITION_ATTR = 'data-message-position'
export const UNREAD_DIVIDER_ATTR = 'data-unread-divider'

/**
 * MIK-8 unread state for one conversation (DM or group). `rootRef` must contain the
 * MessageScroller viewport; each message item carries `data-message-position`.
 */
export function useUnreadIndicators({ conversationId, items, rootRef, source = conversationReadSource }: {
  conversationId: string
  /** `reportable` = a persisted message the server knows; only those are ever sent as read. */
  items: (UnreadItem & { messageId: string; reportable: boolean })[]
  rootRef: RefObject<HTMLElement | null>
  source?: ConversationReadSource
}) {
  const [read, setRead] = useState<ConversationRead | null>(null)
  const [divider, setDivider] = useState<number | null | undefined>(undefined)
  const [dividerAbove, setDividerAbove] = useState(false)
  const [topDismissed, setTopDismissed] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  const [leftBottomAt, setLeftBottomAt] = useState<number | null>(null)
  const [bottomDismissed, setBottomDismissed] = useState(false)
  const itemsRef = useRef(items)
  const ready = useRef(false)
  itemsRef.current = items

  useEffect(() => {
    let alive = true
    source.get(conversationId).then(value => { if (alive) setRead(value) }).catch(() => { if (alive) setRead({ lastReadMessageId: null, lastReadPosition: null, unreadCount: 0 }) })
    const unsubscribe = source.subscribe?.(conversationId, next => setRead(current => current && mergeReadPosition(current.lastReadPosition, next.lastReadPosition) === current.lastReadPosition ? current : next))
    return () => { alive = false; unsubscribe?.() }
  }, [conversationId, source])

  // The divider is fixed once per visit, from the read position at open time.
  useEffect(() => {
    if (divider !== undefined || !read || !items.length) return
    setDivider(dividerPosition(items, read.lastReadPosition))
  }, [divider, read, items])

  const reporter = useMemo(() => createReadReporter<{ messageId: string; position: number }>({
    send: target => {
      void source.mark(conversationId, target).then(value => {
        // The server's answer is authoritative (it is forward-only itself).
        reporter.advance(value.lastReadPosition)
        setRead(value)
      }).catch(() => {
        // Any failure (403/404/422, 5xx, network): degrade silently, no retry loop for this visit.
        reporter.stop()
      })
    },
    sendNow: target => { if (!reporter.stopped) source.beacon(conversationId, target) },
  }), [conversationId, source])

  const reportablePositions = items.filter(item => item.reportable).map(item => item.position).join(',')
  useEffect(() => { source.observe?.(conversationId, reportablePositions ? reportablePositions.split(',').map(position => ({ position: Number(position) })) : []) }, [conversationId, source, reportablePositions])

  useEffect(() => {
    const onHide = () => { if (document.visibilityState === 'hidden') reporter.flush() }
    document.addEventListener('visibilitychange', onHide)
    return () => { document.removeEventListener('visibilitychange', onHide); reporter.flush() }
  }, [reporter])

  const viewport = useCallback(() => rootRef.current?.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]') ?? null, [rootRef])

  const measure = useCallback(() => {
    const element = viewport()
    if (!element) return
    const box = element.getBoundingClientRect()
    const nodes = [...element.querySelectorAll<HTMLElement>(`[${MESSAGE_POSITION_ATTR}]`)]
    const position = lastVisiblePosition(nodes.map(node => { const rect = node.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, position: Number(node.getAttribute(MESSAGE_POSITION_ATTR)) } }), box)
    const target = position === null ? undefined : itemsRef.current.findLast(item => item.reportable && item.position <= position)
    // Don't report until the open-time placement ran, or the initial scroll-to-end would mark everything read.
    if (target && ready.current && document.visibilityState !== 'hidden') reporter.report({ messageId: target.messageId, position: target.position })
    const line = element.querySelector<HTMLElement>(`[${UNREAD_DIVIDER_ATTR}]`)
    setDividerAbove(line ? line.getBoundingClientRect().bottom < box.top : false)
    const bottom = element.scrollHeight - element.scrollTop - element.clientHeight <= AT_BOTTOM_PX
    setAtBottom(bottom)
    if (bottom) { setLeftBottomAt(null); setBottomDismissed(false) }
    else setLeftBottomAt(current => current ?? itemsRef.current.at(-1)?.position ?? null)
  }, [viewport, reporter])

  useEffect(() => {
    const element = viewport()
    if (!element) return
    element.addEventListener('scroll', measure, { passive: true })
    return () => element.removeEventListener('scroll', measure)
  }, [viewport, measure, read])

  useEffect(() => { const id = requestAnimationFrame(measure); return () => cancelAnimationFrame(id) }, [items, divider, measure])

  // The scroller can finish anchor placement or reveal content-visibility items
  // after its scroll event. Observe the resulting geometry as well: a scroll
  // measurement is not evidence that the final visible messages were measured.
  const messagePositions = items.map(item => item.position).join(',')
  useEffect(() => {
    const element = viewport()
    if (!element) return
    let frame: number | null = null
    const scheduleMeasure = () => {
      if (frame !== null) return
      frame = requestAnimationFrame(() => { frame = null; measure() })
    }
    const nodes = [...element.querySelectorAll<HTMLElement>(`[${MESSAGE_POSITION_ATTR}]`)]
    const visibility = new IntersectionObserver(scheduleMeasure, { root: element, threshold: [0, 0.5, 1] })
    const size = new ResizeObserver(scheduleMeasure)
    size.observe(element)
    for (const node of nodes) { visibility.observe(node); size.observe(node) }
    scheduleMeasure()
    return () => {
      visibility.disconnect()
      size.disconnect()
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [viewport, measure, messagePositions])

  // On open, place the divider about a third of the way down the viewport. The scroller applies
  // its own scroll-to-end one frame after content first appears, so wait a frame past that.
  const placed = useRef(false)
  const placeFrame = useRef(0)
  useEffect(() => {
    if (placed.current || divider === undefined) return
    placed.current = true
    placeFrame.current = requestAnimationFrame(() => { placeFrame.current = requestAnimationFrame(() => { if (divider !== null) scrollToDivider(); ready.current = true; measure() }) })
  })
  // Only unmount cancels the placement; a re-render in between must not drop it.
  useEffect(() => () => cancelAnimationFrame(placeFrame.current), [])

  function scrollToDivider() {
    const element = viewport()
    const line = element?.querySelector<HTMLElement>(`[${UNREAD_DIVIDER_ATTR}]`)
    if (!element || !line) return
    // The scroller follows the end until the person scrolls; tell it this is a reading place, as a wheel would.
    element.dispatchEvent(new WheelEvent('wheel', { bubbles: true }))
    const offset = line.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop
    element.scrollTo({ top: Math.max(0, offset - element.clientHeight / 3) })
  }

  const topCount = unreadBelowDivider(items, divider ?? null)
  const bottomCount = atBottom ? 0 : arrivedSinceLeftBottom(items, leftBottomAt)
  return {
    divider: divider ?? null,
    topCount,
    showTop: dividerAbove && topCount > 0 && !topDismissed,
    bottomCount,
    showBottom: bottomCount > 0 && !bottomDismissed,
    jumpToDivider() { scrollToDivider() },
    dismissTop() { setTopDismissed(true) },
    jumpToLatest() { const element = viewport(); element?.scrollTo({ top: element.scrollHeight }) },
    dismissBottom() { setBottomDismissed(true) },
  }
}
