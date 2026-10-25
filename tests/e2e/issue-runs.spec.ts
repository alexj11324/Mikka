import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { test, expect, register, watchRuntime, seedTask, openIssueFromSearch } from './fixtures'

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
      await pool.query('INSERT INTO agent_runs (id, "userId", "issueId", "agentId", status, report) VALUES ($1, $2, $3, $4, $5, $6)', [runId, user.id, issue.id, agentId, status, status === 'succeeded' ? JSON.stringify({ summary: 'Private run summary' }) : null])
      await pool.query('INSERT INTO run_chunks (id, "runId", seq, chunk) VALUES ($1, $2, 1, $3)', [randomUUID(), runId, JSON.stringify({ type: 'text-delta', id: runId, delta: `Saved output ${status}` })])
    }
  } finally { await pool.end() }
}

test('Issue detail shows agent runs as activity rows with shared discussions', async ({ page, browser }, testInfo) => {
  const { email } = await register(page)
  const title = `Run detail ${randomUUID()}`
  await seedTask(page, title)
  await seedRuns(email, title)
  await openIssueFromSearch(page, title)
  await expect(page.getByLabel('任务标题', { exact: true })).toHaveValue(title)
  await expect(page.getByRole('navigation', { name: '当前位置', exact: true }).getByRole('button', { name: '看板', exact: true })).toBeVisible()
  const activity = page.getByRole('region', { name: '任务活动', exact: true })
  const records = activity.getByRole('article', { name: 'Issue sidebar agent 的运行', exact: true })
  await expect(records).toHaveCount(2)
  // The owner reads the report summary in the row; there is no separate session panel or second input.
  await expect(activity.getByText('Private run summary', { exact: true })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByText('Saved output', { exact: false })).toHaveCount(0)
  await records.first().getByRole('button', { name: '回复 Issue sidebar agent 的运行', exact: true }).click()
  await records.first().getByLabel('回复 Issue sidebar agent 的运行').fill('Saved run discussion')
  await records.first().getByRole('button', { name: '发送回复', exact: true }).click()
  await expect(records.first().getByText('Saved run discussion', { exact: true })).toBeVisible()
  const editedTitle = `${title} edited`
  await page.getByLabel('任务标题', { exact: true }).fill(editedTitle)
  await page.getByLabel('任务标题', { exact: true }).blur()
  await testInfo.attach('owner-run-rows', { body: await page.screenshot(), contentType: 'image/png' })
  // Board navigation uses the existing document flush before unmounting the editor.
  await page.getByRole('navigation', { name: '当前位置', exact: true }).getByRole('button', { name: '看板', exact: true }).click()
  await openIssueFromSearch(page, editedTitle)
  await page.reload()
  await expect(page.getByLabel('任务标题', { exact: true })).toHaveValue(editedTitle)
  await expect(records.first().getByText('Saved run discussion', { exact: true })).toBeVisible()
  // A distinct member sees the same issue-linked run rows and can discuss them,
  // but never receives the owner's agent name, summary or output.
  const colleague = await browser.newContext({ locale: 'zh-CN' })
  const colleagueErrors = watchRuntime(colleague)
  try {
    const teammatePage = await colleague.newPage()
    const teammate = await register(teammatePage)
    const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 1 })
    try {
      const { rows: [owner] } = await pool.query('SELECT id FROM "user" WHERE email=$1', [email])
      const { rows: [member] } = await pool.query('SELECT id FROM "user" WHERE email=$1', [teammate.email])
      const { rows: [issue] } = await pool.query('SELECT id FROM issues WHERE "userId"=$1 AND title=$2', [owner.id, editedTitle])
      await pool.query('INSERT INTO issue_members ("issueId","userId","memberId") VALUES ($1,$2,$3)', [issue.id,owner.id,member.id])
    } finally { await pool.end() }
    await teammatePage.reload()
    await openIssueFromSearch(teammatePage, editedTitle)
    const sharedRecords = teammatePage.getByRole('region', { name: '任务活动', exact: true }).getByRole('article', { name: 'Agent 的运行', exact: true })
    await expect(sharedRecords).toHaveCount(2)
    await expect(teammatePage.getByText('Issue sidebar agent', { exact: false })).toHaveCount(0)
    await expect(teammatePage.getByText('Private run summary', { exact: true })).toHaveCount(0)
    await expect(teammatePage.getByText('Saved output', { exact: false })).toHaveCount(0)
    await expect(sharedRecords.getByText('Saved run discussion', { exact: true })).toBeVisible()
    await sharedRecords.first().getByRole('button', { name: '回复 Agent 的运行', exact: true }).click()
    await sharedRecords.first().getByLabel('回复 Agent 的运行').fill('Teammate run discussion')
    await sharedRecords.first().getByRole('button', { name: '发送回复', exact: true }).click()
    await expect(sharedRecords.getByText('Teammate run discussion', { exact: true })).toBeVisible()
    await testInfo.attach('teammate-safe-run-rows', { body: await teammatePage.screenshot(), contentType: 'image/png' })
    await teammatePage.getByRole('navigation', { name: '当前位置', exact: true }).getByRole('button', { name: '看板', exact: true }).click()
    await page.reload()
    await expect(activity.getByText('Teammate run discussion', { exact: true })).toBeVisible()
  } finally {
    await colleague.close()
    expect(colleagueErrors).toEqual([])
  }
  await page.getByRole('navigation', { name: '当前位置', exact: true }).getByRole('button', { name: '看板', exact: true }).click()
  await expect(page.getByRole('region', { name: '任务看板', exact: true })).toBeVisible()
})
