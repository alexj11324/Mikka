import { createServer, type Server } from 'node:http'
import { test, expect, type Browser, type BrowserContext, type CDPSession } from '@playwright/test'
import { installAccountOriginFence } from './test-account-network'
import { SYNTHETIC_PNG } from '../helpers/browser-image'

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
  initialPopupHits: () => number
  detachProtection: () => Promise<void>
}) => Promise<void>, options: { failProtocolAbort?: boolean; expectFailure?: boolean; failClose?: 'page' | 'context'; localImage?: boolean; slowLease?: boolean; pausedLease?: { entered: () => void; released: Promise<void>; canceled: () => void; continued?: () => void } } = {}) {
  let foreignRequests = 0, websocketRequests = 0, allowedCookie = false, initialPopupRequests = 0
  const foreign = createServer((_request, response) => {
    foreignRequests++
    response.end('controlled foreign sink')
  })
  foreign.on('upgrade', (_request, socket) => { websocketRequests++; socket.destroy() })
  const foreignOrigin = await listen(foreign)
  const allowed = createServer((request, response) => {
    if (request.headers.cookie?.includes(`${cookie.name}=${cookie.value}`)) allowedCookie = true
    const path = new URL(request.url ?? '/', 'http://localhost').pathname
    if (path === '/same-start' || path === '/foreign-via') initialPopupRequests++
    const redirect = (location: string, status = 302) => { response.writeHead(status, { location }); response.end() }
    if (path === '/same-start') return redirect('/same-middle')
    if (path === '/same-middle') return redirect('/final', 307)
    if (path === '/foreign-direct') return redirect(`${foreignOrigin}/blocked`)
    if (path === '/foreign-via') return redirect('/foreign-middle')
    if (path === '/foreign-middle') return redirect(`${foreignOrigin}/blocked`, 307)
    if (path === '/fixture-image') return redirect(`${foreignOrigin}/fixture.png`)
    if (path === '/busy') {
      response.setHeader('content-type', 'text/html')
      response.end("<p>controlled allowed response</p><script>setInterval(() => { fetch('/poll?' + Math.random()).catch(() => {}) }, 5)</script>")
      return
    }
    if (path === '/popup') { response.setHeader('content-type', 'text/html'); response.end('<a id="foreign" target="_blank" href="/foreign-via">foreign chain</a><a id="same" target="_blank" href="/same-start">same chain</a>'); return }
    if (path === '/worker.js') {
      response.setHeader('content-type', 'text/javascript')
      response.end("onmessage = async event => { try { await fetch(event.data); postMessage('unexpected-success') } catch { postMessage('blocked') } }")
      return
    }
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
    if (options.failClose === 'context') {
      const close = context.close.bind(context)
      let injected = false
      Object.defineProperty(context, 'close', { configurable: true, value: async (...args: Parameters<BrowserContext['close']>) => {
        if (!injected) { injected = true; throw new Error('SYNTHETIC_CLOSE_FAILURE') }
        return close(...args)
      } })
    }
    const protectionSessions: CDPSession[] = []
    const pausedLease = options.pausedLease
    let holdLease = false
    const createSession = context.newCDPSession.bind(context)
    Object.defineProperty(context, 'newCDPSession', { value: async (page: Parameters<typeof createSession>[0]) => {
      const session = await createSession(page)
      protectionSessions.push(session)
      if (pausedLease) {
        let pendingNetworkId: string | undefined
        let pendingRequestId: string | undefined
        session.on('Fetch.requestPaused', event => {
          if (new URL(event.request.url).pathname === '/pending-cancel') {
            pendingNetworkId = event.networkId
            pendingRequestId = event.requestId
            holdLease = true
          }
        })
        session.on('Network.loadingFailed', event => {
          if (pendingNetworkId && event.requestId === pendingNetworkId && event.canceled === true) pausedLease.canceled()
        })
        await session.send('Network.enable')
        const send = session.send.bind(session)
        Object.defineProperty(session, 'send', { value: async (method: string, params?: { requestId?: string }) => {
          try { return await Reflect.apply(send, session, [method, params]) }
          finally { if (method === 'Fetch.continueRequest' && params?.requestId === pendingRequestId) pausedLease.continued?.() }
        } })
      }
      if (options.failClose === 'page') {
        Object.defineProperty(page, 'close', { configurable: true, value: async () => { throw new Error('SYNTHETIC_CLOSE_FAILURE') } })
      }
      if (options.failProtocolAbort) {
        const send = session.send.bind(session)
        Object.defineProperty(session, 'send', { value: async (method: string, params?: unknown) => {
          if (method === 'Fetch.failRequest') throw new Error('SYNTHETIC_PROTOCOL_ABORT_FAILURE')
          return Reflect.apply(send, session, [method, params])
        } })
      }
      return session
    } })
    await installAccountOriginFence(context, { assertActive: async () => {
      // The pooled lease check is a database round trip, not a microtask.
      if (options.slowLease) await new Promise(resolve => setTimeout(resolve, 2))
      if (holdLease && pausedLease) { holdLease = false; pausedLease.entered(); await pausedLease.released }
    } }, origin,
      () => { blocked++ }, () => { failures.push('ORIGIN_FENCE_FAILED') },
      options.localImage ? [{ url: `${foreignOrigin}/fixture.png`, body: SYNTHETIC_PNG }] : [])
    await use({ context, origin, foreignOrigin, blocked: () => blocked,
      foreignHits: () => foreignRequests, websocketHits: () => websocketRequests,
      allowedCookieSeen: () => allowedCookie, initialPopupHits: () => initialPopupRequests, failures,
      detachProtection: async () => { await protectionSessions[0].detach() } })
    expect(failures).toEqual(options.failProtocolAbort || options.expectFailure ? ['ORIGIN_FENCE_FAILED'] : [])
  } finally {
    await context?.close()
    await Promise.all([stop(allowed), stop(foreign)])
  }
}

test('origin fence decodes only the exact local fixture image without contacting the reachable foreign sink', async ({ browser }) => {
  await fixture(browser, async f => {
    const page = await f.context.newPage()
    let browserErrors = 0
    page.on('console', message => { if (message.type() === 'error') browserErrors++ })
    page.on('pageerror', () => { browserErrors++ })
    await page.goto(`${f.origin}/final`)
    // Direct requests exercise routing; the same-origin redirect also reaches
    // the independent CDP gate. Neither may continue to the foreign server.
    for (const url of [`${f.foreignOrigin}/fixture.png`, `${f.origin}/fixture-image`]) {
      const decoded = await page.evaluate(async src => {
        const image = new Image()
        document.body.append(image)
        image.src = src
        await image.decode()
        return { complete: image.complete, width: image.naturalWidth, height: image.naturalHeight }
      }, url)
      expect(decoded).toEqual({ complete: true, width: 1, height: 1 })
    }
    expect(f.foreignHits()).toBe(0)
    expect(f.blocked()).toBe(0)
    expect(browserErrors).toBe(0)

    // The identical URL is still forbidden as a fetch, and adding a query
    // does not turn another image request into the registered static fixture.
    expect(await page.evaluate(async url => {
      try { await fetch(url, { mode: 'no-cors', credentials: 'include' }); return false } catch { return true }
    }, `${f.foreignOrigin}/fixture.png`)).toBe(true)
    expect(await page.evaluate(async src => {
      const image = new Image()
      image.src = src
      try { await image.decode(); return false } catch { return true }
    }, `${f.foreignOrigin}/fixture.png?unregistered=1`)).toBe(true)
    await expect.poll(f.blocked).toBe(2)
    expect(f.foreignHits()).toBe(0)
  }, { localImage: true })
})

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
    await page.close()
    const nextPage = await f.context.newPage()
    await nextPage.goto(`${f.origin}/final`)
    await expect(nextPage.locator('p')).toHaveText('controlled allowed response')
  })
})

