// The page an HTML artifact is served as, inside <iframe sandbox="allow-scripts">.
// The response carries its own sandbox and CSP, so even opened on its own in a
// tab it runs in an opaque origin, cannot reach the app's cookies or storage,
// and cannot load or send anything outside itself. A small script goes in
// first: on the viewer's word it outlines what the pointer is over and
// reports the element clicked, for 选择元素 quoting.

/** Roles the frame names an element by; the viewer sends their words in the person's language. */
export const ELEMENT_ROLES = ['image', 'button', 'link', 'table', 'row', 'heading', 'paragraph', 'listItem', 'list', 'field', 'card', 'block'] as const
export type ElementRole = (typeof ELEMENT_ROLES)[number]

/** Messages from the viewer to the frame. */
export type ToFrame =
  | { source: 'mikka'; type: 'select'; on: boolean; roles: Record<ElementRole, string> }
  | { source: 'mikka'; type: 'mark'; selectors: string[] }
/** Messages from the frame to the viewer. */
export type FromFrame =
  | { source: 'mikka-frame'; type: 'ready' }
  | { source: 'mikka-frame'; type: 'quote'; selector: string; label: string; text: string; name?: string; context?: string }
  | { source: 'mikka-frame'; type: 'select-off' }

/**
 * Headers for the frame response. `sandbox allow-scripts` without
 * allow-same-origin gives the opaque origin; default-src 'none' with only
 * inline and data: sources means nothing leaves the page.
 */
export function frameHeaders(): Record<string, string> {
  return {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': [
      'sandbox allow-scripts allow-popups',
      "default-src 'none'",
      "script-src 'unsafe-inline'",
      "style-src 'unsafe-inline' data:",
      'img-src data: blob:',
      'font-src data:',
      'media-src data: blob:',
      "connect-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
      "frame-ancestors 'self'",
    ].join('; '),
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cross-origin-resource-policy': 'same-origin',
    'cache-control': 'private, max-age=300',
    'x-robots-tag': 'noindex',
  }
}

