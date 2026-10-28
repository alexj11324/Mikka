import { createServer, type Server } from 'node:http'
import { test, expect, type Browser, type BrowserContext } from '@playwright/test'
import { installAccountOriginFence } from './test-account-network'

// Transport-only Chromium regressions. These servers have no application data,
// auth endpoint or private credential. Existing pool/HTTP cases separately test
// the genuine authentication and PG lease lifecycle.
test.use({ trace: 'off', video: 'off', screenshot: 'off' })

const cookie = { name: 'synthetic-origin-fence-cookie', value: 'not-an-authentication-credential', domain: 'localhost', path: '/', httpOnly: true, secure: false, sameSite: 'Lax' as const }

async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('ORIGIN_FENCE_TEST_BIND_FAILED')
  return `http://localhost:${address.port}`
}

async function stop(server: Server) {
  if (!server.listening) return
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

async function fixture(browser: Browser, use: (value: {
  context: BrowserContext; origin: string; foreignOrigin: string
  blocked: () => number; foreignHits: () => number; websocketHits: () => number
  allowedCookieSeen: () => boolean; failures: string[]
}) => Promise<void>) {
  let foreignRequests = 0, websocketRequests = 0, allowedCookie = false
  const foreign = createServer((_request, response) => {
    foreignRequests++
    response.end('controlled foreign sink')
  })
  foreign.on('upgrade', (_request, socket) => { websocketRequests++; socket.destroy() })
  const foreignOrigin = await listen(foreign)
  const allowed = createServer((request, response) => {
    if (request.headers.cookie?.includes(`${cookie.name}=${cookie.value}`)) allowedCookie = true
    const path = new URL(request.url ?? '/', 'http://localhost').pathname
    const redirect = (location: string, status = 302) => { response.writeHead(status, { location }); response.end() }
    if (path === '/same-start') return redirect('/same-middle')
    if (path === '/same-middle') return redirect('/final', 307)
    if (path === '/foreign-direct') return redirect(`${foreignOrigin}/blocked`)
    if (path === '/foreign-via') return redirect('/foreign-middle')
    if (path === '/foreign-middle') return redirect(`${foreignOrigin}/blocked`, 307)
    if (path === '/popup') { response.setHeader('content-type', 'text/html'); response.end('<a id="foreign" target="_blank" href="/foreign-via">foreign chain</a><a id="same" target="_blank" href="/same-start">same chain</a>'); return }
    if (path === '/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      response.write('data: origin-fence-ready\n\n')
      // Keep the stream open until Chromium cancels. Buffering the whole body
      // in a route.fetch proxy would prevent the first read from completing.
      return
    }
    response.setHeader('content-type', 'text/html')
    response.end('<p>controlled allowed response</p>')
  })
  const origin = await listen(allowed).catch(async error => { await stop(foreign); throw error })
  let context: BrowserContext | undefined
  try {
    // Independent, cookie-free Chromium canaries establish that the sink really
    // is reachable on this runner. Zero hits below cannot be a dead-port pass.
    const neutral = await browser.newContext()
    try {
      const page = await neutral.newPage()
      const response = await page.goto(`${foreignOrigin}/canary`)
      expect(response?.status()).toBe(200)
      await page.evaluate(url => new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('ORIGIN_FENCE_CANARY_TIMEOUT')), 5000)
        const socket = new WebSocket(url)
        socket.onopen = () => { clearTimeout(timeout); socket.close(); resolve() }
        socket.onerror = () => { clearTimeout(timeout); resolve() }
      }), foreignOrigin.replace('http:', 'ws:') + '/canary')
      expect(foreignRequests).toBeGreaterThan(0)
      expect(websocketRequests).toBe(1)
    } finally { await neutral.close() }
    foreignRequests = 0; websocketRequests = 0

    let blocked = 0
    const failures: string[] = []
    context = await browser.newContext({ serviceWorkers: 'block' })
    await context.addCookies([cookie])
    await installAccountOriginFence(context, { assertActive: async () => {} }, origin,
      () => { blocked++ }, () => { failures.push('ORIGIN_FENCE_FAILED') })
    await use({ context, origin, foreignOrigin, blocked: () => blocked,
      foreignHits: () => foreignRequests, websocketHits: () => websocketRequests,
      allowedCookieSeen: () => allowedCookie, failures })
    expect(failures).toEqual([])
  } finally {
    await context?.close()
    await Promise.all([stop(allowed), stop(foreign)])
  }
}

test('origin fence preserves same-origin redirect cookies and streaming browser responses', async ({ browser }) => {
  await fixture(browser, async f => {
    const page = await f.context.newPage()
    await page.goto(`${f.origin}/same-start`)
    await expect(page).toHaveURL(`${f.origin}/final`)
    await expect(page.locator('p')).toHaveText('controlled allowed response')
    expect(f.allowedCookieSeen()).toBe(true)
    const first = await page.evaluate(async () => {
      const abort = new AbortController()
      const timeout = setTimeout(() => abort.abort(), 5000)
      try {
        const response = await fetch('/events', { signal: abort.signal })
        const row = await response.body!.getReader().read()
        return new TextDecoder().decode(row.value)
      } finally { clearTimeout(timeout); abort.abort() }
    })
    expect(first).toContain('origin-fence-ready')
    expect(f.blocked()).toBe(0)
    expect(f.foreignHits()).toBe(0)
  })
})

test('origin fence blocks direct and same-origin-then-cross-port redirect hops before the sink receives a request', async ({ browser }) => {
  await fixture(browser, async f => {
    const page = await f.context.newPage()
    for (const path of ['/foreign-direct', '/foreign-via']) {
      let rejected = false
      try { await page.goto(f.origin + path) } catch { rejected = true }
      expect(rejected).toBe(true)
    }
    expect(f.blocked()).toBe(2)
    expect(f.foreignHits()).toBe(0)
  })
})

test('origin fence is installed before popup redirect response headers are released', async ({ browser }) => {
  await fixture(browser, async f => {
    const page = await f.context.newPage()
    await page.goto(`${f.origin}/popup`)
    const samePopup = f.context.waitForEvent('page')
    await page.locator('#same').click()
    const same = await samePopup
    await expect(same).toHaveURL(`${f.origin}/final`)
    await expect(same.locator('p')).toHaveText('controlled allowed response')
    await same.close()
    await page.locator('#foreign').click()
    await expect.poll(f.blocked).toBe(1)
    expect(f.foreignHits()).toBe(0)
  })
})

test('origin fence refuses WebSockets locally without an upstream connection', async ({ browser }) => {
  await fixture(browser, async f => {
    const page = await f.context.newPage()
    await page.goto(`${f.origin}/final`)
    for (const target of [f.origin, f.foreignOrigin]) {
      const closed = await page.evaluate(url => new Promise<boolean>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('ORIGIN_FENCE_WEBSOCKET_TIMEOUT')), 5000)
        const socket = new WebSocket(url)
        socket.onclose = () => { clearTimeout(timeout); resolve(true) }
        socket.onerror = () => { clearTimeout(timeout); resolve(true) }
        socket.onopen = () => { clearTimeout(timeout); socket.close(); resolve(false) }
      }), target.replace('http:', 'ws:') + '/blocked')
      expect(closed).toBe(true)
    }
    expect(f.blocked()).toBe(2)
    expect(f.websocketHits()).toBe(0)
    expect(f.foreignHits()).toBe(0)
  })
})
