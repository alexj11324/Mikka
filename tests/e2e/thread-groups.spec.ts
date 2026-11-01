import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { test, expect, register, app, seedTask } from './fixtures'

// R-52: the right column groups threads 进行中 · 受阻 · 等待你 · 空闲 · 已解决 by the
// judged outcome. A task's sixteen failed or blocked runs (the ZHIX-2 shape)
// fold into one 受阻 row, 第 16 次尝试, and nothing of it reads as 已解决.
// Outcomes are written as the judge would store them; no model runs.

function isolatedPool() {
  const connectionString = process.env.E2E_DATABASE_URL
  if (!connectionString) throw new Error('Isolated E2E_DATABASE_URL required')
  const target = new URL(connectionString)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !target.pathname.endsWith('_e2e')) throw new Error('Refusing a business database')
  return new Pool({ connectionString, max: 1 })
}

test('a task\'s failed and blocked attempts fold into one 受阻 row; only done work is 已解决', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 })
  const { email } = await register(page)
  const marker = randomUUID().slice(0, 8)
  const readme = await seedTask(page, `README ${marker}`)
  const shipped = await seedTask(page, `Shipped ${marker}`)
  const question = await seedTask(page, `Question ${marker}`)
  const pool = isolatedPool()
  try {
    const { rows: [user] } = await pool.query<{ id: string }>('SELECT id FROM "user" WHERE email=$1', [email])
    const device = randomUUID(), agent = randomUUID()
    await pool.query('INSERT INTO devices (id,"ownerId",name) VALUES ($1,$2,$3)', [device, user.id, 'Groups fixture'])
    await pool.query('INSERT INTO agents (id,"userId",harness,name,"deviceId") VALUES ($1,$2,$3,$4,$5)', [agent, user.id, 'claude_code', 'Groups fixture', device])
    const run = (issueId: string, status: string, outcome: string | null, lastReply: string, minutesAgo: number) => pool.query(
      `INSERT INTO agent_runs (id,"userId","agentId","deviceId","issueId",status,prompt,"botId",outcome,"lastReply","createdAt","updatedAt","finishedAt")
       VALUES ($1,$2,$3,$4,$5,$6,'Write the README',(SELECT "botId" FROM coordinator_bots WHERE "ownerId"=$2),$7,$8,now()-make_interval(mins => $9),now()-make_interval(mins => $9),now()-make_interval(mins => $9))`,
      [randomUUID(), user.id, agent, device, issueId, status, outcome, lastReply, minutesAgo])
    const replies = ['Not logged in · Please run /login', 'I couldn\'t open the PR', '我没有创建 PR，gh 拿不到凭证']
    for (let index = 0; index < 16; index++) await run(readme, index % 3 === 1 ? 'failed' : 'succeeded', index % 3 === 1 ? 'failed' : 'blocked', replies[index % 3], 200 - index * 10)
    await run(shipped, 'succeeded', 'done', 'Merged the docs change.', 30)
    await run(question, 'succeeded', 'needs_input', 'Which branch should the release go to?', 20)
  } finally { await pool.end() }

  await page.goto(app('/?section=coordinator'))
  const panel = page.getByRole('complementary', { name: '右栏', exact: true })
  await panel.getByRole('tab', { name: '全部线程', exact: true }).click()
  const blocked = panel.getByRole('region', { name: '受阻（1）', exact: true })
  await expect(blocked.getByRole('listitem')).toHaveCount(1)
  await expect(blocked).toContainText(`README ${marker}`)
  await expect(blocked).toContainText('第 16 次尝试')
  // Each row leads with its group's status icon, never a bot's avatar (R-52, R-78).
  await expect(blocked.getByRole('img', { name: '受阻', exact: true })).toHaveCount(1)
  await expect(panel.getByRole('group', { name: '线程', exact: true }).locator('[data-slot="bot-avatar"]')).toHaveCount(0)
  await expect(panel.getByRole('region', { name: '等待你（1）', exact: true })).toContainText(`Question ${marker}`)
  // 已解决 holds only the done task, collapsed.
  const resolved = panel.getByRole('button', { name: /^已解决（1）/ })
  await expect(resolved).toBeVisible()
  await expect(panel.getByText(`Shipped ${marker}`)).toHaveCount(0)
  await resolved.click()
  await expect(panel.getByText(`Shipped ${marker}`)).toBeVisible()
  await expect(panel.getByText(`README ${marker}`)).toHaveCount(1)
})
