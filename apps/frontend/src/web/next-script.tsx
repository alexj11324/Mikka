import { useEffect, useRef, type ScriptHTMLAttributes } from 'react'

type Props = Omit<ScriptHTMLAttributes<HTMLScriptElement>, 'onLoad' | 'onError'> & {
  strategy?: 'afterInteractive' | 'beforeInteractive' | 'lazyOnload' | 'worker'
  onReady?: () => void
  onLoad?: (event: Event) => void
  onError?: (event: Event) => void
}
const scripts = new Map<string, { element: HTMLScriptElement; promise: Promise<Event> }>()

/** The existing browser Turnstile component needs next/script's one-load,
 * onReady-on-each-mount contract, not any Next server runtime. */
export default function Script({ src, id, onReady, onLoad, onError, strategy: _strategy, ...attributes }: Props) {
  const callbacks = useRef({ onReady, onLoad, onError })
  callbacks.current = { onReady, onLoad, onError }
  useEffect(() => {
    if (!src) return
    let active = true
    const key = id || src
    let entry = scripts.get(key)
    const fresh = !entry
    if (!entry) {
      const element = document.createElement('script')
      element.src = src
      if (id) element.id = id
      for (const [name, value] of Object.entries(attributes)) {
        if (value === undefined || value === null || name === 'children' || name === 'dangerouslySetInnerHTML' || name.startsWith('on')) continue
        element.setAttribute(name, value === true ? '' : String(value))
      }
      const promise = new Promise<Event>((resolve, reject) => { element.addEventListener('load', resolve, { once: true }); element.addEventListener('error', reject, { once: true }) })
      entry = { element, promise }
      scripts.set(key, entry)
      document.head.append(element)
    }
    void entry.promise.then(event => {
      if (active) { if (fresh) callbacks.current.onLoad?.(event); callbacks.current.onReady?.() }
    }, event => { if (active) callbacks.current.onError?.(event as Event) })
    return () => { active = false }
  }, [src, id])
  return null
}
