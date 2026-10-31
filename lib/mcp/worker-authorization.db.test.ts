import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { assertE2eTarget } from '../../tests/helpers/e2e-target.mjs'

const target = process.env.E2E_DATABASE_URL
if (target) {
  assertE2eTarget(target)
  assert.equal(process.env.MIKKA_DATABASE_URL, target)
  assert.equal(process.env.DATABASE_URL, target)
}
if (!target && process.env.REQUIRE_DB === '1') throw new Error('An isolated authorization database is required')

test('run tokens recheck current task, workspace and execution authority', { skip: !target }, async t => {
  const { Pool } = await import('pg')
  const { issueRunToken, revokeRunTokens, verifyRunToken } = await import('./worker')
  const { issueForUser } = await import('../issue-access')
  const { pool: appPool } = await import('../db')
  const { workspacePool } = await import('../workspace-db')
  const pool = new Pool({ connectionString: target, max: 2 })
  const owner = `auth207-owner-${randomUUID()}`, member = `auth207-member-${randomUUID()}`, outsider = `auth207-outsider-${randomUUID()}`
  const workspace = randomUUID(), otherWorkspace = randomUUID(), team = randomUUID()
  const shared = randomUUID(), personal = randomUUID(), ownPersonal = randomUUID()
  const devices = new Map<string, string>(), agents = new Map<string, string>()
  const bot = randomUUID()
  const runs: string[] = []
  t.after(async () => {
    for (const id of runs) await revokeRunTokens(id)
    await Promise.all([pool.end(), appPool.end(), workspacePool.end()])
  })
  for (const id of [owner, member, outsider]) {
    await pool.query('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$1,$2,true,now(),now())', [id, `${id}@example.invalid`])
    const device = randomUUID(), agent = randomUUID()
    devices.set(id, device); agents.set(id, agent)
    await pool.query('INSERT INTO devices (id,"ownerId",name) VALUES ($1,$2,\'Authorization fixture\')', [device, id])
    await pool.query('INSERT INTO agents (id,"userId",harness,name,"deviceId") VALUES ($1,$2,\'codex\',\'Authorization fixture\',$3)', [agent, id, device])
  }
  for (const [id, user] of [[workspace, owner], [otherWorkspace, outsider]]) {
    await pool.query('INSERT INTO mikka_workspaces (id,"userId",name) VALUES ($1,$2,\'Authorization fixture\')', [id, user])
  }
  for (const [id, user, role] of [[workspace, owner, 'admin'], [workspace, member, 'member'], [otherWorkspace, outsider, 'admin']]) {
    await pool.query('INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status) VALUES ($1,$2,$2,$3,$4,\'active\')', [id, user, `${user}@example.invalid`, role])
  }
  await pool.query('INSERT INTO mikka_teams (id,"workspaceId","userId",name,identifier) VALUES ($1,$2,$3,\'Authorization fixture\',\'A207\')', [team, workspace, owner])
  for (const [id, user, scope] of [[shared, owner, 'workspace'], [personal, owner, 'personal'], [ownPersonal, member, 'personal']]) {
    await pool.query('INSERT INTO issues (id,"userId",title,content,status,priority,scope) VALUES ($1,$2,\'Authorization fixture\',\'{"type":"doc","content":[]}\',\'doing\',\'normal\',$3)', [id, user, scope])
  }
  await pool.query('INSERT INTO mikka_team_issues ("issueId","teamId","workspaceId","userId") VALUES ($1,$2,$3,$4)', [shared, team, workspace, owner])
  await pool.query('INSERT INTO bots (id,"ownerId","workspaceId",name) VALUES ($1,$2,$3,\'Authorization fixture\')', [bot, member, workspace])

  async function fixture(user = member, issueId: string | null = shared, options: { device?: boolean; bot?: string } = {}) {
    const runId = randomUUID()
    await pool.query('INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","botId",status,"leaseExpiresAt") VALUES ($1,$2,$3,$4,$5,$6,\'running\',$7)',
      [runId, user, issueId, agents.get(user), options.device === false ? null : devices.get(user), options.bot ?? null, options.device === false ? null : new Date(Date.now() + 600_000)])
    runs.push(runId)
    const { token } = await issueRunToken({ id: runId, userId: user })
    const verify = () => verifyRunToken(new Request('http://127.0.0.1/mikka/api/mcp'), token)
    return { runId, token, verify }
  }

  await t.test('active members see only their workspace and own personal tasks', async () => {
    assert.ok(await issueForUser(member, shared))
    assert.equal(await issueForUser(outsider, shared), null)
    assert.equal(await issueForUser(member, personal), null)
    assert.ok(await issueForUser(member, ownPersonal))
    assert.ok(await (await fixture()).verify())
  })
  await t.test('suspending a member rejects its previously valid task token on the next call', async () => {
    const run = await fixture()
    assert.ok(await run.verify())
    await pool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspace, member])
    try {
      assert.equal(await issueForUser(member, shared), null)
      assert.equal(Boolean(await run.verify()), false)
    } finally { await pool.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspace, member]) }
  })
  await t.test('removing a member refuses its live task token', async () => {
    const run = await fixture()
    await pool.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2', [workspace, member])
    try { assert.equal(Boolean(await run.verify()), false) }
    finally { await pool.query('INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status) VALUES ($1,$2,$2,$3,\'member\',\'active\')', [workspace, member, `${member}@example.invalid`]) }
  })
  await t.test('a workspace bot token also stops after membership suspension without a task', async () => {
    const run = await fixture(member, null, { bot })
    assert.ok(await run.verify())
    await pool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspace, member])
    try { assert.equal(Boolean(await run.verify()), false) }
    finally { await pool.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspace, member]) }
  })
  await t.test('a STOP request refuses a token before the run status changes', async () => {
    const run = await fixture()
    await pool.query('UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1', [run.runId])
    assert.equal(Boolean(await run.verify()), false)
  })
  await t.test('a device run loses token authority when its lease expires before recovery', async () => {
    const run = await fixture()
    await pool.query('UPDATE agent_runs SET "leaseExpiresAt"=now()-interval \'1 second\' WHERE id=$1', [run.runId])
    assert.equal(Boolean(await run.verify()), false)
  })
  await t.test('an unleased personal non-device run keeps its existing protocol', async () => {
    assert.ok(await (await fixture(member, ownPersonal, { device: false })).verify())
    assert.ok(await (await fixture(owner, personal, { device: false })).verify())
  })
  await t.test('revoked and terminal-run tokens stay refused', async () => {
    const revoked = await fixture(), ended = await fixture()
    await revokeRunTokens(revoked.runId)
    await pool.query('UPDATE agent_runs SET status=\'failed\' WHERE id=$1', [ended.runId])
    assert.equal(Boolean(await revoked.verify()), false)
    assert.equal(Boolean(await ended.verify()), false)
  })
  await t.test('the exported MCP HTTP handler rejects a removed member before report writes', async () => {
    const { createServer } = await import('node:http')
    const { POST } = await import('../../app/api/mcp/route')
    const run = await fixture()
    const server = createServer(async (incoming, outgoing) => {
      try {
        const chunks: Buffer[] = []
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
        const request = new Request(`http://127.0.0.1${incoming.url}`, { method: 'POST', headers: {
          authorization: incoming.headers.authorization ?? '', 'content-type': 'application/json', accept: 'application/json, text/event-stream',
        }, body: Buffer.concat(chunks).toString('utf8') })
        const response = await POST(request)
        outgoing.writeHead(response.status, Object.fromEntries(response.headers))
        outgoing.end(await response.text())
      } catch { outgoing.writeHead(500); outgoing.end('handlerFailed') }
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const request = async (method: string, params: unknown) => fetch(`http://127.0.0.1:${address.port}/mikka/api/mcp`, {
      method: 'POST', signal: AbortSignal.timeout(10_000), headers: {
        authorization: `Bearer ${run.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    try {
      const allowed = await request('tools/list', {})
      assert.equal(allowed.status, 200)
      await allowed.text()
      const before = (await pool.query('SELECT count(*)::int AS count FROM coordinator_events WHERE "userId"=$1', [member])).rows[0].count
      await pool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspace, member])
      const denied = await request('tools/call', { name: 'report', arguments: { text: 'A removed worker must not deliver this report.' } })
      assert.equal(denied.status, 401)
      await denied.text()
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM coordinator_events WHERE "userId"=$1', [member])).rows[0].count, before)
    } finally {
      await pool.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspace, member])
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })
})
