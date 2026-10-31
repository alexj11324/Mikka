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
  // A heartbeat in the future keeps the device online for the whole test. Claude Code reports its
  // slots with what they resolve to; the screen shows only the resolved name.
  await db().query(`INSERT INTO devices (id, "ownerId", name, kind, enabled, "deviceType", "lastSeenAt", harnesses) VALUES
    ($1, $3, 'E2E MacBook', 'local', true, 'laptop', now() + interval '1 hour', $4),
    ($2, $3, 'gpu-box', 'local', true, 'server', NULL, '[]')`, [randomUUID(), randomUUID(), session.userId, JSON.stringify([
    { harness: 'claude_code', installed: true, version: '1.0.0', modelSlots: [{ slot: 'opus', model: 'E2E Opus Resolved', name: 'E2E Opus Resolved' }, { slot: 'sonnet', model: 'E2E Sonnet Resolved', name: 'E2E Sonnet Resolved' }], defaultModelSlot: 'opus' },
    { harness: 'codex', installed: true, version: '1.0.0', models: ['e2e-reported-model', 'e2e-other-model'] },
  ])])
  for (const [provider, route, model] of [['claude', 'claude_cpa', 'claude-e2e-model'], ['codex', 'codex_cpa', 'codex-e2e-model']] as const) {
    const connection = randomUUID()
    await db().query(`INSERT INTO byos_connections (id, "ownerId", "workspaceId", provider, state, epoch, "secretName", "secretDigest", "providerSubject")
      VALUES ($1, $2, $3, $4, 'connected', 1, $5, $6, 'e2e-subject')`, [connection, session.userId, member.workspaceId, provider, `e2e-fixture-${connection}`, 'a'.repeat(64)])
    await db().query(`INSERT INTO byos_bindings (id, "ownerId", "workspaceId", "consumerId", "connectionId", "connectionRevision", route, "modelId")
      VALUES ($1, $2, $3, 'e2e-consumer', $4, 1, $5, $6)`, [randomUUID(), session.userId, member.workspaceId, connection, route, model])
  }
}

