import type { BrowserContext, CDPSession, Page, Route } from '@playwright/test'

type LeaseScope = { assertActive: () => Promise<void> }
type PausedRequest = {
  requestId: string
  request: { url: string; method: string }
  resourceType: string
  responseErrorReason?: string
  networkId?: string
}
export type LocalImageFixture = Readonly<{ url: string; body: Uint8Array }>
type FailurePhase = 'lease' | 'cdp-continue' | 'cdp-fulfill' | 'cdp-abort' | 'route-continue' | 'route-fulfill' | 'route-abort' | 'detach' | 'setup'
export type OriginFenceFailure = { phase: FailurePhase; category: 'invalid-interception' | 'target-closed' | 'unknown' }

function failureCategory(error: unknown): OriginFenceFailure['category'] {
  const message = error instanceof Error ? error.message : ''
  if (/\bInvalid InterceptionId\.?$/.test(message)) return 'invalid-interception'
  if (/Target page, context or browser has been closed|Session closed|Target closed/.test(message)) return 'target-closed'
  return 'unknown'
}

function imageResponses(fixtures: readonly LocalImageFixture[]) {
  if (fixtures.length > 4) throw new Error('TEST_ACCOUNT_INVALID_IMAGE_FIXTURE')
  const responses = new Map<string, Buffer>()
  for (const fixture of fixtures) {
    const url = new URL(fixture.url)
    const body = Buffer.from(fixture.body)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      url.href !== fixture.url || responses.has(fixture.url) || body.length > 65_536 ||
      !body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('TEST_ACCOUNT_INVALID_IMAGE_FIXTURE')
    responses.set(fixture.url, body)
  }
  // Copy at installation: later mutation of fixture bytes cannot change a
  // response. Only the static PNG body is used, never request headers/cookies.
  return (url: string, method: string, type: string) => method === 'GET' && type.toLowerCase() === 'image' ? responses.get(url) : undefined
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
  onFailure: (failure?: OriginFenceFailure) => void,
  localImages: readonly LocalImageFixture[] = [],
) {
  const localImage = imageResponses(localImages)
  const reportFailure = (phase: FailurePhase, error?: unknown) => onFailure({ phase, category: failureCategory(error) })
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
      const paused = new Set<{ networkId?: string; canceled: boolean }>()
      session.on('Network.loadingFailed', (event: { requestId: string; canceled?: boolean }) => {
        if (event.canceled === true) for (const pending of paused) {
          if (pending.networkId === event.requestId) pending.canceled = true
        }
      })
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
        paused.clear()
        if (!closing && !closingPages.has(page) && !page.isClosed() && !context.isClosed()) {
          reportFailure('detach')
          void context.close().catch(() => {})
        }
      })
      session.on('Fetch.requestPaused', (event: PausedRequest) => {
        const pending = { networkId: event.networkId, canceled: false }
        paused.add(pending)
        void (async () => {
          let phase: FailurePhase = 'lease'
          const continueRequest = async () => {
            phase = 'cdp-continue'
            try { await session.send('Fetch.continueRequest', { requestId: event.requestId }) }
            catch (error) {
              // A canceled request can lose its interception while its lease check awaits.
              if (!pending.canceled || failureCategory(error) !== 'invalid-interception') throw error
            }
          }
          try {
            await scope.assertActive()
            // A route-aborted request also emits a response-stage failure.
            // Propagate that existing failure; it is not another outgoing hop.
            if (event.responseErrorReason !== undefined) {
              await continueRequest()
              return
            }
            const image = localImage(event.request.url, event.request.method, event.resourceType)
            if (image) {
              phase = 'cdp-fulfill'
              await session.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 200,
                responseHeaders: [{ name: 'Content-Type', value: 'image/png' }, { name: 'Cache-Control', value: 'no-store' }],
                body: image.toString('base64') })
              return
            }
            if (!sameOrigin(event.request.url, origin)) { onBlocked(); phase = 'cdp-abort'; await abort(session, event.requestId); return }
            await continueRequest()
          } catch (error) {
            await abort(session, event.requestId).catch(() => {})
            // Lease loss already closes contexts through the runner callback;
            // an interception failure must also make the fixture fail closed.
            if (!context.isClosed()) { reportFailure(phase, error); await context.close().catch(() => {}) }
          } finally { paused.delete(pending) }
        })()
      })
      await session.send('Network.enable')
      await session.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })
      entry.active = true
    })()
    return entry.ready
  }
  const firstRequest = async (route: Route) => {
    let phase: FailurePhase = 'lease'
    try {
      await scope.assertActive()
      const request = route.request()
      const image = localImage(request.url(), request.method(), request.resourceType())
      if (!image && !sameOrigin(request.url(), origin)) { onBlocked(); phase = 'route-abort'; await route.abort('blockedbyclient'); return }
      // An initial request needs an already installed Page request gate.
      // Initial popup navigation can precede Page creation. Waiting for 'page'
      // here deadlocks; allowing it would release an unprotected redirect.
      // This adapter deliberately refuses that unsupported navigation.
      let page: Page
      try { page = route.request().frame().page() } catch {
        onBlocked()
        phase = 'route-abort'
        await route.abort('blockedbyclient')
        return
      }
      // Fetch.enable cannot retroactively fence redirects of a request already
      // started. Ordinary newPage() returns only after protection is active;
      // any earlier navigation is rejected rather than lazily allowed.
      if (!sessions.get(page)?.active) {
        onBlocked()
        phase = 'route-abort'
        await route.abort('blockedbyclient')
        return
      }
      await scope.assertActive()
      if (image) {
        phase = 'route-fulfill'
        await route.fulfill({ status: 200, contentType: 'image/png', headers: { 'cache-control': 'no-store' }, body: image })
        return
      }
      phase = 'route-continue'
      await route.continue()
    } catch (error) {
      await route.abort('blockedbyclient').catch(() => {})
      if (!context.isClosed()) { reportFailure(phase, error); await context.close().catch(() => {}) }
    }
  }
  await context.route('**/*', firstRequest)
  const originalNewPage = context.newPage.bind(context)
  Object.defineProperty(context, 'newPage', {
    configurable: true,
    value: async () => {
      const page = await originalNewPage()
      try { await protect(page); return page } catch (error) {
        reportFailure('setup', error)
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
