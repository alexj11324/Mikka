'use client'

import { useEffect, useRef } from 'react'
import { useTranslations } from 'next-intl'
import { ELEMENT_ROLES, type ElementRole, type FromFrame, type ToFrame } from '@mikka/protocol/artifact-frame'

export interface ElementQuote { selector: string; label: string; text: string }

/**
 * An HTML artifact in <iframe sandbox="allow-scripts">, never with
 * allow-same-origin: the page runs in an opaque origin and talks to the
 * reader only through postMessage. In 选择元素 mode it outlines the element
 * under the pointer and reports the one clicked; `marked` keeps a blue box on
 * elements already quoted.
 */
export function ArtifactFrame({ src, title, selecting, marked, onQuote, onSelectOff }: {
  src: string
  title: string
  selecting: boolean
  marked: readonly string[]
  onQuote: (quote: ElementQuote) => void
  onSelectOff: () => void
}) {
  const t = useTranslations('Artifact.roles')
  const frameRef = useRef<HTMLIFrameElement>(null)
  const state = useRef({ selecting, marked, onQuote, onSelectOff })
  state.current = { selecting, marked, onQuote, onSelectOff }
  const roles = Object.fromEntries(ELEMENT_ROLES.map(role => [role, t(role)])) as Record<ElementRole, string>
  const rolesRef = useRef(roles)
  rolesRef.current = roles

  const post = (message: ToFrame) => frameRef.current?.contentWindow?.postMessage(message, '*')
  const sync = () => {
    post({ source: 'mikka', type: 'select', on: state.current.selecting, roles: rolesRef.current })
    post({ source: 'mikka', type: 'mark', selectors: [...state.current.marked] })
  }

  useEffect(() => {
    function receive(event: MessageEvent) {
      // The frame's origin is opaque ("null"), so the window is what identifies it.
      if (!frameRef.current || event.source !== frameRef.current.contentWindow) return
      const data = event.data as FromFrame
      if (!data || data.source !== 'mikka-frame') return
      if (data.type === 'ready') sync()
      if (data.type === 'select-off') state.current.onSelectOff()
      if (data.type === 'quote' && typeof data.selector === 'string' && typeof data.label === 'string') {
        state.current.onQuote({ selector: data.selector.slice(0, 1000), label: data.label.slice(0, 200), text: String(data.text ?? '').slice(0, 2000) })
      }
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [])
  useEffect(sync, [selecting, marked])

  return <iframe ref={frameRef} key={src} src={src} title={title} sandbox="allow-scripts allow-popups" referrerPolicy="no-referrer"
    className="min-h-0 w-full flex-1 border-0" />
}
