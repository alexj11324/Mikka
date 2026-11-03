import { createServer, type Server } from 'node:http'

import { loopbackLocale } from './loopback'

/**
 * Where a link the app started in the system browser comes back (Plugins →
 * GitHub, RFC 8252 §7.3): a one-shot listener on 127.0.0.1 that accepts only
 * /return with the state the renderer registered. The browser shows one line;
 * the app is told the result and finishes the link itself. No custom URL
 * scheme is registered.
 */
export type ReturnResult = 'connected' | 'failed' | 'cancelled'
const RESULTS: readonly ReturnResult[] = ['connected', 'failed', 'cancelled']
const STATE = /^[A-Za-z0-9_-]{43}$/

const COPY = {
  'zh-CN': { connected: '已连接，可以回到 Mikka。', failed: '没有连上，回到 Mikka 查看。', cancelled: '已取消，可以回到 Mikka。', invalid: '链接无效或已过期' },
  en: { connected: 'Connected. You can return to Mikka.', failed: 'Not connected. Return to Mikka for details.', cancelled: 'Cancelled. You can return to Mikka.', invalid: 'This link is invalid or expired' },
} as const

export interface ReturnListener { returnTo: string; close(): void }

export async function startReturnListener(options: { state: unknown; onReturn: (result: ReturnResult) => void }): Promise<ReturnListener> {
  if (typeof options.state !== 'string' || !STATE.test(options.state)) throw new Error('A return state is required')
  const state = options.state
  let closed = false
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (request.method !== 'GET' || url.pathname !== '/return') { response.writeHead(404, { 'Cache-Control': 'no-store' }); response.end(); return }
    const copy = COPY[loopbackLocale(request.headers['accept-language'])]
    const result = url.searchParams.get('result') as ReturnResult | null
    if (url.searchParams.get('state') !== state || !result || !RESULTS.includes(result)) {
      response.writeHead(400, { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' })
      response.end(copy.invalid)
      return
    }
    response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'" })
    response.end(`<!doctype html><html lang="${loopbackLocale(request.headers['accept-language'])}"><meta charset="utf-8"><title>Mikka</title><p>${copy[result]}</p></html>`)
    close()
    options.onReturn(result)
  })
  function close() {
    if (closed) return
    closed = true
    server.close()
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  }).catch(error => { server.close(); throw error })
  const address = server.address()
  if (!address || typeof address === 'string') { server.close(); throw new Error('The return listener did not start') }
  return { returnTo: `http://127.0.0.1:${address.port}/return`, close }
}