test('origin fence survives an exact canceled request during its lease check and still fences after reload', async ({ browser }) => {
  let releaseLease!: () => void
  const released = new Promise<void>(resolve => { releaseLease = resolve })
  let entered = false, canceled = false
  try {
    await fixture(browser, async f => {
      const page = await f.context.newPage()
      await page.goto(`${f.origin}/final`)
      const controller = await page.evaluateHandle(() => new AbortController())
      await page.evaluate(abort => { void fetch('/pending-cancel', { signal: abort.signal }).catch(() => {}) }, controller)
      await expect.poll(() => entered).toBe(true)
      await controller.evaluate(abort => abort.abort())
      await expect.poll(() => canceled).toBe(true)
      releaseLease()
      await controller.dispose()
      await page.reload()
      await expect(page.locator('p')).toHaveText('controlled allowed response')
      expect(f.context.isClosed()).toBe(false)
      expect(f.failures).toEqual([])
      expect(await page.evaluate(async () => {
        try { await fetch('/foreign-via'); return false } catch { return true }
      })).toBe(true)
      await expect.poll(f.blocked).toBe(1)
      expect(f.foreignHits()).toBe(0)
    }, { pausedLease: { entered: () => { entered = true }, released, canceled: () => { canceled = true } } })
  } finally { releaseLease() }
})

