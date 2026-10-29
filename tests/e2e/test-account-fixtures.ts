import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test as base, expect, type APIRequestContext, type BrowserContext, type BrowserContextOptions, type Page } from '@playwright/test'
import { acquireTestAccounts } from '../../scripts/test-accounts/session.mjs'
import { loadEnvironment } from '../../scripts/test-accounts/environment.mjs'
import { browserConsoleDiagnostic, browserResponseDiagnostic, browserTestErrorDiagnostic } from '../../scripts/test-accounts/browser-diagnostics.mjs'
import { app, browserClientHeaders } from './fixtures'
import { installAccountOriginFence, type LocalImageFixture } from './test-account-network'

type StorageState = Exclude<BrowserContextOptions['storageState'], string | undefined>
type AccountScope = Awaited<ReturnType<typeof acquireTestAccounts>>
type AccountBrowsers = {
  scope: AccountScope
  owner: { page: Page; context: BrowserContext }
  peer: { page: Page; context: BrowserContext }
  blockedOrigins: () => number
}

// The run identity is stable across tests in one runner. Parallel workers remain
// distinct holders, and a retry is a new acquisition rather than the old lease.
const runId = process.env.MIKKA_TEST_RUN_ID ?? `browser-${randomUUID()}`

/** Reject the entire state before handing any cookie to Chromium. */
function validateBrowserState(state: StorageState, origin: string) {
  const target = new URL(origin)
  if (!Array.isArray(state.cookies) || !Array.isArray(state.origins)) throw new Error('TEST_ACCOUNT_INVALID_BROWSER_STATE')
  for (const cookie of state.cookies) {
    if (cookie.domain !== target.hostname || !['/', '/mikka'].includes(cookie.path)) throw new Error('TEST_ACCOUNT_FOREIGN_COOKIE')
    if (target.protocol === 'https:' && !cookie.secure) throw new Error('TEST_ACCOUNT_INSECURE_COOKIE')
  }
  if (state.origins.some(item => item.origin !== target.origin)) throw new Error('TEST_ACCOUNT_FOREIGN_STORAGE')
}

/** BrowserContext.request bypasses routing, so fence that API separately. */
function guardContextRequests(context: BrowserContext, scope: AccountScope, origin: string) {
  const request = context.request
  for (const method of ['fetch', 'get', 'post', 'put', 'patch', 'delete', 'head'] as const) {
    const original = request[method].bind(request) as APIRequestContext['fetch']
    Object.defineProperty(request, method, {
      configurable: true,
      value: async (input: Parameters<APIRequestContext['fetch']>[0], options?: Parameters<APIRequestContext['fetch']>[1]) => {
        await scope.assertActive()
        let target: URL
        try { target = new URL(typeof input === 'string' ? input : input.url(), origin) }
        catch { throw new Error('TEST_ACCOUNT_INVALID_REQUEST') }
        if (target.origin !== origin || target.username || target.password) throw new Error('TEST_ACCOUNT_FOREIGN_ORIGIN')
        // APIRequestContext follows redirects without invoking context.route.
        // A caller can inspect a redirect, but cannot accidentally follow it
        // to another origin with the browser's cookie jar.
        return original(input, { ...options, maxRedirects: 0 })
      },
    })
  }
}

/**
 * Business tests get two ordinary, independently authenticated identities.
 * Authentication tests keep using register() and the application's real forms.
 * Raw authentication values stay inside the protected runner files/context.
 */
