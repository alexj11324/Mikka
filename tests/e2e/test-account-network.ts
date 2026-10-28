import type { BrowserContext, CDPSession, Page, Route } from '@playwright/test'

type LeaseScope = { assertActive: () => Promise<void> }
type PausedResponse = {
  requestId: string
  request: { url: string }
  responseStatusCode?: number
  responseHeaders?: { name: string; value: string }[]
}

function sameOrigin(value: string, origin: string, base?: string) {
  try {
    const url = new URL(value, base)
    return url.origin === origin && !url.username && !url.password
  } catch { return false }
}

/**
 * Chromium's Playwright route handler sees the first URL, not redirected hops.
 * Pause response headers before Chromium can follow any Location instead. This
 * leaves response bodies (including SSE) and the native browser cookie jar alone.
 */
export async function installAccountOriginFence(
  context: BrowserContext,
  scope: LeaseScope,
  origin: string,
  onBlocked: () => void,
  onFailure: () => void,
) {
  const sessions = new WeakMap<Page, Promise<void>>()
  const abort = async (session: CDPSession, requestId: string) => {
    await session.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => {})
  }
  const protect = (page: Page): Promise<void> => {
    const existing = sessions.get(page)
    if (existing) return existing
    const ready = (async () => {
      // The first adapter's configured/locked browser is Chromium. Unsupported
      // engines fail before the route releases a request; no weaker fallback.
      const session = await context.newCDPSession(page)
      session.on('Fetch.requestPaused', (event: PausedResponse) => {
        void (async () => {
          try {
            await scope.assertActive()
            let permitted = sameOrigin(event.request.url, origin)
            if (event.responseStatusCode !== undefined && event.responseStatusCode >= 300 && event.responseStatusCode < 400) {
              // Validate every Location header, rather than guessing which of
              // duplicate headers the browser would use.
              for (const header of event.responseHeaders ?? []) {
                if (header.name.toLowerCase() === 'location' && !sameOrigin(header.value, origin, event.request.url)) permitted = false
              }
            }
            if (!permitted) { onBlocked(); await abort(session, event.requestId); return }
            if (event.responseStatusCode !== undefined) await session.send('Fetch.continueResponse', { requestId: event.requestId })
            else await session.send('Fetch.continueRequest', { requestId: event.requestId })
          } catch {
            await abort(session, event.requestId)
            // Lease loss already closes contexts through the runner callback;
            // an interception failure must also make the fixture fail closed.
            if (!context.isClosed()) { onFailure(); await context.close().catch(() => {}) }
          }
        })()
      })
      await session.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Response' }] })
    })()
    sessions.set(page, ready)
    return ready
  }
  const firstRequest = async (route: Route) => {
    try {
      await scope.assertActive()
      if (!sameOrigin(route.request().url(), origin)) { onBlocked(); await route.abort('blockedbyclient'); return }
      // Keep the initial request paused until its Page has its response gate.
      // This also covers a popup before the usual context 'page' event, which
      // can arrive only after its initial response has started loading.
      await protect(route.request().frame().page())
      await scope.assertActive()
      await route.continue()
    } catch { await route.abort('blockedbyclient').catch(() => {}) }
  }
  await context.route('**/*', firstRequest)
  // WebSockets are not HTTP route requests. This adapter has no WS consumer;
  // explicit routing closes them locally, without connectToServer/upstream IO.
  await context.routeWebSocket('**/*', socket => {
    onBlocked()
    socket.close({ code: 1008, reason: 'TEST_ACCOUNT_WEBSOCKET_FORBIDDEN' })
  })
  return { protectPage: protect }
}
