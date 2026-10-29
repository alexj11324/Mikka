import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { test, expect, register, app, seedTask, openIssueFromSearch } from './fixtures'

// These are actual Chromium interactions with controlled API responses, not live
// GitHub authorization. No provider tokens or external GitHub calls are involved.
async function viewerId(page: import('@playwright/test').Page) {
  const response = await page.request.get(app('/api/auth/get-session'))
  expect(response.ok()).toBe(true)
  const session = await response.json()
  expect(typeof session?.user?.id).toBe('string')
  return session.user.id as string
}

for (const width of [1280, 402]) {
  test(`GitHub settings controlled-response acceptance at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    await register(page, '/settings?section=integrations')
    const id = await viewerId(page)
    let connected = true
    let mismatchedViewer = false
    await page.route('**/api/integrations/github', route => route.fulfill({ json: {
      viewerId: mismatchedViewer ? 'different-fixture-viewer' : id,
      configured: true, connected, installed: connected,
      repositories: connected ? [{ id: '31', installationId: '21', fullName: 'fixture-owner/non-production-repo', htmlUrl: 'https://github.com/fixture-owner/non-production-repo', private: true }] : [],
    } }))
    const refresh = page.getByRole('button', { name: '刷新 GitHub 状态', exact: true })
    await expect(refresh).toBeEnabled()
    await refresh.click()
    const repositories = page.getByRole('list', { name: '你已授权的 GitHub 仓库', exact: true })
    await expect(repositories).toContainText('fixture-owner/non-production-repo')
    await expect(page.getByRole('link', { name: '管理授权', exact: true })).toHaveAttribute('href', 'https://github.com/apps/mikka-github/installations/new')
    await testInfo.attach(`github-settings-authorized-fixture-${width}`, { body: await page.screenshot(), contentType: 'image/png' })
    connected = false
    await refresh.click()
    await expect(repositories).toHaveCount(0)
    await expect(page.getByText('先关联你的 GitHub 账号。', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '关联 GitHub', exact: true })).toBeVisible()
    await testInfo.attach(`github-settings-revoked-fixture-${width}`, { body: await page.screenshot(), contentType: 'image/png' })
    connected = true
    mismatchedViewer = true
    await refresh.click()
    await expect(repositories).toHaveCount(0)
    await expect(page.getByRole('alert').filter({ hasText: '无法读取 GitHub 授权，请刷新重试。' })).toBeVisible()
    await expect(page.getByRole('link', { name: '管理授权', exact: true })).toHaveCount(0)
  })
}

test('GitHub PR badge rechecks controlled response after focus and hides revoked status', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await register(page)
  const id = await viewerId(page)
  const title = `GitHub badge fixture ${randomUUID()}`
  const issueId = await seedTask(page, title)
  const connectionString = process.env.E2E_DATABASE_URL
  if (!connectionString) throw new Error('GitHub UI fixture requires the disposable CI database')
  const target = new URL(connectionString)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !target.pathname.endsWith('_e2e')) throw new Error('Refusing a business database')
  const pool = new Pool({ connectionString, max: 1 })
  const prURL = 'https://github.com/fixture-owner/non-production-repo/pull/81'
  try {
    await pool.query(`UPDATE issues SET content = jsonb_set(content::jsonb, '{attrs,mikka,pullRequests}', $2::jsonb) WHERE id=$1 AND "userId"=$3`, [issueId, JSON.stringify([{ url: prURL, state: 'open' }]), id])
  } finally { await pool.end() }
  let revoked = false
  let revokedResponses = 0
  await page.route('**/api/github/pull-request-status', route => {
    expect(route.request().postDataJSON()).toEqual({ issueId, url: prURL })
    if (revoked) revokedResponses++
    // A controlled error body deliberately uses 200 to avoid a browser console
    // resource error; provider HTTP rejection semantics have separate unit tests.
    return route.fulfill({ json: revoked ? { error: 'githubRepositoryForbidden' } : { viewerId: id, state: 'merged' } })
  })
  await openIssueFromSearch(page, title)
  const link = page.getByRole('link', { name: /GitHub · 已合并/ }).filter({ hasText: '#81' })
  await expect(link).toBeVisible()
  await testInfo.attach('github-pr-merged-controlled-response', { body: await page.screenshot(), contentType: 'image/png' })
  revoked = true
  // SWR intentionally throttles focus revalidation for five seconds after mount.
  // Exercise normal focus events until a fresh permission check actually occurs.
  await expect.poll(async () => {
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    return revokedResponses
  }).toBeGreaterThan(0)
  await expect(link).toHaveCount(0)
  await expect(page.getByRole('link', { name: /GitHub 状态不可用/ }).filter({ hasText: '#81' })).toBeVisible()
  await testInfo.attach('github-pr-revoked-controlled-response', { body: await page.screenshot(), contentType: 'image/png' })
})
