import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { test, expect, register } from './fixtures'

// This fixture only touches CI's isolated disposable database, never a Preview or production DB.
async function seedRuns(email: string, title: string) {
  const connectionString = process.env.E2E_DATABASE_URL
  if (!connectionString) throw new Error('Issue run acceptance requires an isolated E2E_DATABASE_URL')
  const target = new URL(connectionString)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !target.pathname.endsWith('_e2e')) throw new Error('Refusing to seed a business database')
  const pool = new Pool({ connectionString, max: 1 })
  try {
    const { rows: [user] } = await pool.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [email])
    const { rows: [issue] } = await pool.query<{ id: string }>('SELECT id FROM issues WHERE "userId" = $1 AND title = $2', [user.id, title])
    const agentId = randomUUID()
    await pool.query('INSERT INTO agents (id, "userId", harness, name) VALUES ($1, $2, $3, $4)', [agentId, user.id, 'codex', 'Issue sidebar agent'])
    const ended = randomUUID()
    const active = randomUUID()
    for (const [runId, status] of [[ended, 'succeeded'], [active, 'running']]) {
      await pool.query('INSERT INTO agent_runs (id, "userId", "issueId", "agentId", status) VALUES ($1, $2, $3, $4, $5)', [runId, user.id, issue.id, agentId, status])
      await pool.query('INSERT INTO run_chunks (id, "runId", seq, chunk) VALUES ($1, $2, 1, $3)', [randomUUID(), runId, JSON.stringify({ type: 'text-delta', id: runId, delta: `Saved output ${status}` })])
    }
  } finally { await pool.end() }
}

test('Issue full-page navigation, run discussion persistence and independent session sidebar', async ({ page }) => {
  const { email } = await register(page)
  await page.getByRole('button', { name: '任务', exact: true }).click()
  await page.getByRole('button', { name: '新建任务', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '新建任务', exact: true })
  const title = `Run detail ${randomUUID()}`
  await dialog.getByLabel('任务标题', { exact: true }).fill(title)
  await dialog.getByRole('button', { name: '创建任务', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  await seedRuns(email, title)
  await page.getByRole('region', { name: '任务看板', exact: true }).getByText(title, { exact: true }).click()
  await expect(page.getByLabel('任务标题', { exact: true })).toHaveValue(title)
  await expect(page.getByRole('button', { name: '看板', exact: true })).toBeVisible()
  const records = page.getByRole('region', { name: 'Agent 运行记录', exact: true })
  await expect(records.getByRole('button', { name: '打开会话', exact: true })).toHaveCount(2)
  // Completed and active runs both open; close/reopen must not start/stop a run.
  const openers = records.getByRole('button', { name: '打开会话', exact: true })
  for (const index of [0, 1]) {
    await openers.nth(index).click()
    const session = page.getByRole('dialog', { name: 'Issue sidebar agent 的会话', exact: true })
    await expect(session).toBeVisible()
    await expect(session.getByRole('log', { name: 'Agent 输出' })).toContainText('Saved output')
    if (await session.getByLabel('给正在运行的 agent 发消息').count()) {
      await session.getByLabel('给正在运行的 agent 发消息').fill('Follow-up via existing message action')
      await session.getByRole('button', { name: '发送给 agent', exact: true }).click()
      await expect(session.getByRole('region', { name: '发给 agent 的消息' })).toContainText('Follow-up via existing message action')
    } else await expect(session.getByText('此次运行已结束。仍可查看会话，并在运行记录下评论。')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(session).not.toBeVisible()
  }
  await openers.first().click()
  await expect(page.getByRole('dialog', { name: 'Issue sidebar agent 的会话', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await records.getByRole('button', { name: '评论', exact: true }).first().click()
  await records.getByLabel('评论 Issue sidebar agent 的运行').fill('Saved run discussion')
  await records.getByRole('button', { name: '发表评论', exact: true }).click()
  await expect(records.getByText('Saved run discussion', { exact: true })).toBeVisible()
  await expect(page.getByText('已自动保存', { exact: true })).toBeVisible()
  // Board navigation uses the existing document flush before unmounting the editor.
  await page.getByRole('button', { name: '看板', exact: true }).click()
  await page.getByRole('region', { name: '任务看板', exact: true }).getByText(title, { exact: true }).click()
  await page.reload()
  await expect(records.getByText('Saved run discussion', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '看板', exact: true }).click()
  await expect(page.getByRole('region', { name: '任务看板', exact: true })).toBeVisible()
})
