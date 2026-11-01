import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { test, expect, register, seedTask, app } from './fixtures'

// Seeds only CI's isolated disposable database.
function isolatedPool() {
  const connectionString = process.env.E2E_DATABASE_URL
  if (!connectionString) throw new Error('Requires an isolated E2E_DATABASE_URL')
  const target = new URL(connectionString)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !target.pathname.endsWith('_e2e')) throw new Error('Refusing to seed a business database')
  return new Pool({ connectionString, max: 1 })
}

test('on a task page, thread times clear their chevron and the block gutter sits left of the text', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const { email } = await register(page)
  const issueId = await seedTask(page, `Overlap ${randomUUID()}`)
  const pool = isolatedPool()
  try {
    const { rows: [user] } = await pool.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [email])
    const content = { type: 'doc', attrs: { mikka: { number: 1 } }, content: [
      { type: 'paragraph', content: [{ type: 'text', text: '登录后回跳丢了前缀。' }] },
      { type: 'paragraph', content: [{ type: 'text', text: '要求' }] },
    ] }
    await pool.query('UPDATE issues SET content = $2 WHERE id = $1', [issueId, content])
    await pool.query('UPDATE issue_versions SET content = $2 WHERE "issueId" = $1', [issueId, content])
    const agentId = randomUUID()
    await pool.query('INSERT INTO agents (id, "userId", harness, name) VALUES ($1, $2, $3, $4)', [agentId, user.id, 'claude_code', 'Mikka Backend'])
    // "27 minutes ago" is the longest English relative time a thread row shows.
    await pool.query(`INSERT INTO agent_runs (id, "userId", "issueId", "agentId", status, prompt, "createdAt", "finishedAt") VALUES ($1, $2, $3, $4, 'succeeded', 'Run', now() - interval '29 minutes', now() - interval '27 minutes')`, [randomUUID(), user.id, issueId, agentId])
  } finally { await pool.end() }

  await page.goto(app(`/en?section=all-issues&issue=${issueId}`))
  const row = page.getByRole('button', { name: 'Open thread Run', exact: true }).filter({ has: page.locator('time') })
  await expect(row.locator('time')).toHaveText('27 minutes ago')
  const { textRight, chevronLeft } = await row.evaluate(button => {
    const range = document.createRange()
    range.selectNodeContents(button.querySelector('time')!)
    return { textRight: range.getBoundingClientRect().right, chevronLeft: button.querySelector(':scope > svg:last-child')!.getBoundingClientRect().left }
  })
  expect(textRight).toBeLessThanOrEqual(chevronLeft)

  const line = page.getByText('要求', { exact: true })
  const box = (await line.boundingBox())!
  await page.mouse.move(box.x + box.width + 40, box.y + box.height / 2)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 })
  const grip = page.getByRole('button', { name: 'Block actions', exact: true })
  await expect(grip).toBeVisible()
  const textLeft = await line.evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); return range.getBoundingClientRect().left })
  const add = (await page.getByRole('button', { name: 'Add block', exact: true }).boundingBox())!
  const handle = (await grip.boundingBox())!
  expect(add.x).toBeLessThan(handle.x)
  expect(handle.x + handle.width).toBeLessThanOrEqual(textLeft)
})
