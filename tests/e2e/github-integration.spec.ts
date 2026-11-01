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
    await register(page, '/settings?section=connections&app=github')
    const id = await viewerId(page)
    let connected = true
    let mismatchedViewer = false
    await page.route('**/api/integrations/github', route => route.fulfill({ json: {
      viewerId: mismatchedViewer ? 'different-fixture-viewer' : id,
      configured: true, connected, installed: connected,
      repositories: connected ? [{ id: '31', installationId: '21', fullName: 'fixture-owner/non-production-repo', htmlUrl: 'https://github.com/fixture-owner/non-production-repo', private: true }] : [],
    } }))
    // A visit reads GitHub; focus never does (decision 2026-11-01-0400-no-refetch-on-focus).
    const revisit = () => page.reload()
    const refocus = () => page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await revisit()
    // The card counts the repositories; their names are only in the dialog it opens.
    const access = page.getByRole('region', { name: '仓库访问', exact: true })
    await expect(access).toContainText('已授权 1 个仓库')
    await expect(access).not.toContainText('fixture-owner/non-production-repo')
    await expect(page.getByRole('link', { name: '在 GitHub 上管理', exact: true })).toHaveAttribute('href', 'https://github.com/apps/mikka-github/installations/new')
    await page.getByRole('button', { name: '已授权 1 个仓库', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '已授权的仓库', exact: true })
    const repositories = dialog.getByRole('list', { name: '你已授权的 GitHub 仓库', exact: true })
    await expect(repositories).toContainText('fixture-owner/non-production-repo')
    await expect(repositories.getByRole('link', { name: /fixture-owner\/non-production-repo/ })).toHaveAttribute('href', 'https://github.com/fixture-owner/non-production-repo')
    await dialog.getByRole('textbox', { name: '搜索仓库', exact: true }).fill('nothing-matches')
    await expect(repositories.getByRole('link')).toHaveCount(0)
    await testInfo.attach(`github-settings-repositories-dialog-${width}`, { body: await page.screenshot(), contentType: 'image/png' })
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    // 推送分支 is the GitHub App's own grant (decision 2026-11-01-1215): shown, with no switch.
    // 创建 Pull Request is this person's own setting, saved for real and read back on the next visit.
    const pullRequest = page.getByRole('group', { name: '创建 Pull Request', exact: true })
    await expect(page.getByRole('group', { name: '推送分支', exact: true })).toHaveCount(0)
    await expect(page.getByText('由 GitHub App 授权决定', { exact: true })).toBeVisible()
    await expect(pullRequest.getByRole('button', { name: '允许', exact: true })).toHaveAttribute('aria-pressed', 'true')
    const saved = page.waitForResponse(response => response.url().endsWith('/api/integrations/github/permissions') && response.request().method() === 'PATCH')
    await pullRequest.getByRole('button', { name: '拒绝', exact: true }).click()
    expect((await saved).ok()).toBe(true)
    await testInfo.attach(`github-settings-authorized-fixture-${width}`, { body: await page.screenshot(), contentType: 'image/png' })
    connected = false
    await refocus()
    await expect(access).toContainText('已授权 1 个仓库')
    await revisit()
    await expect(access).toHaveCount(0)
    await expect(page.getByRole('button', { name: '关联 GitHub', exact: true })).toBeVisible()
    await expect(pullRequest.getByRole('button', { name: '拒绝', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await testInfo.attach(`github-settings-revoked-fixture-${width}`, { body: await page.screenshot(), contentType: 'image/png' })
    connected = true
    mismatchedViewer = true
    await revisit()
    await expect(access).toHaveCount(0)
    await expect(page.getByRole('alert').filter({ hasText: '无法读取 GitHub 授权，请刷新重试。' })).toBeVisible()
    await expect(page.getByRole('link', { name: '在 GitHub 上管理', exact: true })).toHaveCount(0)
  })
}

test('GitHub PR badge rechecks controlled response on the next visit, not on focus, and hides revoked status', async ({ page }, testInfo) => {
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
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.waitForTimeout(1000)
  expect(revokedResponses).toBe(0)
  await expect(link).toBeVisible()
  await page.reload()
  await expect.poll(() => revokedResponses).toBeGreaterThan(0)
  await expect(link).toHaveCount(0)
  await expect(page.getByRole('link', { name: /GitHub 状态不可用/ }).filter({ hasText: '#81' })).toBeVisible()
  await testInfo.attach('github-pr-revoked-controlled-response', { body: await page.screenshot(), contentType: 'image/png' })
})
