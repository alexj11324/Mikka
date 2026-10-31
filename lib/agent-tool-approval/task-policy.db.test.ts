import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import test from 'node:test'
import { assertE2eTarget } from '../../tests/helpers/e2e-target.mjs'
import { Pool } from 'pg'
import { readCliRunPolicy } from './policy-store'
import { setCliPolicy } from './policy-settings'
import { AgentToolApprovalStore } from './store'

const target = process.env.E2E_DATABASE_URL
if (target) {
  assertE2eTarget(target)
  assert.equal(process.env.MIKKA_DATABASE_URL, target)
  assert.equal(process.env.DATABASE_URL, target)
}
if (!target && process.env.REQUIRE_DB === '1') throw Error('An isolated task policy database is required')

test('task workspace policy applies to Coordinator and cross-workspace Bot runs', { skip: !target }, async t => {
  const pool = new Pool({ connectionString: target })
  const { workspacePool } = await import('../workspace-db')
  const { pool: appPool } = await import('../db')
  const tokenId = randomUUID(), token = randomUUID()
  let server: ReturnType<typeof createServer> | undefined
  t.after(async () => {
    try {
      if (server) {
        server.closeAllConnections()
        await new Promise<void>(resolve => server!.close(() => resolve()))
      }
      await pool.query('UPDATE device_tokens SET "revokedAt"=now() WHERE id=$1', [tokenId])
    } finally { await Promise.all([pool.end(), workspacePool.end(), appPool.end()]) }
  })
  const owner = `policy230-${randomUUID()}`, device = randomUUID(), agent = randomUUID()
  const workspaceA = randomUUID(), workspaceB = randomUUID(), botB = randomUUID()
  await pool.query('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$1,$2,true,now(),now())', [owner, `${owner}@example.invalid`])
  await pool.query('INSERT INTO devices (id,"ownerId",name) VALUES ($1,$2,\'Task policy fixture\')', [device, owner])
  await pool.query('INSERT INTO agents (id,"userId",harness,name,"deviceId") VALUES ($1,$2,\'codex\',\'Task policy fixture\',$3)', [agent, owner, device])
  for (const id of [workspaceA, workspaceB]) {
    await pool.query('INSERT INTO mikka_workspaces (id,"userId",name) VALUES ($1,$2,\'Task policy fixture\')', [id, owner])
    await pool.query('INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status) VALUES ($1,$2,$2,$3,\'admin\',\'active\')', [id, owner, `${owner}@example.invalid`])
  }
  await pool.query('INSERT INTO bots (id,"ownerId","workspaceId",name) VALUES ($1,$2,$3,\'Task policy fixture\')', [botB, owner, workspaceB])
  const workspacePolicyA = { permissions: { install_dependency: 'deny' } }
  await pool.query('INSERT INTO workspace_computer_policies ("workspaceId",cli_run_policy) VALUES ($1,$2),($3,$4)', [workspaceA, workspacePolicyA, workspaceB, { permissions: { git_push: 'deny' } }])
  async function fixture(workspaceId: string | null, botId: string | null = null) {
    const issue = randomUUID(), run = randomUUID()
    await pool.query('INSERT INTO issues (id,"userId",title,content,status,priority,scope) VALUES ($1,$2,\'Task policy fixture\',\'{"type":"doc","content":[]}\',\'doing\',\'normal\',$3)', [issue, owner, workspaceId ? 'workspace' : 'personal'])
    if (workspaceId) {
      const team = randomUUID()
      await pool.query('INSERT INTO mikka_teams (id,"workspaceId","userId",name,identifier) VALUES ($1,$2,$3,\'Task policy fixture\',$4)', [team, workspaceId, owner, `T${team.slice(0, 8)}`])
      await pool.query('INSERT INTO mikka_team_issues ("issueId","teamId","workspaceId","userId") VALUES ($1,$2,$3,$4)', [issue, team, workspaceId, owner])
    }
    await pool.query('INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","botId",status,"leaseExpiresAt") VALUES ($1,$2,$3,$4,$5,$6,\'running\',now()+interval \'5 minutes\')', [run, owner, issue, agent, device, botId])
    return { issue, run }
  }
  const a = await fixture(workspaceA), b = await fixture(workspaceB), personal = await fixture(null), cross = await fixture(workspaceA, botB)
  const read = (run: string) => readCliRunPolicy(pool, run, owner)
  await pool.query('INSERT INTO device_tokens (id,"userId","tokenHash") VALUES ($1,$2,$3)', [tokenId, owner, createHash('sha256').update(token).digest('hex')])
  const { POST } = await import('../../app/v1/runs/[runId]/tool-approval/route')
  server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const result = await POST(new Request(`http://127.0.0.1${request.url}`, { method: 'POST', headers: request.headers as HeadersInit, body: Buffer.concat(chunks) }), { params: Promise.resolve({ runId: a.run }) })
      response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(await result.text())
    } catch { response.writeHead(500).end() }
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const checkHTTP = (policyRevision: string) => fetch(`http://127.0.0.1:${address.port}/v1/runs/${a.run}/tool-approval`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ operation: 'check', deviceId: device, policyRevision }),
  })
  await t.test('Coordinator tasks inherit their own workspace ceiling without changing the global head', async () => {
    const policyA = await read(a.run), policyB = await read(b.run), privatePolicy = await read(personal.run)
    assert.equal(policyA.workspaceId, workspaceA)
    assert.equal(policyA.policy.permissions.install_dependency, 'deny')
    assert.equal(policyB.policy.permissions.git_push, 'deny')
    assert.equal(policyB.policy.permissions.install_dependency, 'allow')
    assert.equal(privatePolicy.workspaceId, null)
    assert.equal(privatePolicy.policy.permissions.install_dependency, 'allow')
    const head = (await pool.query('SELECT workspace_id FROM agent_kit_heads WHERE owner_id=$1 AND bot_key=\'coordinator\'', [owner])).rows[0]
    assert.equal(head.workspace_id, null)
  })
  await t.test('a Bot in another workspace keeps both ceilings and both memberships', async () => {
    const current = await read(cross.run)
    assert.equal(current.policy.permissions.install_dependency, 'deny')
    assert.equal(current.policy.permissions.git_push, 'deny')
    await pool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspaceB, owner])
    await assert.rejects(read(cross.run))
    assert.equal((await read(a.run)).policy.permissions.install_dependency, 'deny')
    await pool.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspaceB, owner])
  })
  await t.test('workspace changes revoke an existing approval and rollback never revives its revision', async () => {
    const store = new AgentToolApprovalStore(pool), actor = { userId: owner, deviceId: device }
    const initial = await read(a.run)
    assert.deepEqual(await (await checkHTTP(initial.revision)).json(), { live: true, paused: false })
    const approval = await store.propose(actor, { runId: a.run, requestId: randomUUID(), harness: 'codex', method: 'item/commandExecution/requestApproval', input: { command: 'synthetic' }, policyRevision: initial.revision })
    await store.decide(owner, a.run, approval.id, approval.digest, 'approve')
    const changed = await setCliPolicy(pool, owner, a.run, 'workspace', initial.revision, { permissions: { install_dependency: 'deny', git_push: 'deny' } })
    assert.equal(await store.check(actor, a.run, initial.revision), false)
    assert.deepEqual(await (await checkHTTP(initial.revision)).json(), { live: false, paused: false })
    await assert.rejects(store.take(actor, a.run, approval.id, approval.digest))
    const reverted = await setCliPolicy(pool, owner, a.run, 'workspace', changed.revision, workspacePolicyA)
    assert.notEqual(reverted.revision, initial.revision)
    await assert.rejects(store.take(actor, a.run, approval.id, approval.digest))
    assert.equal(await store.check(actor, a.run, reverted.revision), true)
  })
  await t.test('a lower agent layer cannot loosen the task workspace limit', async () => {
    const current = await read(a.run)
    const next = await setCliPolicy(pool, owner, a.run, 'agent', current.revision, { permissions: { install_dependency: 'allow' } })
    assert.equal(next.policy.permissions.install_dependency, 'deny')
    assert.equal((await read(personal.run)).policy.permissions.install_dependency, 'allow')
  })
  await t.test('task membership revocation denies the next live check and policy read', async () => {
    const store = new AgentToolApprovalStore(pool), current = await read(a.run)
    await pool.query('UPDATE mikka_workspace_members SET status=\'removed\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspaceA, owner])
    await assert.rejects(read(a.run))
    await assert.rejects(store.check({ userId: owner, deviceId: device }, a.run, current.revision))
    assert.equal((await checkHTTP(current.revision)).status, 409)
    assert.equal((await read(b.run)).policy.permissions.git_push, 'deny')
    assert.equal((await read(personal.run)).workspaceId, null)
  })
})
