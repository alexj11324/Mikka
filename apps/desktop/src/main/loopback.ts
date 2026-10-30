import { createServer, type Server } from 'node:http'

import { desktopAuthFinishUrl, desktopAuthState } from './security'

const COPY = {
  'zh-CN': { returning: '正在返回 Mikka…', invalid: '登录链接无效或已过期' },
  en: { returning: 'Returning to Mikka…', invalid: 'This sign-in link is invalid or expired' },
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
    response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': 'no-referrer' })
    response.end(`<!doctype html><html lang="${locale}"><meta charset="utf-8"><title>Mikka</title><p>${copy.returning}</p></html>`)
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
