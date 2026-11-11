'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Check, Copy } from 'lucide-react'
import { MessageAction } from '@/components/ai-elements/message'

/** Actions under a message (`MessageActions`): shown while its `group/message` is hovered or focused, always on a touch screen. */
export const HOVER_ACTIONS = 'opacity-0 transition-opacity duration-150 group-hover/message:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100 motion-reduce:transition-none'

/**
 * The actions under a reply in a chat (R-83, revised 2026-11-10): always there, like Codex — a copy button that appears
 * only on hover reads as a stray mark, and a touch screen has no hover at all. They stay quiet through the muted icon
 * colour and only raise contrast on hover or focus, so nothing appears or disappears as the pointer moves.
 */
export const REPLY_ACTIONS = 'transition-opacity duration-150 motion-reduce:transition-none'

/** How long the tick stays after a copy, as under a Claude or ChatGPT reply. */
export const COPIED_MS = 2000

/**
 * 复制 under a message: the text goes to the clipboard, the icon turns into a tick and 「已复制」 shows beside it
 * for two seconds (Figma C5 `907:2`). A refused clipboard says 复制失败 the same way; nothing else on the screen moves.
 */
export function CopyAction({ text }: { text: string }) {
  const t = useTranslations('AiElements.message')
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  async function copy() {
    let next: 'copied' | 'failed' = 'copied'
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard')
      await navigator.clipboard.writeText(text)
    } catch { next = 'failed' }
    setState(next)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setState('idle'), COPIED_MS)
  }
  const label = state === 'copied' ? t('copied') : state === 'failed' ? t('copyFailed') : t('copy')
  return <MessageAction tooltip={label} tooltipOpen={state !== 'idle'} data-copy-state={state} onClick={() => { void copy() }}>
    {state === 'copied' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
  </MessageAction>
}
