'use client'

import { useEffect, type RefObject } from 'react'

/** Loading placeholders that stand in for a section until its data arrives. */
export const PLACEHOLDER_SELECTOR = '[data-loading-placeholder]'

/**
 * When a loading placeholder inside `ref` gives way to its content, the element that held it fades in
 * briefly (docs/design/decisions/2026-10-31-1814-segmented-control-motion.md: skeleton → content). Nothing else animates, and
 * reduced motion turns it off.
 */
export function useRevealLoaded(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = ref.current
    if (!root || typeof MutationObserver === 'undefined') return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)')
    const observer = new MutationObserver(records => {
      if (reduce.matches) return
      const revealed = new Set<Element>()
      for (const record of records) {
        if (!(record.target instanceof Element)) continue
        const removedPlaceholder = Array.from(record.removedNodes).some(node => node instanceof Element && (node.matches(PLACEHOLDER_SELECTOR) || node.querySelector(PLACEHOLDER_SELECTOR)))
        if (removedPlaceholder && record.target.isConnected && !record.target.querySelector(PLACEHOLDER_SELECTOR)) revealed.add(record.target)
      }
      for (const element of revealed) element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, easing: 'ease-out' })
    })
    observer.observe(root, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [ref])
}
