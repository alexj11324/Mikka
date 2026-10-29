import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { test, expect, register, app } from './fixtures'

test('the real events API projects the latest reply into owner-scoped thread lists', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 960 })
  const { email } = await register(page)
  const connectionString = process.env.E2E_DATABASE_URL
  if (!connectionString) throw new Error('Isolated E2E_DATABASE_URL required')
  const target = new URL(connectionString)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !target.pathname.endsWith('_e2e')) throw new Error('Refusing a business database')
  const pool = new Pool({ connectionString, max: 1 })
  const marker = randomUUID().slice(0, 8)
  const device = randomUUID(), agent = randomUUID(), first = randomUUID(), second = randomUUID(), mcp = randomUUID()
  const token = randomBytes(32).toString('base64url')
  try {
    const { rows: [user] } = await pool.query('SELECT id FROM "user" WHERE email=$1', [email])
    await pool.query('INSERT INTO devices (id,"ownerId",name) VALUES ($1,$2,$3)', [device, user.id, 'Projection fixture'])
    await pool.query('INSERT INTO device_tokens (id,"userId","tokenHash") VALUES ($1,$2,$3)', [randomUUID(), user.id, createHash('sha256').update(token).digest('hex')])
    await pool.query('INSERT INTO agents (id,"userId",harness,name,"deviceId") VALUES ($1,$2,$3,$4,$5)', [agent, user.id, 'codex', 'Projection fixture', device])
    for (const [id, prompt, source, owner] of [
      [first, `Updated status ${marker}`, null, user.id],
      [second, `Recent reply ${marker}`, null, user.id],
      [mcp, `MCP dispatch ${marker}`, 'mcp', user.id],
      [randomUUID(), `Foreign private ${marker}`, null, `foreign-${randomUUID()}`],
    ]) {
      await pool.query('INSERT INTO agent_runs (id,"userId","agentId","deviceId",status,prompt,source) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, owner, agent, device, 'running', prompt, source])
    }
    const response = await page.request.post(app(`/v1/runs/${first}/events`), {
      headers: { authorization: `Bearer ${token}` },
      data: { fromSeq: 1, chunks: [{ type: 'text-delta', id: 'reply', delta: '**Actual route reply**' }] },
    })
    expect(response.status()).toBe(200)
    await pool.query('UPDATE agent_runs SET "lastReplyAt"=now()-interval \'10 minutes\',"updatedAt"=now() WHERE id=$1', [first])
    await pool.query('UPDATE agent_runs SET "lastReply"=$2,"lastReplyAt"=now()-interval \'5 minutes\',"updatedAt"=now()-interval \'5 minutes\' WHERE id=$1', [second, 'Older activity'])

    await page.goto(app('/?section=coordinator'))
    const panel = page.getByRole('complementary', { name: '右栏', exact: true })
    await expect(panel).toBeVisible()
    await expect(panel.getByText('Actual route reply', { exact: true })).toBeVisible()
    await expect(panel.getByText(`MCP dispatch ${marker}`, { exact: true })).toHaveCount(0)
    await expect(panel.getByText(`Foreign private ${marker}`, { exact: true })).toHaveCount(0)
    await panel.getByRole('tab', { name: '全部线程', exact: true }).click()
    const running = panel.getByRole('region', { name: '进行中（3）', exact: true })
    await expect(running.getByRole('listitem')).toHaveCount(3)
    // Ignore the MCP row's newer timestamp: the two app rows must still keep
    // their actual activity order, rather than the first row's older reply time.
    const names = await running.getByRole('listitem').allTextContents()
    expect(names.findIndex(name => name.includes(`Updated status ${marker}`))).toBeLessThan(names.findIndex(name => name.includes(`Recent reply ${marker}`)))
    await expect(panel.getByText(`MCP dispatch ${marker}`, { exact: true })).toBeVisible()
    await expect(panel.getByText(`Foreign private ${marker}`, { exact: true })).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('thread-projection.png') })
  } finally {
    // Revoke this synthetic test token without deleting its audit row or data.
    await pool.query('UPDATE device_tokens SET "revokedAt"=now() WHERE "tokenHash"=$1', [createHash('sha256').update(token).digest('hex')])
    await pool.end()
  }
})