test('origin fence survives reload replacing a paused subrequest document without a loadingFailed event', async ({ browser }) => {
  let releaseLease!: () => void, continued!: () => void
  const released = new Promise<void>(resolve => { releaseLease = resolve })
  const resumed = new Promise<void>(resolve => { continued = resolve })
  let entered = false
  try {
    await fixture(browser, async f => {
      const page = await f.context.newPage()
      await page.goto(`${f.origin}/final`)
      await page.evaluate(() => { void fetch('/pending-cancel').catch(() => {}) })
      await expect.poll(() => entered).toBe(true)
      // Chromium retires this paused interception when committing the new
      // document, but need not emit loadingFailed on the fence's CDP session.
      await page.reload()
      releaseLease()
      await resumed
      await expect(page.locator('p')).toHaveText('controlled allowed response')
      expect(f.context.isClosed()).toBe(false)
      expect(await page.evaluate(async () => {
        try { await fetch('/foreign-via'); return false } catch { return true }
      })).toBe(true)
      await expect.poll(f.blocked).toBe(1)
      expect(f.foreignHits()).toBe(0)
      expect(f.failures).toEqual([])
    }, { pausedLease: { entered: () => { entered = true }, released, canceled: () => {}, continued } })
  } finally { releaseLease() }
})

test('origin fence survives reloads that discard many paused same-origin requests', async ({ browser }) => {
  await fixture(browser, async f => {
    const page = await f.context.newPage()
    await page.goto(`${f.origin}/busy`)
    for (let reload = 0; reload < 10; reload++) await page.reload()
    await expect(page.locator('p')).toHaveText('controlled allowed response')
    expect(f.context.isClosed()).toBe(false)
    expect(await page.evaluate(async () => {
      try { await fetch('/foreign-via'); return false } catch { return true }
    })).toBe(true)
    await expect.poll(f.blocked).toBe(1)
    expect(f.foreignHits()).toBe(0)
    expect(f.failures).toEqual([])
  }, { slowLease: true })
})

test('origin fence blocks direct and same-origin-then-cross-port redirect hops before the sink receives a request', async ({ browser }) => {
  await fixture(browser, async f => {
    const page = await f.context.newPage()
    for (const [index, path] of ['/foreign-direct', '/foreign-via'].entries()) {
      try { await page.goto(f.origin + path) } catch { /* Chromium may throw or retain the blocked redirect response. */ }
      finally { expect(f.foreignHits()).toBe(0) }
      await expect.poll(f.blocked).toBe(index + 1)
      expect(page.url()).not.toContain(f.foreignOrigin)
      await expect(page.locator('body')).not.toHaveText('controlled foreign sink')
    }
    expect(f.blocked()).toBe(2)
    expect(f.foreignHits()).toBe(0)
  })
})

test('origin fence refuses unregistered popup navigation before either redirect chain reaches a server', async ({ browser }) => {
  await fixture(browser, async f => {
    const page = await f.context.newPage()
    await page.goto(`${f.origin}/popup`)
    const samePopup = f.context.waitForEvent('page')
    await page.locator('#same').click()
    const same = await samePopup
    await expect.poll(f.blocked).toBe(1)
    expect(f.initialPopupHits()).toBe(0)
    expect(f.foreignHits()).toBe(0)
    expect(same.url()).not.toBe(`${f.origin}/final`)
    await same.close()
    await page.locator('#foreign').click()
    await expect.poll(f.blocked).toBe(2)
    expect(f.initialPopupHits()).toBe(0)
    expect(f.foreignHits()).toBe(0)
  })
})

test('origin fence counts an aborted foreign navigation once and never sends it to the reachable sink', async ({ browser }) => {
  await fixture(browser, async f => {
    const page = await f.context.newPage()
    let rejected = false
    try { await page.goto(`${f.foreignOrigin}/blocked`) } catch { rejected = true }
    finally { expect(f.foreignHits()).toBe(0) }
    expect(rejected).toBe(true)
    await expect.poll(f.blocked).toBe(1)
  })
})