export const test = base.extend<{ testAccounts: AccountBrowsers; peerPage: Page; localImageFixtures: readonly LocalImageFixture[] }>({
  // Traces and recordings can retain auth headers and input values. Keep these
  // options on this fixture type so importing it never changes another suite.
  trace: 'off',
  video: 'off',
  screenshot: 'off',
  localImageFixtures: [[], { option: true }],
  testAccounts: async ({ browser, localImageFixtures }, use, testInfo) => {
    const environment = await loadEnvironment()
    const scope = await acquireTestAccounts({
      environment,
      runId,
      workerId: `playwright-${testInfo.workerIndex}`,
      requestId: createHash('sha256').update(`${runId}:${testInfo.testId}:${testInfo.retry}`).digest('hex'),
    })
    const origin = environment.origin
    const contexts: BrowserContext[] = []
    const runtimeFailures: string[] = []
    const diagnostics: unknown[] = []
    let diagnosticCount = 0
    const diagnose = (value: unknown) => { diagnosticCount++; if (diagnostics.length < 20) diagnostics.push(value) }
    let blockedOrigins = 0
    let lost = false
    const unsubscribe = scope.onLeaseLost(() => {
      lost = true
      void Promise.allSettled(contexts.map(context => context.close()))
    })
    let completed = false
    let fixtureError: unknown
    try {
      const open = async (account: AccountScope['owner']) => {
        await scope.assertActive()
        let state: StorageState
        try { state = JSON.parse(await readFile(account.storageStatePath, 'utf8')) as StorageState }
        catch { throw new Error('TEST_ACCOUNT_INVALID_BROWSER_STATE') }
        validateBrowserState(state, origin)
        const context = await browser.newContext({
          baseURL: origin,
          locale: 'zh-CN',
          storageState: state,
          extraHTTPHeaders: browserClientHeaders(),
          serviceWorkers: 'block',
        })
        contexts.push(context)
        guardContextRequests(context, scope, origin)
        const fence = await installAccountOriginFence(context, scope, origin,
          () => { blockedOrigins++ }, () => { runtimeFailures.push('BROWSER_ORIGIN_FENCE_FAILED') }, localImageFixtures)
        context.on('page', page => {
          // Never attach raw browser errors, responses or request URLs: those
          // may carry a credential in a query, response or diagnostic message.
          page.on('pageerror', error => {
            runtimeFailures.push('BROWSER_PAGE_ERROR')
            diagnose({ category: 'page-error', error: browserTestErrorDiagnostic(error) })
          })
          page.on('console', message => {
            if (message.type() !== 'error') return
            if (blockedOrigins > 0 && message.text() === 'Failed to load resource: net::ERR_BLOCKED_BY_CLIENT') return
            runtimeFailures.push('BROWSER_CONSOLE_ERROR')
            diagnose(browserConsoleDiagnostic(message.text(), message.location().url, origin))
          })
          page.on('response', response => {
            if (response.status() >= 500) runtimeFailures.push(`HTTP_${response.status()}`)
            if (response.status() >= 400) diagnose(browserResponseDiagnostic(response.status(), response.url(), origin))
          })
        })
        const page = await context.newPage()
        await fence.protectPage(page)
        // The settings test begins in the ordinary projects shell. The home
        // context panel intentionally writes briefing/timezone preferences on
        // read; those workflows require their own tracked mutable fixtures.
        await page.goto(app('/?section=projects'))
        await expect(page.getByRole('button', { name: '工作区菜单', exact: true })).toBeVisible()
        return { page, context }
      }
      const owner = await open(scope.owner)
      const peer = await open(scope.peer)
      await testInfo.attach('account-lease', {
        body: JSON.stringify({
          environmentId: scope.lease.environmentId,
          leaseId: scope.lease.id,
          runId,
          workerId: scope.lease.workerId,
          generation: scope.lease.generation,
          accounts: [scope.owner, scope.peer].map(account => ({ role: account.role, userId: account.userId, namespace: account.namespace })),
        }),
        contentType: 'application/json',
      })
      await use({ scope, owner, peer, blockedOrigins: () => blockedOrigins })
      completed = testInfo.status === 'passed' && !lost && runtimeFailures.length === 0
    } catch (error) {
      fixtureError = error
      throw error
    } finally {
      // Capture the body's error before a teardown assertion can replace it in
      // the list reporter. Only fixed categories and reviewed source locations
      // enter stdout, which the CI wrapper still audits before displaying.
      const errors = [...testInfo.errors, ...(fixtureError ? [fixtureError] : [])]
      const bodyStatus = testInfo.status
      const teardownErrors: unknown[] = []
      // Stop all browser traffic before revoking sessions/returning the pair.
      // If any context cannot close, the account stays quarantined.
      const closed = await Promise.allSettled(contexts.map(context => context.close()))
      unsubscribe()
      await scope.release({ outcome: completed && !lost && runtimeFailures.length === 0 && closed.every(result => result.status === 'fulfilled') ? 'clean' : 'dirty' }).catch(error => {
        teardownErrors.push(error)
        throw error
      }).finally(() => {
        if (errors.length || teardownErrors.length || runtimeFailures.length || lost) console.log('POOLED_BROWSER_DIAGNOSTICS', JSON.stringify({
          bodyStatus, bodyErrors: errors.slice(0, 20).map(browserTestErrorDiagnostic), teardownErrors: teardownErrors.map(browserTestErrorDiagnostic),
          runtimeFailures, diagnostics, omittedDiagnostics: diagnosticCount - diagnostics.length, lost,
        }))
      })
    }
    expect(lost, 'A lost lease must stop the browser and fail the test').toBe(false)
    expect(runtimeFailures, 'The pooled browser must not hide runtime failures').toEqual([])
  },
  context: async ({ testAccounts }, use) => { await use(testAccounts.owner.context) },
  page: async ({ testAccounts }, use) => { await use(testAccounts.owner.page) },
  peerPage: async ({ testAccounts }, use) => { await use(testAccounts.peer.page) },
})

export { expect }
