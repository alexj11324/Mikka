import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import type { Request } from '@playwright/test'
import type { PoolClient } from 'pg'
import { test, expect } from './test-account-fixtures'
import { app, rail } from './fixtures'

test('workspace idle reads stay within budget across settings, return and page departure', async ({ page, testAccounts }, testInfo) => {
  test.setTimeout(180_000)
  const { scope } = testAccounts
  const issue = { type: 'issues', id: randomUUID(), ownerId: scope.owner.userId }
  const originalTitle = `Before settings ${randomUUID()}`
  const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const windows: { state: string; durationMs: number; reads: number[]; total: number; budget: { perStreamMin: number; perStreamMax: number; totalMin: number; totalMax: number }; status: 'pass' | 'fail' }[] = []
  const conditions: { durationMs: number; visibility: string; online: boolean; section: string; virtualElapsedMs: number; wallElapsedMs: number }[] = []
  let completed = false
  await scope.recordResource(issue)
  try {
    await scope.pool.transaction(async (client: PoolClient) => {
      await scope.pool.current(client, scope.lease)
      await client.query('INSERT INTO issues (id, "userId", title, content, status, priority) VALUES ($1, $2, $3, $4, \'todo\', \'normal\')', [issue.id, issue.ownerId, originalTitle, { type: 'doc', content: [{ type: 'paragraph' }], attrs: { mikka: { number: 1 } } }])
    })
    await page.bringToFront()
    await page.clock.install()
    await page.goto(app('/?section=all-issues'))
    await expect(page.getByText(originalTitle, { exact: true })).toBeVisible()
    await page.waitForLoadState('networkidle')
    await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1_000)
    await page.waitForLoadState('networkidle')

    const actions: string[] = []
    const inFlight = new Set<Request>()
    let lastActivity = performance.now()
    page.on('request', request => {
      const action = request.headers()['next-action']
      if (request.method() === 'POST' && action) { actions.push(action); inFlight.add(request); lastActivity = performance.now() }
    })
    const settled = (request: Request) => { if (inFlight.delete(request)) lastActivity = performance.now() }
    page.on('requestfinished', settled)
    page.on('requestfailed', settled)
    async function waitForActionsQuiet(started = performance.now()) {
      await expect.poll(() => inFlight.size === 0 && performance.now() - Math.max(started, lastActivity) >= 500, { timeout: 15_000, intervals: [50, 100] }).toBe(true)
    }
    async function advance(durationMs: number) {
      const state = await page.evaluate(() => {
        const url = new URL(window.location.href)
        const section = url.pathname.includes('/settings') ? 'settings' : url.searchParams.has('settings') ? 'legacy-settings' : url.searchParams.get('section') === 'all-issues' ? 'tasks' : url.searchParams.get('section') === 'artifacts' ? 'artifacts' : 'away'
        return { visibility: document.visibilityState, online: navigator.onLine, section }
      })
      const started = await page.evaluate(() => Date.now())
      const wallStarted = performance.now()
      const condition = { durationMs, ...state, virtualElapsedMs: 0, wallElapsedMs: 0 }
      conditions.push(condition)
      expect(state.visibility).toBe('visible')
      expect(state.online).toBe(true)
      for (let elapsed = 0; elapsed < durationMs; elapsed += 5_000) {
        const stepStarted = performance.now()
        await page.clock.runFor(Math.min(5_000, durationMs - elapsed))
        // SWR schedules its next poll only after the real action completes.
        await waitForActionsQuiet(stepStarted)
      }
      condition.virtualElapsedMs = await page.evaluate(() => Date.now()) - started
      condition.wallElapsedMs = performance.now() - wallStarted
      expect(condition.virtualElapsedMs).toBe(durationMs)
    }
    let pollingActions: string[] = []
    function checkWindow(state: string, start: number, durationMs: number, perStreamMin: number, perStreamMax: number, totalMin = perStreamMin * 2, totalMax = perStreamMax * 2, observedActions = pollingActions) {
      const reads = observedActions.map(action => actions.slice(start).filter(read => read === action).length)
      const total = reads.reduce((sum, count) => sum + count, 0)
      const status = reads.every(count => count >= perStreamMin && count <= perStreamMax) && total >= totalMin && total <= totalMax ? 'pass' : 'fail'
      windows.push({ state, durationMs, reads, total, budget: { perStreamMin, perStreamMax, totalMin, totalMax }, status })
      expect(status, `${state}: ${JSON.stringify({ reads, total })}`).toBe('pass')
    }
    // Initial reads must finish before identifying recurring action streams.
    await advance(20_000)
    const boardDiscovery = actions.length
    // The board also polls task runs and its visible Coordinator chat.
    await advance(16_000)
    const boardPollingActions = [...new Set(actions.slice(boardDiscovery))]
    checkWindow('visible-board-periodic-discovery', boardDiscovery, 16_000, 1, 2, 4, 6, boardPollingActions)
    expect(boardPollingActions.length).toBe(4)

    // Artifact has no extra periodic reads: learn the two shared workspace actions here.
    await rail(page, '产物').click()
    await expect(page.getByRole('heading', { level: 1, name: '产物', exact: true })).toBeVisible()
    await waitForActionsQuiet()
    await advance(5_000)
    const sharedDiscovery = actions.length
    await advance(60_000)
    pollingActions = [...new Set(actions.slice(sharedDiscovery))]
    checkWindow('stable-shared-workspace', sharedDiscovery, 60_000, 3, 6, 8, 10)
    expect(pollingActions.length).toBe(2)
    expect(pollingActions.every(action => boardPollingActions.includes(action))).toBe(true)

    await rail(page, '看板').click()
    await expect(page.getByText(originalTitle, { exact: true })).toBeVisible()
    await waitForActionsQuiet()

    await page.clock.resume()
    await page.getByRole('button', { name: '工作区菜单', exact: true }).click()
    await page.getByRole('menuitem', { name: '设置', exact: true }).click()
    await expect(page.getByRole('group', { name: '界面主题', exact: true })).toBeVisible()
    await waitForActionsQuiet()
    await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1_000)
    await waitForActionsQuiet()
    const pausedReads = actions.length
    await advance(30_000)
    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'))
      window.dispatchEvent(new Event('online'))
    })
    await advance(6_000)
    checkWindow('settings-idle-focus-online', pausedReads, 36_000, 0, 0, 0, 0, boardPollingActions)
    await page.getByRole('button', { name: '浅色', exact: true }).click()
    await expect(page.getByRole('button', { name: '浅色', exact: true })).toHaveAttribute('aria-pressed', 'true')

    const freshTitle = `During settings ${randomUUID()}`
    await scope.pool.transaction(async (client: PoolClient) => {
      await scope.pool.current(client, scope.lease)
      await client.query('UPDATE issues SET title = $1 WHERE id = $2 AND "userId" = $3', [freshTitle, issue.id, issue.ownerId])
    })
    const beforeReturn = actions.length
    await rail(page, '看板').click()
    await expect(page.getByText(freshTitle, { exact: true })).toBeVisible({ timeout: 5_000 })
    await expect.poll(() => new Set(actions.slice(beforeReturn).filter(action => pollingActions.includes(action))).size, { timeout: 5_000 }).toBe(2)
    await waitForActionsQuiet()
    checkWindow('return-immediate-refresh', beforeReturn, 0, 1, 1)
    const resumedReads = actions.length
    await advance(60_000)
    checkWindow('returned-workspace', resumedReads, 60_000, 3, 6, 8, 10)

    // The legacy entry starts with settingsOpen on its first render.
    const beforeLegacy = actions.length
    await page.goto(app('/?settings=account&section=all-issues'))
    await page.clock.resume()
    await expect(page.getByRole('heading', { level: 1, name: '账户', exact: true })).toBeVisible()
    await waitForActionsQuiet()
    await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1_000)
    await waitForActionsQuiet()
    await advance(30_000)
    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'))
      window.dispatchEvent(new Event('online'))
    })
    await advance(6_000)
    checkWindow('legacy-settings-initial-idle-focus-online', beforeLegacy, 36_000, 0, 0, 0, 0, boardPollingActions)
    const beforeLegacyReturn = actions.length
    await rail(page, '看板').click()
    await expect(page.getByText(freshTitle, { exact: true })).toBeVisible({ timeout: 5_000 })
    await expect.poll(() => new Set(actions.slice(beforeLegacyReturn).filter(action => pollingActions.includes(action))).size, { timeout: 5_000 }).toBe(2)
    await waitForActionsQuiet()
    checkWindow('legacy-return-immediate-refresh', beforeLegacyReturn, 0, 1, 1)

    await page.goto(app('/sign-in?addAccount=1'))
    await expect(page.getByRole('button', { name: '工作区菜单', exact: true })).toHaveCount(0)
    await waitForActionsQuiet()
    const awayReads = actions.length
    await advance(30_000)
    checkWindow('left-workspace-document', awayReads, 30_000, 0, 0, 0, 0, boardPollingActions)
    completed = true
  } finally {
    try {
      await testInfo.attach('workspace-idle-request-budget', {
        body: JSON.stringify({ headSha, normalCadencePer60Seconds: { listIssues: 6, listThreads: 4, combinedMax: 10 }, streamIdentity: 'dynamically-observed-actions-without-retained-identifiers', conditions, windows, status: completed ? 'pass' : 'fail' }, null, 2),
        contentType: 'application/json',
      })
    } finally {
      await page.close()
      await scope.pool.transaction(async (client: PoolClient) => {
        await scope.pool.current(client, scope.lease)
        await client.query('DELETE FROM issues WHERE id = $1 AND "userId" = $2', [issue.id, issue.ownerId])
      })
      await scope.markResourceCleaned(issue)
    }
  }
})
