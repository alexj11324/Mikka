'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { ELEMENT_ROLES, type ElementRole, type FromFrame, type ToFrame } from '@mikka/protocol/artifact-frame'
import { selectedWebServer, webSelectionVersion } from '@/lib/web-connection/selection'
import { WebConnectionError } from '@/lib/web-connection/client'
import { connectedAssetPath } from '@/lib/web-connection/assets'

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
  const server = selectedWebServer(), generation = webSelectionVersion()
  const [remote, setRemote] = useState<{ src: string; generation: number; html?: string; error?: Error } | null>(null)
  useEffect(() => {
    if (!server) return
    const abort = new AbortController()
    void fetch(connectedAssetPath(src, window.location.origin), { signal: abort.signal, cache: 'no-store' }).then(async response => {
      if (!response.ok) throw new WebConnectionError('web_connection_download_failed')
      const html = await response.text()
      if (!abort.signal.aborted && generation === webSelectionVersion()) setRemote({ src, generation, html })
    }).catch(error => {
      if (!abort.signal.aborted && generation === webSelectionVersion()) setRemote({ src, generation,
        error: error instanceof Error ? error : new WebConnectionError('web_connection_download_failed', { cause: error }) })
    })
    return () => abort.abort()
  }, [src, server, generation])
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

  const loaded = remote?.src === src && remote.generation === generation ? remote : null
  if (server && loaded?.error) throw loaded.error
  return <iframe ref={frameRef} key={`${server ?? ''}:${src}`} src={server ? undefined : src} srcDoc={server ? loaded?.html ?? '' : undefined} title={title} sandbox="allow-scripts allow-popups" referrerPolicy="no-referrer"
    className="min-h-0 w-full flex-1 border-0" />
}