/** The script put in front of the artifact. Plain ES2017, no imports; runs inside the frame. */
function frameScript() {
  const ACCENT = '#2f6bff'
  const parentWindow = window.parent
  let selecting = false
  let roles: Record<string, string> = {}
  let marked: string[] = []
  let hovered: Element | null = null

  const host = document.createElement('mikka-overlay')
  host.setAttribute('style', 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;')
  const root = host.attachShadow({ mode: 'closed' })
  const style = document.createElement('style')
  style.textContent = `.box{position:fixed;box-sizing:border-box;border:2px solid ${ACCENT};border-radius:10px;pointer-events:none}.tag{position:absolute;left:-2px;top:-20px;height:18px;padding:0 6px;border-radius:4px;background:${ACCENT};color:#fff;font:500 11px/18px system-ui,-apple-system,"PingFang SC",sans-serif;white-space:nowrap}`
  root.appendChild(style)
  const layer = document.createElement('div')
  root.appendChild(layer)

  const send = (message: Record<string, unknown>) => parentWindow.postMessage(Object.assign({ source: 'mikka-frame' }, message), '*')
  const text = (element: Element) => (element.textContent || '').replace(/\s+/g, ' ').trim()
  const clip = (value: string, max: number) => value.length > max ? `${value.slice(0, max - 1)}…` : value

  function role(element: Element): string {
    const tag = element.tagName.toLowerCase()
    const aria = element.getAttribute('role')
    if (['img', 'svg', 'picture', 'canvas', 'video'].includes(tag) || aria === 'img') return 'image'
    if (tag === 'button' || aria === 'button') return 'button'
    if (tag === 'a') return 'link'
    if (tag === 'table') return 'table'
    if (tag === 'tr') return 'row'
    if (/^h[1-6]$/.test(tag)) return 'heading'
    if (tag === 'p') return 'paragraph'
    if (tag === 'li') return 'listItem'
    if (tag === 'ul' || tag === 'ol') return 'list'
    if (['input', 'textarea', 'select'].includes(tag)) return 'field'
    const computed = getComputedStyle(element)
    const framed = parseFloat(computed.borderTopWidth) > 0 || computed.boxShadow !== 'none' || (computed.backgroundColor !== 'rgba(0, 0, 0, 0)' && parseFloat(computed.borderTopLeftRadius) > 0)
    return framed ? 'card' : 'block'
  }

  function name(element: Element): string {
    const heading = /^h[1-6]$/i.test(element.tagName) ? element : element.querySelector('h1,h2,h3,h4,h5,h6,legend,caption,figcaption,strong,b')
    return clip(element.getAttribute('aria-label') || element.getAttribute('alt') || element.getAttribute('title') || (heading ? text(heading) : '') || text(element), 24)
  }

  /**
   * The name of the nearest named item around the element (a table row by its
   * first cell, a list item, a card or section by its heading), such as 「周会」
   * for a delete button in that row. Empty when none is found.
   */
  function context(element: Element): string {
    const own = name(element)
    let node = element.parentElement
    while (node && node !== document.body && node !== document.documentElement) {
      const tag = node.tagName.toLowerCase()
      const aria = node.getAttribute('role') || ''
      const row = tag === 'tr' || aria === 'row'
      if (row || ['li', 'article', 'section', 'fieldset', 'dialog'].includes(tag) || ['listitem', 'article', 'region', 'group', 'dialog'].includes(aria) || role(node) === 'card') {
        const cell = row ? node.querySelector('th,td,[role="cell"],[role="gridcell"],[role="rowheader"]') : null
        const heading = node.querySelector('h1,h2,h3,h4,h5,h6,legend,caption,figcaption,dt,strong,b')
        const words = clip(node.getAttribute('aria-label') || (cell ? text(cell) : '') || (heading ? text(heading) : ''), 24)
        if (words && words !== own) return words
      }
      node = node.parentElement
    }
    return ''
  }

  function label(element: Element): string {
    const words = roles[role(element)] || role(element)
    const named = name(element)
    return named ? `${words} · ${named}` : words
  }

  function selector(element: Element): string {
    if (element.id && document.querySelectorAll(`#${CSS.escape(element.id)}`).length === 1) return `#${CSS.escape(element.id)}`
    const parts: string[] = []
    let node: Element | null = element
    while (node && node !== document.body && node !== document.documentElement) {
      const tag = node.tagName.toLowerCase()
      const siblings: Element[] = node.parentElement ? Array.from(node.parentElement.children).filter(child => child.tagName === node!.tagName) : []
      parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag)
      node = node.parentElement
    }
    return ['body', ...parts].join(' > ')
  }

  function find(css: string): Element | null {
    try { return document.querySelector(css) } catch { return null }
  }

  function draw() {
    layer.textContent = ''
    const boxes: { element: Element; tag: string | null }[] = marked.flatMap(css => { const element = find(css); return element ? [{ element, tag: null }] : [] })
    if (selecting && hovered) boxes.push({ element: hovered, tag: label(hovered) })
    for (const { element, tag } of boxes) {
      const rect = element.getBoundingClientRect()
      const box = document.createElement('div')
      box.className = 'box'
      box.setAttribute('style', `left:${rect.left - 3}px;top:${rect.top - 3}px;width:${rect.width + 6}px;height:${rect.height + 6}px`)
      if (tag) {
        const chip = document.createElement('span')
        chip.className = 'tag'
        chip.textContent = tag
        box.appendChild(chip)
      }
      layer.appendChild(box)
    }
  }

  let frame = 0
  const redraw = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; draw() }) }

  /** The element worth quoting under the pointer: skips bare text wrappers for their box. */
  function pick(target: EventTarget | null): Element | null {
    let element = target instanceof Element ? target : null
    while (element && element !== document.body && ['span', 'em', 'strong', 'b', 'i', 'small', 'code', 'path', 'g', 'use'].includes(element.tagName.toLowerCase())) element = element.parentElement
    return element && element !== document.body && element !== document.documentElement ? element : null
  }

  document.addEventListener('mousemove', event => { if (!selecting) return; const next = pick(event.target); if (next !== hovered) { hovered = next; redraw() } }, true)
  document.addEventListener('click', event => {
    if (!selecting) return
    event.preventDefault()
    event.stopPropagation()
    const element = pick(event.target)
    if (!element) return
    send({ type: 'quote', selector: selector(element), label: label(element), text: clip(text(element), 2000), name: name(element), context: context(element) })
  }, true)
  document.addEventListener('keydown', event => { if (selecting && event.key === 'Escape') send({ type: 'select-off' }) }, true)
  window.addEventListener('scroll', redraw, true)
  window.addEventListener('resize', redraw)
  window.addEventListener('message', event => {
    if (event.source !== parentWindow) return
    const data = event.data as { source?: string; type?: string; on?: boolean; roles?: Record<string, string>; selectors?: string[] }
    if (!data || data.source !== 'mikka') return
    if (data.type === 'select') {
      selecting = Boolean(data.on)
      roles = data.roles || roles
      if (!selecting) hovered = null
      document.documentElement.style.cursor = selecting ? 'crosshair' : ''
    }
    if (data.type === 'mark') marked = Array.isArray(data.selectors) ? data.selectors.filter(item => typeof item === 'string').slice(0, 50) : []
    redraw()
  })
  const mount = () => { (document.body || document.documentElement).appendChild(host); send({ type: 'ready' }) }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount)
  else mount()
}

/**
 * The quoting script as source. The app-wide browser also puts it into pages of
 * the app's own origin, which it can reach, so picking an element there works
 * and looks the same as in an artifact.
 */
export const FRAME_SCRIPT = `(${frameScript.toString()})()`

const SCRIPT = `<script>${FRAME_SCRIPT}</script>`

/** The artifact with the quoting script in front, so it runs before the page's own scripts. */
export function frameDocument(html: string): string {
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)
  return doctype ? `${doctype[0]}${SCRIPT}${html.slice(doctype[0].length)}` : `${SCRIPT}${html}`
}