test('origin fence blocks a browser fetch redirect before it can carry cookies to the reachable sink', async ({ browser }) => {
  await fixture(browser, async f => {
    const page = await f.context.newPage()
    await page.goto(`${f.origin}/final`)
    const refusalsAtRequestFailure: number[] = []
    const refusalsAtConsoleError: number[] = []
    page.on('requestfailed', request => {
      if (request.resourceType() === 'fetch') refusalsAtRequestFailure.push(f.blocked())
    })
    page.on('console', message => {
      if (message.type() === 'error' && message.text() === 'Failed to load resource: net::ERR_BLOCKED_BY_CLIENT') refusalsAtConsoleError.push(f.blocked())
    })
    try {
      const result = await page.evaluate(async () => {
        try { await fetch('/foreign-via'); return 'unexpected-success' } catch { return 'blocked' }
      })
      expect(result).toBe('blocked')
    } finally { expect(f.foreignHits()).toBe(0) }
    await expect.poll(f.blocked).toBe(1)
    // Chromium reports this rejected request through Network.loadingFailed /
    // requestfailed. A caught fetch need not also print a console error.
    // Require an actual browser failure event and its refusal snapshot; retain
    // the same ordering check for any console event Chromium does emit.
    await expect.poll(() => refusalsAtRequestFailure.length).toBeGreaterThan(0)
    expect(refusalsAtRequestFailure.every(count => count === 1)).toBe(true)
    expect(refusalsAtConsoleError.every(count => count === 1)).toBe(true)
  })
})

test('origin fence closes the context and reports failure when the protocol cannot abort a redirect', async ({ browser }) => {
  await fixture(browser, async f => {
    const page = await f.context.newPage()
    try { await page.goto(`${f.origin}/foreign-direct`) } catch { /* fail-closed context termination */ }
    finally { expect(f.foreignHits()).toBe(0) }
    await expect.poll(() => f.context.isClosed()).toBe(true)
    expect(f.failures).toEqual(['ORIGIN_FENCE_FAILED'])
    expect(f.blocked()).toBe(1)
  }, { failProtocolAbort: true })
})

test('origin fence blocks worker fetch redirects before the reachable foreign sink receives a request', async ({ browser }) => {
  await fixture(browser, async f => {
    const page = await f.context.newPage()
    await page.goto(`${f.origin}/final`)
    for (const blob of [false, true]) for (const foreign of [false, true]) {
      try {
        const result = await page.evaluate(async ({ target, blob }) => new Promise<string>((resolve, reject) => {
          const source = "onmessage = async event => { try { await fetch(event.data); postMessage('unexpected-success') } catch { postMessage('blocked') } }"
          const url = blob ? URL.createObjectURL(new Blob([source], { type: 'text/javascript' })) : '/worker.js'
          const worker = new Worker(url)
          const timeout = setTimeout(() => { worker.terminate(); reject(new Error('WORKER_FENCE_TIMEOUT')) }, 5000)
          worker.onmessage = event => { clearTimeout(timeout); worker.terminate(); resolve(event.data) }
          worker.onerror = () => { clearTimeout(timeout); worker.terminate(); resolve('blocked') }
          worker.postMessage(target)
        }), { target: `${f.origin}/${foreign ? 'foreign-via' : 'final'}`, blob })
        expect(result).toBe(foreign ? 'blocked' : 'unexpected-success')
      } finally { expect(f.foreignHits()).toBe(0) }
    }
    await expect.poll(f.blocked).toBe(2)
  })
})

test('origin fence closes the context if its CDP protection detaches while the page remains open', async ({ browser }) => {
  await fixture(browser, async f => {
    const page = await f.context.newPage()
    await page.goto(`${f.origin}/final`)
    await f.detachProtection()
    await expect.poll(() => f.context.isClosed()).toBe(true)
    expect(f.failures).toEqual(['ORIGIN_FENCE_FAILED'])
    expect(f.foreignHits()).toBe(0)
  }, { expectFailure: true })
})

test('origin fence still fails closed on detach after a page or context close attempt failed', async ({ browser }) => {
  for (const failClose of ['page', 'context'] as const) await fixture(browser, async f => {
    const page = await f.context.newPage()
    await page.goto(`${f.origin}/final`)
    await expect((failClose === 'page' ? page : f.context).close()).rejects.toThrow('SYNTHETIC_CLOSE_FAILURE')
    expect(page.isClosed()).toBe(false)
    expect(f.context.isClosed()).toBe(false)
    await f.detachProtection()
    await expect.poll(() => f.context.isClosed()).toBe(true)
    expect(f.failures).toEqual(['ORIGIN_FENCE_FAILED'])
    expect(f.foreignHits()).toBe(0)
  }, { expectFailure: true, failClose })
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
