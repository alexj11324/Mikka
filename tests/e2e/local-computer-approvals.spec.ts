import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { test, expect, register, app } from './fixtures'

test('owner web review bridges exact device snapshot; rejects cross-owner, argument changes, replay and stopped runs', async ({ page, request, baseURL }, info) => {
  test.skip(process.env.CI !== 'true', 'Database execution is CI-only')
  const url = new URL(process.env.E2E_DATABASE_URL!)
  expect(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname === '/mikka_e2e').toBe(true)
  const { email } = await register(page, '/devices/approvals')
  const pool = new Pool({ connectionString: url.toString(), max: 1 })
  const [deviceId, otherDevice, agentId, runId, tokenId, otherToken] = Array.from({ length: 6 }, () => randomUUID())
  const token = randomBytes(32).toString('hex')
  const stranger = randomBytes(32).toString('hex')
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  try {
    const userId = (await pool.query('select id from "user" where email=$1', [email])).rows[0].id
    await pool.query(`insert into devices (id,"ownerId",name) values ($1,$2,'CI approved device'),($3,'other-owner','Other device')`, [deviceId,userId,otherDevice])
    await pool.query(`insert into agents (id,"userId",harness,name,"deviceId") values ($1,$2,'claude_code','CI fixture agent',$3)`, [agentId,userId,deviceId])
    await pool.query(`insert into agent_runs (id,"userId","agentId","deviceId",status) values ($1,$2,$3,$4,'running')`, [runId,userId,agentId,deviceId])
    await pool.query(`insert into device_tokens (id,"userId","tokenHash") values ($1,$2,$3),($4,'other-owner',$5)`, [tokenId,userId,hash(token),otherToken,hash(stranger)])
    const raw = { id: randomUUID(), runId, target: 'f'.repeat(64), call: { name: 'click', arguments: { x: 3, y: 4 } }, expiresAt: Date.now()+240000 }
    const row = { ...raw, digest: hash(JSON.stringify(raw)) }
    const endpoint = app(`/v1/devices/${deviceId}/computer`)
    const sync = (data: unknown, authorization = token) => request.post(endpoint, { headers: { authorization: `Bearer ${authorization}` }, data })
    expect((await request.post(endpoint, { data: { requests: [row] } })).status()).toBe(401)
    expect((await sync({ requests: [row] }, stranger)).status()).toBe(404)
    expect((await sync({ requests: [{ ...row, call: { name: 'click', arguments: { x: 99, y: 4 } } }] })).status()).toBe(409)
    expect((await sync({ requests: [row] })).ok()).toBe(true)
    expect((await request.get(app('/api/devices/computer'))).status()).toBe(401)
    const outsider = await page.context().browser()!.newContext()
    const outsidePage = await outsider.newPage()
    try {
      await register(outsidePage, '/devices/approvals')
      expect((await (await outsidePage.request.get(app('/api/devices/computer'))).json()).requests).toEqual([])
      expect((await outsidePage.request.post(app('/api/devices/computer'), { data: { id: row.id, digest: row.digest, approve: true }, headers: { origin: new URL(baseURL!).origin } })).status()).toBe(409)
    } finally { await outsider.close() }
    expect((await sync({ requests: [row] })).ok()).toBe(true)
    const headers = { origin: new URL(baseURL!).origin }
    const decision = { id: row.id, digest: row.digest, approve: true }
    expect((await page.request.post(app('/api/devices/computer'), { data: decision, headers: { origin: 'https://other.invalid' } })).status()).toBe(401)
    expect((await page.request.post(app('/api/devices/computer'), { data: { ...decision, digest: 'a'.repeat(64) }, headers })).status()).toBe(409)
    await expect(page.getByText('CI approved device', { exact: true })).toBeVisible()
    await expect(page.locator('pre')).toContainText('"x": 3')
    await page.screenshot({ path: info.outputPath('local-web-owner-review.png') })
    await page.getByRole('button', { name: '批准这次操作', exact: true }).click()
    await expect(page.getByText('决定已排队等待设备接收，不代表已执行。结果会返回原来的 agent 工具调用。', { exact: true })).toBeVisible()
    expect((await page.request.post(app('/api/devices/computer'), { data: decision, headers })).status()).toBe(409)
    expect((await (await sync({ requests: [row] })).json()).decisions).toEqual([decision])
    expect((await (await sync({ requests: [] })).json()).decisions).toEqual([])
    const deniedRaw = { ...raw, id: randomUUID() }
    const deniedRow = { ...deniedRaw, digest: hash(JSON.stringify(deniedRaw)) }
    expect((await sync({ requests: [deniedRow] })).ok()).toBe(true)
    expect((await page.request.post(app('/api/devices/computer'), { data: { id: deniedRow.id, digest: deniedRow.digest, approve: false }, headers })).status()).toBe(200)
    expect((await (await sync({ requests: [deniedRow] })).json()).decisions).toEqual([{ id: deniedRow.id, digest: deniedRow.digest, approve: false }])
    const expiredRaw = { ...raw, id: randomUUID(), expiresAt: Date.now()-1 }
    expect((await sync({ requests: [{ ...expiredRaw, digest: hash(JSON.stringify(expiredRaw)) }] })).status()).toBe(409)
    expect((await (await sync({ requests: [] })).json()).decisions).toEqual([])
    await pool.query('update agent_runs set "stopRequestedAt"=now() where id=$1', [runId])
    expect((await sync({ requests: [row] })).status()).toBe(409)
    await expect(page.getByText('暂无等待你审批的本机操作。', { exact: true })).toBeVisible()
    await page.screenshot({ path: info.outputPath('local-web-decision-queued.png') })
  } finally {
    await pool.query('delete from device_tokens where id=any($1::uuid[])', [[tokenId,otherToken]])
    await pool.query('delete from local_computer_reviews where "deviceId"=$1', [deviceId])
    await pool.query('delete from agent_runs where id=$1', [runId])
    await pool.query('delete from agents where id=$1', [agentId])
    await pool.query('delete from devices where id=any($1::uuid[])', [[deviceId,otherDevice]])
    await pool.end()
  }
})
