import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { loopbackLocale, sendReturnPage, type LoopbackAuthServer } from './loopback'

/** A one-shot code receiver. State/verifier and the received code never visit a renderer.
 * `link` is the app link the callback page opens to bring the app forward. */
export async function startBundledLoopback(state: string, received: (code: string) => void, link?: string): Promise<LoopbackAuthServer> {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(state)) throw new Error('Invalid desktop nonce')
  let used = false
  let expectedHost = ''
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
    response.setHeader('X-Content-Type-Options', 'nosniff')
    const reject = () => { response.writeHead(400); response.end('Invalid or expired sign-in / 登录无效或已过期') }
    if (used || request.method !== 'GET' || request.headers.host !== expectedHost || !request.url?.startsWith('/auth/callback?') || request.url.length > 2048) { reject(); return }
    const url = new URL(request.url, `http://${expectedHost}`)
    const returned = url.searchParams.get('state') ?? ''
    const code = url.searchParams.get('code') ?? ''
    if (url.pathname !== '/auth/callback' || url.searchParams.getAll('state').length !== 1 || url.searchParams.getAll('code').length !== 1 || !/^[A-Za-z0-9_-]{32,128}$/.test(code) || !/^[A-Za-z0-9_-]{32,128}$/.test(returned) || returned.length !== state.length || !timingSafeEqual(Buffer.from(returned), Buffer.from(state))) { reject(); return }
    used = true
    // Its headers take precedence: the page allows only its own nonce'd script and style.
    sendReturnPage(response, loopbackLocale(request.headers['accept-language']), link)
    server.close()
    received(code)
  })
  server.requestTimeout = 10_000
  server.headersTimeout = 10_000
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') { server.close(); throw new Error('Unable to start sign-in listener') }
  expectedHost = `127.0.0.1:${address.port}`
  return { callback: `http://${expectedHost}/auth/callback`, close() { used = true; server.close(); server.closeAllConnections() } }
}
