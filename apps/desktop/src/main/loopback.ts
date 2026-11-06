import { randomBytes } from 'node:crypto'
import { createServer, type Server, type ServerResponse } from 'node:http'

import { desktopAuthFinishUrl, desktopAuthState } from './security'

const COPY = {
  'zh-CN': { returning: '正在返回 Mikka…', invalid: '登录链接无效或已过期', done: '已登录，可以关闭此页', open: '打开 Mikka' },
  en: { returning: 'Returning to Mikka…', invalid: 'This sign-in link is invalid or expired', done: 'Signed in. You can close this page.', open: 'Open Mikka' },
} as const

type LoopbackLocale = keyof typeof COPY

/** The system browser's preferred language; Chinese is the app default. */
export function loopbackLocale(acceptLanguage: string | undefined): LoopbackLocale {
  const tags = (acceptLanguage ?? '').split(',').map((part, index) => {
    const [tag = '', ...params] = part.trim().toLowerCase().split(';')
    const q = Number(params.find(param => param.trim().startsWith('q='))?.trim().slice(2) ?? 1)
    return { tag, q: Number.isFinite(q) ? q : 0, index }
  }).filter(item => item.q > 0).sort((a, b) => b.q - a.q || a.index - b.index)
  for (const { tag } of tags) {
    if (tag === 'zh' || tag.startsWith('zh-')) return 'zh-CN'
    if (tag === 'en' || tag.startsWith('en-')) return 'en'
  }
  return 'zh-CN'
}

const escape = (value: string) => value.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`)

/**
 * The browser tab's last page. With an app link, it opens the link at once:
 * the system brings the app to the front, which the app cannot do itself on
 * macOS. Then it tries to close the tab; a browser that refuses (the tab has
 * history) shows that sign-in is done, and the link again as a button.
 */
export function sendReturnPage(response: ServerResponse, locale: LoopbackLocale, link?: string): void {
  const copy = COPY[locale]
  if (!link) {
    response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" })
    response.end(`<!doctype html><html lang="${locale}"><meta charset="utf-8"><title>Mikka</title><p>${copy.returning}</p></html>`)
    return
  }
  const nonce = randomBytes(16).toString('base64')
  response.writeHead(200, {
    'Cache-Control': 'no-store', 'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  })
  response.end(`<!doctype html><html lang="${locale}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mikka</title>`
    + `<style nonce="${nonce}">body{font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f5f4;color:#1c1917}main{display:flex;flex-direction:column;align-items:center;gap:1rem;padding:2rem;text-align:center}p{margin:0}a{padding:.5rem 1rem;border-radius:.5rem;background:#1c1917;color:#fafaf9;font-size:.875rem;font-weight:500;text-decoration:none}a[hidden]{display:none}@media (prefers-color-scheme:dark){body{background:#0c0a09;color:#fafaf9}a{background:#fafaf9;color:#1c1917}}</style>`
    + `<main><p id="status">${copy.returning}</p><a id="open" href="${escape(link)}" hidden>${copy.open}</a></main>`
    + `<script nonce="${nonce}">(()=>{const status=document.getElementById('status'),open=document.getElementById('open');location.href=open.href;setTimeout(()=>{window.close();status.textContent=${JSON.stringify(copy.done)};open.hidden=false},1000)})()</script></html>`)
}

export interface LoopbackAuthServer {
  callback: string
  close(): void
}

/**
 * A one-shot listener for the OAuth return. It is bound to 127.0.0.1, echoes
 * the nonce the renderer registered, and hands back only the in-app finish
 * URL. The caller owns the lifetime and closes it on timeout or quit.
 */
export async function startLoopbackAuth(options: {
  state: unknown
  appUrl: string
  /** Opened by the callback page to bring the app forward (app-link.ts). */
  link?: string
  onFinish: (finishUrl: string) => void
}): Promise<LoopbackAuthServer> {
  const state = desktopAuthState(options.state)
  if (!state) throw new Error('A desktop nonce is required')
  let closed = false
  const server: Server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (request.method !== 'GET' || requestUrl.pathname !== '/auth/callback') {
      response.writeHead(404, { 'Cache-Control': 'no-store' })
      response.end()
      return
    }
    const code = requestUrl.searchParams.get('code')
    const returnedState = requestUrl.searchParams.get('state')
    const next = requestUrl.searchParams.get('next') ?? '/'
    const locale = loopbackLocale(request.headers['accept-language'])
    const copy = COPY[locale]
    const finish = returnedState === state ? desktopAuthFinishUrl(code, returnedState, next, options.appUrl) : null
    if (!finish) {
      response.writeHead(400, { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' })
      response.end(copy.invalid)
      close()
      return
    }
    sendReturnPage(response, locale, options.link)
    close()
    options.onFinish(finish)
  })
  function close() {
    if (closed) return
    closed = true
    server.close()
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  }).catch(error => {
    server.close()
    throw error
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('The sign-in listener did not start')
  }
  const callback = `http://127.0.0.1:${address.port}/auth/callback`
  return {
    callback,
    close,
  }
}
