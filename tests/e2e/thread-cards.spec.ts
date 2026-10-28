import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { test, expect, register, seedTask } from './fixtures'

function isolatedPool() {
  const connectionString = process.env.E2E_DATABASE_URL
  if (!connectionString) throw new Error('Thread card acceptance requires an isolated E2E_DATABASE_URL')
  const target = new URL(connectionString)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !target.pathname.endsWith('_e2e')) throw new Error('Refusing to seed a business database')
  return new Pool({ connectionString, max: 1 })
}

// This fixture only touches CI's isolated disposable database, never a Preview or production DB.
// It writes the Coordinator turn a dispatch_run leaves behind: the call, its result, then the reply.
async function seedDispatch(email: string, title: string) {
  const pool = isolatedPool()
  try {
    const { rows: [user] } = await pool.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [email])
    const { rows: [issue] } = await pool.query<{ id: string }>('SELECT id FROM issues WHERE "userId" = $1 AND title = $2', [user.id, title])
    const agentId = randomUUID()
    const runId = randomUUID()
    await pool.query('INSERT INTO agents (id, "userId", harness, name) VALUES ($1, $2, $3, $4)', [agentId, user.id, 'codex', 'Mikka Frontend'])
    await pool.query('INSERT INTO agent_runs (id, "userId", "issueId", "agentId", status, prompt) VALUES ($1, $2, $3, $4, $5, $6)', [runId, user.id, issue.id, agentId, 'running', 'Speed up the home page\nMeasure first.'])
    let seq = 0
    for (const chunk of [{ type: 'text-delta', id: 't1', delta: 'Home page loads in 3.8s.' }, { type: 'tool-input-available', toolCallId: 'a' }, { type: 'tool-input-available', toolCallId: 'b' }]) {
      await pool.query('INSERT INTO run_chunks (id, "runId", seq, chunk) VALUES ($1, $2, $3, $4)', [randomUUID(), runId, ++seq, JSON.stringify(chunk)])
    }
    const messages = [
      { role: 'user', content: 'The home page is slow' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'dispatch_run', input: {} }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'dispatch_run', output: { type: 'json', value: { runId, status: 'queued' } } }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Mikka Frontend is on it.' }] },
    ]
    for (const [index, message] of messages.entries()) {
      await pool.query('INSERT INTO coordinator_messages (id, "userId", position, message) VALUES ($1, $2, $3, $4)', [randomUUID(), user.id, index + 1, JSON.stringify(message)])
    }
  } finally { await pool.end() }
}

test('A dispatched thread is a card under the reply that opens its conversation in place of the chat (R-66)', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 960 })
  const { email } = await register(page)
  const title = `Thread card ${randomUUID()}`
  await seedTask(page, title)
  await seedDispatch(email, title)
  await page.reload()

  const chat = page.getByRole('region', { name: 'Coordinator', exact: true })
  const card = chat.getByRole('button', { name: '打开线程 Speed up the home page', exact: true })
  await expect(card).toBeVisible()
  const surface = chat.locator('[data-slot="thread-card"]').filter({ has: page.getByRole('button', { name: '打开线程 Speed up the home page', exact: true }) })
  await expect(surface).toContainText('Speed up the home page')
  await expect(surface.getByRole('img', { name: '运行中', exact: true })).toBeVisible()
  // R-66: status icon + title + real output chips; no avatar or progress row.
  await expect(surface).not.toContainText('交给 Codex')
  await expect(surface).not.toContainText('执行了 2 步')
  await testInfo.attach('thread-card', { body: await page.screenshot(), contentType: 'image/png' })

  await card.click()
  const thread = page.getByRole('region', { name: 'Speed up the home page', exact: true })
  await expect(thread.getByRole('list', { name: '线程对话' })).toContainText('Home page loads in 3.8s.')
  await expect(thread.getByRole('textbox', { name: '告诉 Mikka Frontend 下一步做什么…' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: '给 Coordinator 发消息' })).toHaveCount(0)
  await testInfo.attach('thread-open', { body: await page.screenshot(), contentType: 'image/png' })

  await thread.getByRole('button', { name: '返回 Coordinator', exact: true }).click()
  await expect(thread).toHaveCount(0)
  await expect(chat.getByRole('button', { name: '打开线程 Speed up the home page', exact: true })).toBeVisible()
})
