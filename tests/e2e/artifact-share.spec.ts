import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { Pool } from 'pg'
import { test, expect, register } from './fixtures'

/**
 * Sharing an artifact from the reader's header. The three failures below are
 * the branches that used to end silently: a denied clipboard, a create request
 * that throws, and a stop request that throws. A failed stop must never read
 * as stopped, because the server may have finished and lost the response.
 */

function database() {
  const connectionString = process.env.E2E_DATABASE_URL
  if (!connectionString) throw new Error('E2E_DATABASE_URL is required.')
  return new Pool({ connectionString, max: 1 })
}

async function seedArtifactInChat(page: Page) {
  const cookie = (await page.context().cookies()).find(item => item.name.endsWith('session_token'))
  if (!cookie) throw new Error('seedArtifactInChat needs a signed-in page.')
  const db = database()
  try {
    const { rows: [session] } = await db.query<{ userId: string }>('SELECT "userId" FROM session WHERE token = $1', [decodeURIComponent(cookie.value).split('.')[0]])
    if (!session) throw new Error('No session row for the signed-in page.')
    const artifactId = randomUUID()
    const body = '# 验收记录\n\n留在版本行里，没有 R2 也能读。'
    await db.query(`INSERT INTO artifacts (id, "userId", kind, title, "latestVersion") VALUES ($1, $2, 'markdown', $3, 1)`, [artifactId, session.userId, '验收记录'])
    await db.query(`INSERT INTO artifact_versions (id, "artifactId", version, "storageKey", "inlineContent", sha256, size, "authorName") VALUES ($1, $2, 1, $3, $4, $5, $6, $7)`, [randomUUID(), artifactId, `e2e/${artifactId}/1`, body, '0'.repeat(64), body.length, 'Mikka Frontend'])
    const { rows: [{ position }] } = await db.query<{ position: number }>('SELECT COALESCE(MAX(position), 0) + 1 AS position FROM coordinator_messages WHERE "userId" = $1 AND "botId" IS NULL', [session.userId])
    await db.query('INSERT INTO coordinator_messages (id, "userId", "botId", position, message) VALUES ($1, $2, NULL, $3, $4)', [randomUUID(), session.userId, position, JSON.stringify({ role: 'user', content: `[Event] [[artifact:${artifactId}]] handed over` })])
    return artifactId
  } finally {
    await db.end()
  }
}

async function openSharePopover(page: Page) {
  await register(page)
  await seedArtifactInChat(page)
  await page.reload()
  await page.getByRole('button', { name: /验收记录/ }).click()
  const share = page.getByRole('button', { name: '分享', exact: true })
  await expect(share).toBeVisible()
  await share.click()
}

function denyClipboard() {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async () => { throw new Error('clipboard denied') } },
  })
}

test('a created link whose copy is denied stays on screen with a manual copy path', async ({ page }) => {
  await page.addInitScript(denyClipboard)
  await openSharePopover(page)
  await page.getByRole('button', { name: '创建链接', exact: true }).click()
  await expect(page.getByText('复制失败', { exact: true })).toBeVisible()
  await expect(page.getByText('选中链接后手动复制', { exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: '分享链接' })).toHaveValue(/\/a\//)
  await expect(page.getByRole('button', { name: '选择链接', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '重新复制', exact: true })).toBeVisible()
})

test.describe('a share request that throws', () => {
  // The abort below is the failure under test, so the browser's own
  // "Failed to load resource" line is expected here and nowhere else.
  test.use({ expectedConsoleErrors: [{ path: '/mikka/', message: 'Failed to load resource: net::ERR_FAILED' }] })

  test('a create request that throws says so and offers a retry', async ({ page }) => {
    await openSharePopover(page)
    await page.route('**/*', route => {
      const request = route.request()
      if (request.method() === 'POST' && request.headers()['next-action']) return route.fulfill({ status: 200, contentType: 'text/x-component', body: '' })
      return route.fallback()
    })
    await page.getByRole('button', { name: '创建链接', exact: true }).click()
    await expect(page.getByText('创建失败', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '重试', exact: true })).toBeVisible()
  })

  test('a stop request that throws says the state is unknown, never stopped', async ({ page }) => {
    // Headless Chromium denies clipboard writes by default, which would route
    // creation into the copy-failed state instead of the share-on state.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => {} } })
    })
    await openSharePopover(page)
    await page.getByRole('button', { name: '创建链接', exact: true }).click()
    await expect(page.getByRole('textbox', { name: '分享链接' })).toHaveValue(/\/a\//)
    const stop = page.getByRole('button', { name: '停止分享', exact: true })
    await expect(stop).toBeVisible()
    await page.route('**/*', route => {
      const request = route.request()
      if (request.method() === 'POST' && request.headers()['next-action']) return route.fulfill({ status: 200, contentType: 'text/x-component', body: '' })
      return route.fallback()
    })
    await stop.click()
    await expect(page.getByText('停止分享未确认', { exact: true })).toBeVisible()
    await expect(page.getByText('当前共享状态未知', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '重新检查', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '重试停止', exact: true })).toBeVisible()
    await expect(page.getByText('已停止分享', { exact: true })).toHaveCount(0)
  })
})
