import type { BrowserContext, CDPSession, Page, Route } from '@playwright/test'

type LeaseScope = { assertActive: () => Promise<void> }
type PausedRequest = {
  requestId: string
  request: { url: string }
  responseErrorReason?: string
}

function sameOrigin(value: string, origin: string) {
  try {
    const url = new URL(value)
    return url.origin === origin && !url.username && !url.password
  } catch { return false }
}

/**
 * Chromium's Playwright route handler sees the first URL, not redirected hops.
 * Pause every request before Chromium sends it, including redirect hops. This
 * leaves response bodies (including SSE) and the native browser cookie jar alone.
 */
export async function installAccountOriginFence(
  context: BrowserContext,
  scope: LeaseScope,
  origin: string,
  // A refusal decision, not successful transport completion. Announce it
  // before abort can emit a browser error; failed aborts still call onFailure.
  onBlocked: () => void,
  onFailure: () => void,
) {
  const sessions = new WeakMap<Page, { ready: Promise<void>; active: boolean }>()
  const closingPages = new WeakSet<Page>()
  let closing = false
  const originalClose = context.close.bind(context)
  Object.defineProperty(context, 'close', {
    configurable: true,
    value: async (...args: Parameters<BrowserContext['close']>) => {
      closing = true
      try { return await originalClose(...args) }
      finally { if (!context.isClosed()) closing = false }
    },
  })
  const abort = async (session: CDPSession, requestId: string) => {
    await session.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' })
  }
  const protect = (page: Page): Promise<void> => {
    const existing = sessions.get(page)
    if (existing) return existing.ready
    const entry = { ready: Promise.resolve(), active: false }
    sessions.set(page, entry)
    entry.ready = (async () => {
      // The first adapter's configured/locked browser is Chromium. Unsupported
      // engines fail before the route releases a request; no weaker fallback.
      const session = await context.newCDPSession(page)
      const originalPageClose = page.close.bind(page)
      Object.defineProperty(page, 'close', {
        configurable: true,
        value: async (...args: Parameters<Page['close']>) => {
          closingPages.add(page)
          try { return await originalPageClose(...args) }
          finally { if (!page.isClosed()) closingPages.delete(page) }
        },
      })
      session.on('close', () => {
        entry.active = false
        if (!closing && !closingPages.has(page) && !page.isClosed() && !context.isClosed()) {
          onFailure()
          void context.close().catch(() => {})
        }
      })
      session.on('Fetch.requestPaused', (event: PausedRequest) => {
        void (async () => {
          try {
            await scope.assertActive()
            // A route-aborted request also emits a response-stage failure.
            // Propagate that existing failure; it is not another outgoing hop.
            if (event.responseErrorReason !== undefined) {
              await session.send('Fetch.continueRequest', { requestId: event.requestId })
              return
            }
            if (!sameOrigin(event.request.url, origin)) { onBlocked(); await abort(session, event.requestId); return }
            await session.send('Fetch.continueRequest', { requestId: event.requestId })
          } catch {
            await abort(session, event.requestId).catch(() => {})
            // Lease loss already closes contexts through the runner callback;
            // an interception failure must also make the fixture fail closed.
            if (!context.isClosed()) { onFailure(); await context.close().catch(() => {}) }
          }
        })()
      })
      await session.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })
      entry.active = true
    })()
    return entry.ready
  }
  const firstRequest = async (route: Route) => {
    try {
      await scope.assertActive()
      if (!sameOrigin(route.request().url(), origin)) { onBlocked(); await route.abort('blockedbyclient'); return }
      // An initial request needs an already installed Page request gate.
      // Initial popup navigation can precede Page creation. Waiting for 'page'
      // here deadlocks; allowing it would release an unprotected redirect.
      // This adapter deliberately refuses that unsupported navigation.
      let page: Page
      try { page = route.request().frame().page() } catch {
        onBlocked()
        await route.abort('blockedbyclient')
        return
      }
      // Fetch.enable cannot retroactively fence redirects of a request already
      // started. Ordinary newPage() returns only after protection is active;
      // any earlier navigation is rejected rather than lazily allowed.
      if (!sessions.get(page)?.active) {
        onBlocked()
        await route.abort('blockedbyclient')
        return
      }
      await scope.assertActive()
      await route.continue()
    } catch {
      await route.abort('blockedbyclient').catch(() => {})
      if (!context.isClosed()) { onFailure(); await context.close().catch(() => {}) }
    }
  }
  await context.route('**/*', firstRequest)
  const originalNewPage = context.newPage.bind(context)
  Object.defineProperty(context, 'newPage', {
    configurable: true,
    value: async () => {
      const page = await originalNewPage()
      try { await protect(page); return page } catch {
        onFailure()
        await context.close().catch(() => {})
        throw new Error('TEST_ACCOUNT_ORIGIN_FENCE_FAILED')
      }
    },
  })
  // WebSockets are not HTTP route requests. This adapter has no WS consumer;
  // explicit routing closes them locally, without connectToServer/upstream IO.
  await context.routeWebSocket('**/*', socket => {
    onBlocked()
    socket.close({ code: 1008, reason: 'TEST_ACCOUNT_WEBSOCKET_FORBIDDEN' })
  })
  return { protectPage: protect }
}
