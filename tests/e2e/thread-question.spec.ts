import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { test, expect, register, seedTask, openIssueFromSearch } from './fixtures'

function isolatedPool() {
  const connectionString = process.env.E2E_DATABASE_URL
  if (!connectionString) throw new Error('Thread question acceptance requires an isolated E2E_DATABASE_URL')
  const target = new URL(connectionString)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !target.pathname.endsWith('_e2e')) throw new Error('Refusing to seed a business database')
  return new Pool({ connectionString, max: 1 })
}

// Only CI's disposable database: a run that stopped on a Factory question (status chosen per case).
async function shoot(page: import('@playwright/test').Page, testInfo: import('@playwright/test').TestInfo, name: string) {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    const path = testInfo.outputPath(`${name}-${scheme}.png`)
    await page.screenshot({ path })
    await testInfo.attach(`${name}-${scheme}`, { path, contentType: 'image/png' })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}

async function seedQuestion(email: string, title: string, prompt: string, status: 'waiting_user' | 'resuming' | 'expired') {
  const pool = isolatedPool()
  const client = await pool.connect()
  try {
    const { rows: [user] } = await client.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [email])
    const { rows: [issue] } = await client.query<{ id: string }>('SELECT id FROM issues WHERE "userId" = $1 AND title = $2', [user.id, title])
    const agentId = randomUUID(), runId = randomUUID(), taskId = randomUUID(), attemptId = randomUUID(), eventId = randomUUID(), questionId = randomUUID()
    const question = '首页大图换成 AVIF 能省 1.6 MB。Safari 15 以下不支持 AVIF，给它退回 JPEG，可以吗？'
    await client.query('BEGIN')
    await client.query('INSERT INTO agents (id, "userId", harness, name) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [agentId, user.id, 'claude_code', 'Question fixture'])
    const { rows: [agent] } = await client.query<{ id: string }>('SELECT id FROM agents WHERE "userId" = $1 AND name = $2', [user.id, 'Question fixture'])
    await client.query('INSERT INTO agent_runs (id, "userId", "issueId", "agentId", status, prompt, "stopReason", "sessionId", "finishedAt") VALUES ($1, $2, $3, $4, \'succeeded\', $5, \'asked_human\', \'fixture-session\', now())', [runId, user.id, issue.id, agent.id, prompt])
    await client.query('INSERT INTO run_chunks (id, "runId", seq, chunk) VALUES ($1, $2, 1, $3)', [randomUUID(), runId, JSON.stringify({ type: 'text-delta', id: runId, delta: question })])
    await client.query('INSERT INTO coordinator_events (id, "userId", kind, "dedupeKey", payload) VALUES ($1, $2, \'message\', $3, \'{}\')', [eventId, user.id, `e2e-${eventId}`])
    await client.query('SET CONSTRAINTS ALL DEFERRED')
    await client.query('INSERT INTO factory_tasks (id, "userId", "issueId", "sourceEventId", route, stage, status, "attemptId", reason) VALUES ($1, $2, $3, $4, \'{}\', \'execute\', \'waiting\', $5, \'question\')', [taskId, user.id, issue.id, eventId, attemptId])
    await client.query('INSERT INTO factory_attempts (id, "taskId", stage, ordinal, position, status, reason, "runId") VALUES ($1, $2, \'execute\', 1, 1, \'running\', \'question\', $3)', [attemptId, taskId, runId])
    const binding = { taskId, issueId: issue.id, attemptId, revision: 1, candidateId: null }
    await client.query(`INSERT INTO factory_questions (id, "userId", "issueId", "taskId", "attemptId", stage, "originRunId", "originSessionId", "originRevision", "waitingBinding", kind, question, request, status, reason, "sourceEventId", "expiresAt")
      VALUES ($1, $2, $3, $4, $5, 'execute', $6, 'fixture-session', 1, $7, 'decision', $8, '{}', $9, $8, $10, now() + interval '1 hour')`, [questionId, user.id, issue.id, taskId, attemptId, runId, JSON.stringify(binding), question, status, eventId])
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error }
  finally { client.release(); await pool.end() }
}

test('a thread that stopped on a question waits for your reply and takes the answer', async ({ page }, testInfo) => {
  test.skip(process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED !== '1' || process.env.MIKKA_FACTORY_ROUTING_ENABLED !== '1', 'Factory questions are behind the lifecycle flags')
  await page.setViewportSize({ width: 1440, height: 960 })
  const { email } = await register(page)
  const title = `Thread question ${randomUUID()}`
  await seedTask(page, title)
  await seedQuestion(email, title, 'Speed up the home page', 'waiting_user')
  await seedQuestion(email, title, 'Answered already', 'resuming')
  await seedQuestion(email, title, 'Too late to answer', 'expired')
  await openIssueFromSearch(page, title)
  const threads = page.getByRole('region', { name: /^线程/ })

  // 等你回复 (Figma 382:6469): the status says so and the composer stays, without a stop button.
  await threads.getByRole('button', { name: '打开线程 Speed up the home page', exact: true }).click()
  let panel = page.getByRole('region', { name: 'Speed up the home page', exact: true })
  await expect(panel.getByRole('img', { name: '等你回复' })).toBeVisible()
  await expect(panel.getByText('等你回复', { exact: true })).toBeVisible()
  const box = panel.getByRole('textbox', { name: '告诉 Question fixture 下一步做什么…' })
  await expect(box).toBeVisible()
  await expect(panel.getByRole('button', { name: /停止/ })).toHaveCount(0)
  await box.fill('可以，Safari 15 以下用 JPEG')
  await expect(panel.getByRole('button', { name: '发送', exact: true })).toBeEnabled()
  await shoot(page, testInfo, 'waiting')

  // Once answered, the reply is on its way: no second answer.
  await threads.getByRole('button', { name: '打开线程 Answered already', exact: true }).click()
  panel = page.getByRole('region', { name: 'Answered already', exact: true })
  await expect(panel.getByRole('textbox')).toBeVisible()
  await expect(panel.getByText('等你回复', { exact: true })).toHaveCount(0)
  await expect(panel.getByRole('button', { name: '发送', exact: true })).toBeDisabled()
  await shoot(page, testInfo, 'resuming')

  // An expired question takes no answer: an ordinary finished thread.
  await threads.getByRole('button', { name: '打开线程 Too late to answer', exact: true }).click()
  panel = page.getByRole('region', { name: 'Too late to answer', exact: true })
  await expect(panel.getByRole('list', { name: '线程对话' })).toBeVisible()
  await expect(panel.getByRole('textbox')).toHaveCount(0)
  await shoot(page, testInfo, 'expired')
})
