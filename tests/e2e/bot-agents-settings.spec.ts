import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { Pool } from 'pg'
import { test, expect, register } from './fixtures'

// Real application, real PostgreSQL and the real server actions. Only the
// daemon's report (devices row) and a connected account binding are seeded,
// because no daemon or provider login runs in the browser suite.
let pool: Pool | null = null
const db = () => pool ??= new Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 1 })
test.afterAll(async () => { await pool?.end() })

async function seed(page: Page) {
  const cookie = (await page.context().cookies()).find(item => item.name.endsWith('session_token'))
  if (!cookie) throw new Error('需要已登录的页面。')
  const { rows: [session] } = await db().query<{ userId: string }>('SELECT "userId" FROM session WHERE token = $1', [decodeURIComponent(cookie.value).split('.')[0]])
  const { rows: [member] } = await db().query<{ workspaceId: string }>('SELECT "workspaceId" FROM mikka_workspace_members WHERE "userId" = $1 AND status = $2 LIMIT 1', [session.userId, 'active'])
  // A heartbeat in the future keeps the device online for the whole test.
  await db().query(`INSERT INTO devices (id, "ownerId", name, kind, enabled, "deviceType", "lastSeenAt", harnesses) VALUES
    ($1, $3, 'E2E MacBook', 'local', true, 'laptop', now() + interval '1 hour', $4),
    ($2, $3, 'gpu-box', 'local', true, 'server', NULL, '[]')`, [randomUUID(), randomUUID(), session.userId, JSON.stringify([
    { harness: 'claude_code', installed: true, version: '1.0.0' },
    { harness: 'codex', installed: true, version: '1.0.0', models: ['e2e-reported-model', 'e2e-other-model'] },
  ])])
  const connection = randomUUID()
  await db().query(`INSERT INTO byos_connections (id, "ownerId", "workspaceId", provider, state, epoch, "secretName", "secretDigest", "providerSubject")
    VALUES ($1, $2, $3, 'claude', 'connected', 1, $4, $5, 'e2e-subject')`, [connection, session.userId, member.workspaceId, `e2e-fixture-${connection}`, 'a'.repeat(64)])
  await db().query(`INSERT INTO byos_bindings (id, "ownerId", "workspaceId", "consumerId", "connectionId", "connectionRevision", route, "modelId")
    VALUES ($1, $2, $3, 'e2e-consumer', $4, 1, 'claude_cpa', 'claude-e2e-model')`, [randomUUID(), session.userId, member.workspaceId, connection])
}

test('Bot 与 Agents：添加规则，改运行位置、Harness 和模型，默认行不能删，设置 Coordinator 模型', async ({ page }, testInfo) => {
  await register(page, '/settings?section=bots')
  await expect(page.getByRole('heading', { level: 1, name: 'Bot 与 Agents' })).toBeVisible()
  // The first workspace load creates the person's workspace; seed into it.
  await expect(page.getByRole('button', { name: '添加规则', exact: true })).toBeVisible()
  await seed(page)
  await page.reload()

  // 默认 is the fixed fallback: all 自动, no ⋯ menu.
  const fallback = page.locator('[data-rule="default"]')
  await expect(fallback).toContainText('默认')
  await expect(fallback.getByRole('button')).toHaveCount(0)

  await page.getByRole('button', { name: '添加规则', exact: true }).click()
  await page.getByRole('textbox', { name: '标签', exact: true }).fill('前端')
  await page.getByRole('button', { name: '添加', exact: true }).click()
  const row = page.locator('[data-rule="前端"]')
  await expect(row.getByRole('button', { name: '前端 标签：前端', exact: true })).toBeEnabled()

  await row.getByRole('button', { name: '前端 运行位置：自动', exact: true }).click()
  await expect(page.getByRole('option').filter({ hasText: 'gpu-box' })).toContainText('离线')
  await page.getByRole('option').filter({ hasText: 'E2E MacBook' }).click()
  await expect(row.getByRole('button', { name: '前端 运行位置：E2E MacBook', exact: true })).toBeVisible()

  await row.getByRole('button', { name: '前端 Harness：自动', exact: true }).click()
  await page.getByRole('option', { name: 'Codex' }).click()
  await expect(row.getByRole('button', { name: '前端 Harness：Codex', exact: true })).toBeVisible()

  await row.getByRole('button', { name: '前端 模型：自动', exact: true }).click()
  await page.getByRole('combobox', { name: '搜索模型' }).fill('reported')
  await expect(page.getByRole('option', { name: 'e2e-other-model' })).toHaveCount(0)
  await page.getByRole('option', { name: 'e2e-reported-model' }).click()
  await expect(row.getByRole('button', { name: '前端 模型：e2e-reported-model', exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Coordinator 模型：自动', exact: true }).click()
  await page.getByRole('option', { name: 'claude-e2e-model' }).click()
  await expect(page.getByRole('button', { name: 'Coordinator 模型：claude-e2e-model', exact: true })).toBeVisible()

  // Every change saved: a reload shows the same table.
  await page.reload()
  await expect(row.getByRole('button', { name: '前端 运行位置：E2E MacBook', exact: true })).toBeVisible()
  await expect(row.getByRole('button', { name: '前端 Harness：Codex', exact: true })).toBeVisible()
  await expect(row.getByRole('button', { name: '前端 模型：e2e-reported-model', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Coordinator 模型：claude-e2e-model', exact: true })).toBeVisible()
  await expect(page.getByRole('alert').filter({ hasText: '未保存' })).toHaveCount(0)
  await testInfo.attach('bot-agents', { body: await page.screenshot(), contentType: 'image/png' })

  await row.getByRole('button', { name: '前端 的更多操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '删除', exact: true }).click()
  await expect(row).toHaveCount(0)
  await page.reload()
  await expect(page.locator('[data-rule="前端"]')).toHaveCount(0)
  await expect(fallback).toBeVisible()
})
