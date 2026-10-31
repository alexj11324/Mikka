'use client'

import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import Script from 'next/script'
import { useLocale } from 'next-intl'

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'

interface TurnstileApi {
  render(container: HTMLElement, options: Record<string, unknown>): string
  reset(widgetId: string): void
  remove(widgetId: string): void
}

declare global {
  interface Window { turnstile?: TurnstileApi }
}

export type TurnstileHandle = { reset(): void }

/**
 * Cloudflare Turnstile (#527). Managed mode is set on the widget in Cloudflare;
 * without a site key (local, previews) nothing renders and no token is sent.
 * A token is single-use: the form resets the widget after each request.
 */
export function Turnstile({ ref, onToken, siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY }: { ref?: Ref<TurnstileHandle>; onToken: (token: string | null) => void; siteKey?: string }) {
  const locale = useLocale()
  const container = useRef<HTMLDivElement>(null)
  const widget = useRef<string | null>(null)
  const api = useRef<TurnstileApi | null>(null)
  const [loaded, setLoaded] = useState(false)
  const tokenRef = useRef(onToken)
  useEffect(() => { tokenRef.current = onToken }, [onToken])

  useImperativeHandle(ref, () => ({
    reset() {
      tokenRef.current(null)
      if (api.current && widget.current) api.current.reset(widget.current)
    },
  }), [])

  useEffect(() => {
    const turnstile = window.turnstile
    if (!siteKey || !loaded || !turnstile || !container.current) return
    api.current = turnstile
    const id = turnstile.render(container.current, {
      sitekey: siteKey,
      theme: 'auto',
      size: 'flexible',
      language: locale === 'zh-CN' ? 'zh-cn' : 'en',
      callback: (token: string) => tokenRef.current(token),
      'expired-callback': () => tokenRef.current(null),
      'error-callback': () => { tokenRef.current(null) },
    })
    widget.current = id
    return () => {
      turnstile.remove(id)
      widget.current = null
    }
  }, [siteKey, loaded, locale])

  if (!siteKey) return null
  return <>
    <Script src={SCRIPT_SRC} strategy="afterInteractive" onReady={() => setLoaded(true)} />
    <div ref={container} data-slot="turnstile" className="min-h-[65px] w-full" />
  </>
}