test('Bot 与 Agents：没有自动，初始值来自订阅，添加规则沿用任务默认，改运行位置、Agent 和模型，设置 Coordinator 模型', async ({ page }, testInfo) => {
  await register(page, '/settings?section=bots')
  await expect(page.getByRole('heading', { level: 1, name: 'Bot 与 Agents' })).toBeVisible()
  // The first workspace load creates the person's workspace; seed into it.
  await expect(page.getByRole('button', { name: '添加规则', exact: true })).toBeVisible()
  await seed(page)
  await page.reload()

  // 任务默认: a Claude subscription starts on Claude Code at the online device, on its opus slot, shown by its resolved name.
  const fallback = page.locator('[data-rule="default"]')
  await expect(fallback.getByRole('button', { name: '默认 运行位置：E2E MacBook', exact: true })).toBeVisible()
  await expect(fallback.getByRole('button', { name: '默认 Agent：Claude Code', exact: true })).toBeVisible()
  await expect(fallback.getByRole('button', { name: '默认 模型：E2E Opus Resolved', exact: true })).toBeVisible()
  await expect(fallback.getByRole('button', { name: '默认 设备离线时：等它上线', exact: true })).toBeVisible()
  await expect(fallback.getByRole('button', { name: /更多操作/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Coordinator 模型：claude-e2e-model', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '额度用完时：停下等我', exact: true })).toBeVisible()
  await expect(page.getByRole('main').getByText('自动')).toHaveCount(0)
  await expect(page.getByRole('main').getByText(/^opus$/)).toHaveCount(0)

  await page.getByRole('button', { name: '添加规则', exact: true }).click()
  await page.getByRole('textbox', { name: '标签', exact: true }).fill('前端')
  await page.getByRole('button', { name: '添加', exact: true }).click()
  const row = page.locator('[data-rule="前端"]')
  await expect(row.getByRole('button', { name: '前端 标签：前端', exact: true })).toBeEnabled()
  // A new rule starts from the task defaults.
  await expect(row.getByRole('button', { name: '前端 运行位置：E2E MacBook', exact: true })).toBeVisible()
  await expect(row.getByRole('button', { name: '前端 Agent：Claude Code', exact: true })).toBeVisible()
  await expect(row.getByRole('button', { name: '前端 模型：E2E Opus Resolved', exact: true })).toBeVisible()

  await row.getByRole('button', { name: '前端 运行位置：E2E MacBook', exact: true }).click()
  await expect(page.getByRole('option').filter({ hasText: 'gpu-box' })).toContainText('离线')
  await expect(page.getByRole('option')).toHaveCount(3)
  await page.getByRole('option').filter({ hasText: 'Mikka Cloud' }).click()
  await expect(row.getByRole('button', { name: '前端 运行位置：Mikka Cloud', exact: true })).toBeVisible()
  await row.getByRole('button', { name: '前端 运行位置：Mikka Cloud', exact: true }).click()
  await page.getByRole('option').filter({ hasText: 'E2E MacBook' }).click()
  await expect(row.getByRole('button', { name: '前端 运行位置：E2E MacBook', exact: true })).toBeVisible()

  // Another harness takes its default model.
  await row.getByRole('button', { name: '前端 Agent：Claude Code', exact: true }).click()
  await page.getByRole('option', { name: 'Codex' }).click()
  await expect(row.getByRole('button', { name: '前端 Agent：Codex', exact: true })).toBeVisible()
  await expect(row.getByRole('button', { name: '前端 模型：e2e-reported-model', exact: true })).toBeVisible()

  await row.getByRole('button', { name: '前端 模型：e2e-reported-model', exact: true }).click()
  await page.getByRole('combobox', { name: '搜索模型' }).fill('other')
  await expect(page.getByRole('option', { name: 'e2e-reported-model' })).toHaveCount(0)
  await page.getByRole('option', { name: 'e2e-other-model' }).click()
  await expect(row.getByRole('button', { name: '前端 模型：e2e-other-model', exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Coordinator 模型：claude-e2e-model', exact: true }).click()
  await page.getByRole('option', { name: 'codex-e2e-model' }).click()
  await expect(page.getByRole('button', { name: 'Coordinator 模型：codex-e2e-model', exact: true })).toBeVisible()

  // Every change saved: a reload shows the same table.
  await page.reload()
  await expect(row.getByRole('button', { name: '前端 运行位置：E2E MacBook', exact: true })).toBeVisible()
  await expect(row.getByRole('button', { name: '前端 Agent：Codex', exact: true })).toBeVisible()
  await expect(row.getByRole('button', { name: '前端 模型：e2e-other-model', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Coordinator 模型：codex-e2e-model', exact: true })).toBeVisible()
  await expect(page.getByRole('alert').filter({ hasText: '未保存' })).toHaveCount(0)
  await testInfo.attach('bot-agents', { body: await page.screenshot(), contentType: 'image/png' })

  // The fallbacks save too: a reload keeps the choice.
  await fallback.getByRole('button', { name: '默认 设备离线时：等它上线', exact: true }).click()
  // The choice is one save (a server action); wait for it before reloading.
  const saved = page.waitForResponse(response => response.request().method() === 'POST' && Boolean(response.request().headers()['next-action']))
  await page.getByRole('option', { name: '改到云端运行' }).click()
  expect((await saved).ok()).toBe(true)
  await expect(fallback.getByRole('button', { name: '默认 设备离线时：改到云端运行', exact: true })).toBeVisible()
  await expect(page.getByRole('alert').filter({ hasText: '未保存' })).toHaveCount(0)
  await page.reload()
  await expect(fallback.getByRole('button', { name: '默认 设备离线时：改到云端运行', exact: true })).toBeVisible()

  await row.getByRole('button', { name: '前端 的更多操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '删除', exact: true }).click()
  await expect(row).toHaveCount(0)
  await page.reload()
  await expect(page.locator('[data-rule="前端"]')).toHaveCount(0)
  await expect(fallback).toBeVisible()
})

test('Bot 与 Agents：规则标签从工作区已有标签中选，标签带颜色', async ({ page }) => {
  await register(page, '/settings?section=bots')
  await expect(page.getByRole('button', { name: '添加规则', exact: true })).toBeVisible()
  const cookie = (await page.context().cookies()).find(item => item.name.endsWith('session_token'))
  const { rows: [session] } = await db().query<{ userId: string }>('SELECT "userId" FROM session WHERE token = $1', [decodeURIComponent(cookie!.value).split('.')[0]])
  const { rows: [member] } = await db().query<{ workspaceId: string }>('SELECT "workspaceId" FROM mikka_workspace_members WHERE "userId" = $1 AND status = $2 LIMIT 1', [session.userId, 'active'])
  // Workspace labels come from the workspace's team tasks.
  const content = { type: 'doc', attrs: { mikka: { labels: [{ name: '前端', color: 'blue' }, { name: '后端', color: 'green' }] } }, content: [] }
  const [issue, team] = [randomUUID(), randomUUID()]
  await db().query('INSERT INTO issues (id, "userId", title, content, status, priority, scope) VALUES ($1, $2, $3, $4, $5, $6, $7)', [issue, session.userId, 'Labelled issue', JSON.stringify(content), 'todo', 'normal', 'workspace'])
  await db().query('INSERT INTO mikka_teams (id, "workspaceId", "userId", name, identifier) VALUES ($1, $2, $3, $4, $5)', [team, member.workspaceId, session.userId, 'Labels', `L${team.slice(0, 4).toUpperCase()}`])
  await db().query('INSERT INTO mikka_team_issues ("issueId", "teamId", "workspaceId", "userId") VALUES ($1, $2, $3, $4)', [issue, team, member.workspaceId, session.userId])
  // A rule needs a real place and model to save, as the server checks; seed the device and accounts.
  await seed(page)
  await page.reload()

  await page.getByRole('button', { name: '添加规则', exact: true }).click()
  await page.getByRole('textbox', { name: '标签', exact: true }).fill('前端')
  await page.getByRole('button', { name: '添加', exact: true }).click()
  const cell = page.locator('[data-rule="前端"]').getByRole('button', { name: '前端 标签：前端', exact: true })
  await expect(cell.locator('svg.text-label-blue')).toBeVisible()

  await cell.click()
  const options = page.getByRole('group', { name: '标签', exact: true })
  await expect(options.getByRole('button', { name: '前端', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await options.getByRole('button', { name: '后端', exact: true }).click()
  const picked = page.locator('[data-rule="后端"]').getByRole('button', { name: '后端 标签：后端', exact: true })
  await expect(picked.locator('svg.text-success-foreground')).toBeVisible()
  await page.reload()
  await expect(picked).toBeVisible()
  await expect(page.getByRole('alert').filter({ hasText: '未保存' })).toHaveCount(0)
})
