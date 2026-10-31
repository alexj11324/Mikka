import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { test, expect } from './test-account-fixtures'
import { app, rail } from './fixtures'

test('settings pause workspace reads and returning refreshes tasks and resumes polling', async ({ page, testAccounts }) => {
  test.setTimeout(120_000)
  const { scope } = testAccounts
  const issue = { type: 'issues', id: randomUUID(), ownerId: scope.owner.userId }
  const originalTitle = `Before settings ${randomUUID()}`
  await scope.recordResource(issue)
  try {
    await scope.pool.transaction(async (client: PoolClient) => {
      await scope.pool.current(client, scope.lease)
      await client.query('INSERT INTO issues (id, "userId", title, content, status, priority) VALUES ($1, $2, $3, $4, \'todo\', \'normal\')', [issue.id, issue.ownerId, originalTitle, { type: 'doc', content: [{ type: 'paragraph' }], attrs: { mikka: { number: 1 } } }])
    })
    await page.clock.install()
    await page.goto(app('/?section=all-issues'))
    await expect(page.getByText(originalTitle, { exact: true })).toBeVisible()
    await page.waitForLoadState('networkidle')

    const actions: string[] = []
    page.on('request', request => {
      const action = request.headers()['next-action']
      if (request.method() === 'POST' && action) actions.push(action)
    })
    // Learn the two real polling actions after all initial board reads settle.
    await page.clock.runFor(16_000)
    await page.waitForLoadState('networkidle')
    const pollingActions = new Set(actions)
    expect(pollingActions.size).toBe(2)
    const workspaceReads = () => actions.filter(action => pollingActions.has(action))

    await page.getByRole('button', { name: '工作区菜单', exact: true }).click()
    await page.getByRole('menuitem', { name: '设置', exact: true }).click()
    await expect(page.getByRole('group', { name: '界面主题', exact: true })).toBeVisible()
    await page.waitForLoadState('networkidle')
    const pausedReads = workspaceReads().length
    await page.clock.runFor(30_000)
    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'))
      window.dispatchEvent(new Event('online'))
    })
    await page.clock.runFor(6_000)
    await page.waitForLoadState('networkidle')
    expect(workspaceReads()).toHaveLength(pausedReads)
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
    await expect.poll(() => new Set(actions.slice(beforeReturn).filter(action => pollingActions.has(action))).size, { timeout: 5_000 }).toBe(2)
    await page.waitForLoadState('networkidle')
    const resumedReads = actions.length
    await page.clock.runFor(16_000)
    await expect.poll(() => new Set(actions.slice(resumedReads).filter(action => pollingActions.has(action))).size).toBe(2)

    // The legacy entry starts with settingsOpen on its first render.
    const beforeLegacy = workspaceReads().length
    await page.goto(app('/?settings=account&section=all-issues'))
    await expect(page.getByRole('heading', { level: 1, name: '账户', exact: true })).toBeVisible()
    await page.clock.runFor(30_000)
    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'))
      window.dispatchEvent(new Event('online'))
    })
    await page.clock.runFor(6_000)
    await page.waitForLoadState('networkidle')
    expect(workspaceReads()).toHaveLength(beforeLegacy)
    const beforeLegacyReturn = actions.length
    await rail(page, '看板').click()
    await expect(page.getByText(freshTitle, { exact: true })).toBeVisible({ timeout: 5_000 })
    await expect.poll(() => new Set(actions.slice(beforeLegacyReturn).filter(action => pollingActions.has(action))).size, { timeout: 5_000 }).toBe(2)
  } finally {
    await page.close()
    await scope.pool.transaction(async (client: PoolClient) => {
      await scope.pool.current(client, scope.lease)
      await client.query('DELETE FROM issues WHERE id = $1 AND "userId" = $2', [issue.id, issue.ownerId])
    })
    await scope.markResourceCleaned(issue)
  }
})
