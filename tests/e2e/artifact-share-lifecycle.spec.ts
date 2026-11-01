import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { Pool } from 'pg'
import { test, expect, register } from './fixtures'

/**
 * The share lifecycle end to end: a link works for someone who is not signed
 * in, stopping it ends that access, and copying twice never mints a second
 * token. C18 and C21 are security behaviour, not just copy.
 */

function isolatedPool() {
  const connectionString = process.env.E2E_DATABASE_URL
  if (!connectionString) throw new Error('E2E_DATABASE_URL is required.')
  return new Pool({ connectionString, max: 1 })
}

async function seedArtifact(page: Page) {
  const cookie = (await page.context().cookies()).find(item => item.name.endsWith('session_token'))
  if (!cookie) throw new Error('seedArtifact needs a signed-in page.')
  const db = isolatedPool()
  try {
    const { rows: [session] } = await db.query<{ userId: string }>('SELECT "userId" FROM session WHERE token = $1', [decodeURIComponent(cookie.value).split('.')[0]])
    const artifactId = randomUUID()
    const marker = `shared-body-${randomUUID()}`
    const body = `# 验收记录\n\n${marker}`
    await db.query(`INSERT INTO artifacts (id, "userId", kind, title, "latestVersion") VALUES ($1, $2, 'markdown', $3, 1)`, [artifactId, session.userId, '验收记录'])
    await db.query(`INSERT INTO artifact_versions (id, "artifactId", version, "storageKey", "inlineContent", sha256, size, "authorName") VALUES ($1, $2, 1, $3, $4, $5, $6, $7)`, [randomUUID(), artifactId, `e2e/${artifactId}/1`, body, '0'.repeat(64), body.length, 'Mikka Frontend'])
    const { rows: [{ position }] } = await db.query<{ position: number }>('SELECT COALESCE(MAX(position), 0) + 1 AS position FROM coordinator_messages WHERE "userId" = $1 AND "botId" IS NULL', [session.userId])
    await db.query('INSERT INTO coordinator_messages (id, "userId", "botId", position, message) VALUES ($1, $2, NULL, $3, $4)', [randomUUID(), session.userId, position, JSON.stringify({ role: 'user', content: `[Event] [[artifact:${artifactId}]] handed over` })])
    return { artifactId, marker }
  } finally {
    await db.end()
  }
}

async function shareCount(artifactId: string) {
  const db = isolatedPool()
  try {
    const { rows: [{ count }] } = await db.query<{ count: string }>('SELECT COUNT(*) AS count FROM artifact_shares WHERE "artifactId" = $1 AND "revokedAt" IS NULL', [artifactId])
    return Number(count)
  } finally {
    await db.end()
  }
}

test('a share link opens for a signed-out reader; stopping it ends that access', { tag: '@smoke' }, async ({ page, browser }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => {} } })
  })
  await register(page)
  const { artifactId, marker } = await seedArtifact(page)
  await page.reload()
  await page.getByRole('button', { name: /验收记录/ }).click()
  await page.getByRole('button', { name: '分享', exact: true }).click()
  // Who can open it is said before the link exists.
  await expect(page.locator('[data-slot="popover-description"]')).toHaveText('拿到链接的人可查看')
  await page.getByRole('button', { name: '创建链接', exact: true }).click()
  const link = await page.getByRole('textbox', { name: '分享链接' }).inputValue()
  expect(link).toMatch(/\/a\/[A-Za-z0-9_-]+$/)
  expect(await shareCount(artifactId)).toBe(1)

  const anonymous = await browser.newContext()
  try {
    // A fresh request context has no browser cache, so a passing read here is
    // the server answering, not a warm page.
    const opened = await anonymous.request.get(link)
    expect(opened.status()).toBe(200)
    expect(await opened.text()).toContain(marker)

    // C17: copying again reuses the same link and mints nothing.
    await page.getByRole('button', { name: '复制链接', exact: true }).click()
    expect(await shareCount(artifactId)).toBe(1)

    await page.getByRole('button', { name: '停止分享', exact: true }).click()
    await expect(page.locator('[data-slot="popover-description"]')).toHaveText('已停止分享')
    expect(await shareCount(artifactId)).toBe(0)
  } finally {
    // C21: the link someone already holds must stop working, with no browser
    // cache in the way.
    const response = await anonymous.request.get(link)
    const body = await response.text()
    expect(body).toContain('链接已失效')
    expect(body).not.toContain(marker)
    await anonymous.close()
  }
})
