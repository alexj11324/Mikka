import { createServer, type Server } from 'node:http'

const PORT = 54545
const REDIRECT = `http://localhost:${PORT}/callback`
const STATE = /^[A-Za-z0-9_-]{43}$/
const LIFETIME_MS = 5 * 60_000
const PAGE = '<!doctype html><html><meta charset="utf-8"><title>Mikka</title><p>You can close this tab and return to Mikka. 可以关闭此页面并返回 Mikka。</p></html>'
const HEADERS = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'" }

/** The state of a Claude sign-in page that returns to the registered callback, else null. */
export function claudeAuthorizationState(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 4096) return null
  try {
    const url = new URL(raw)
    const state = url.searchParams.get('state')
    if (url.origin !== 'https://claude.ai' || url.username || url.password || url.searchParams.get('redirect_uri') !== REDIRECT || !state || !STATE.test(state)) return null
    return state
  } catch { return null }
}

let stopCurrent: (() => void) | null = null

/**
 * Opens the sign-in page and catches its return on Claude's registered loopback
 * port, so nobody copies a callback address by hand. Resolves with the full
 * callback URL, or null when the sign-in was declined, replaced or timed out.
 * Rejects when the page is not Claude's or the port is taken: the page then
 * offers the manual paste. The code goes back to the app's page, never to disk.
 */
export async function catchClaudeCallback(authorizationUrl: unknown, open: (url: string) => Promise<void>, lifetime = LIFETIME_MS): Promise<string | null> {
  const state = claudeAuthorizationState(authorizationUrl)
  if (!state) throw new Error('Not a Claude sign-in page')
  stopCurrent?.()
  let settle: (value: string | null) => void = () => undefined
  const result = new Promise<string | null>(resolve => { settle = resolve })
  let timer: NodeJS.Timeout | undefined
  const finish = (value: string | null) => {
    if (stopCurrent === stop) stopCurrent = null
    clearTimeout(timer)
    server.close()
    server.closeAllConnections()
    settle(value)
  }
  const stop = () => finish(null)
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', REDIRECT)
    if (request.method !== 'GET' || url.pathname !== '/callback' || url.searchParams.get('state') !== state) {
      response.writeHead(404, HEADERS).end()
      return
    }
    const code = url.searchParams.get('code')
    response.writeHead(200, { ...HEADERS, 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' }).end(PAGE, () => finish(code ? url.href : null))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(PORT, 'localhost', () => resolve())
  })
  stopCurrent = stop
  timer = setTimeout(stop, lifetime)
  timer.unref()
  try { await open(authorizationUrl as string) } catch (error) { stop(); throw error }
  return result
}
