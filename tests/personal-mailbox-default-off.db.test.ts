import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import test from 'node:test'
import { assertPersonalMailboxCITarget } from '../scripts/personal-mailbox-ci-target.mjs'
import { loadEnvironment, assertDatabaseIdentity } from '../scripts/test-accounts/environment.mjs'

// Mandatory CI-only real PG/handler regression. No schema preparation, model,
// authentication mock, mailbox migration, retained resources or fixture delete.
assertPersonalMailboxCITarget()
test('default-off claim, MCP and Coordinator work on tracked schema without mailbox columns', { timeout: 60_000 }, async t => {
  const environment = await loadEnvironment()
  const { pool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const { POST: claim } = await import('../app/v1/devices/[deviceId]/runs/[runId]/claim/route')
  const { POST: mailbox } = await import('../app/v1/mailbox/route')
  const { POST: mcp } = await import('../app/api/mcp/route')
  const { createCoordinatorRegistry } = await import('../workflows/coordinator/tools')
  const { mailboxCatalogue, personalMailbox } = await import('../workflows/coordinator/steps')
  const { freezeWorkerDefinition } = await import('../lib/agent-kit/worker')
  const owner = `mailbox-off-ci-${process.env.GITHUB_RUN_ID}-${randomUUID()}`
  const deviceId = randomUUID(), agentId = randomUUID(), repoId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), deviceTokenId = randomUUID()
  const deviceToken = `mkd_${randomBytes(32).toString('base64url')}`
  let runToken: string | undefined
  const tokenHash = (value: string) => createHash('sha256').update(value).digest('hex')
  const request = (path: string, token?: string, body: unknown = {}) => new Request(`http://127.0.0.1:3100/mikka${path}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })
  try {
    await assertDatabaseIdentity(pool, environment)
    assert.equal((await pool.query('show server_version_num')).rows[0].server_version_num.slice(0, 2), '17')
    await t.test('the reviewed mailbox schema is absent and legacy run columns are selected', async () => {
      assert.equal((await pool.query("select to_regclass('public.session_mailboxes') as mailbox")).rows[0].mailbox, null)
      const cols = await pool.query("select table_name,column_name from information_schema.columns where table_schema='public' and table_name in ('agent_runs','run_messages') and column_name in ('mailboxId','senderMailboxId','dedupeKey')")
      assert.equal(cols.rowCount, 0)
    })
    // Seven nonce-owned synthetic fixture rows. The only generated credential
    // is a CI-only device token hash; claim issues its normal short-lived run token.
    await pool.query('insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values($1,$1,$2,false,now(),now())', [owner, `${owner}@example.invalid`])
    await pool.query('insert into devices(id,"ownerId",name,kind,enabled,harnesses) values($1,$2,$3,\'local\',true,\'[]\')', [deviceId, owner, 'Mailbox default-off CI'])
    await pool.query('insert into agents(id,"userId",harness,name,"deviceId") values($1,$2,\'codex\',$3,$4)', [agentId, owner, 'Mailbox default-off CI', deviceId])
    await pool.query('insert into device_repos(id,"deviceId","userId","repoPath") values($1,$2,$3,$4)', [repoId, deviceId, owner, `/synthetic/${runId}`])
    await pool.query('insert into issues(id,"userId",title,content,status,priority,scope) values($1,$2,$3,\'{"type":"doc","content":[]}\',\'todo\',\'normal\',\'personal\')', [issueId, owner, 'Mailbox default-off CI'])
    const definition = freezeWorkerDefinition({ harness: 'codex', instructions: 'No model runs in this test', prompt: 'Fixture', parent: null, executionId: null })
    await pool.query('insert into agent_runs(id,"userId","issueId","agentId","deviceId","deviceRepoId",status,"agentDefinition") values($1,$2,$3,$4,$5,$6,\'queued\',$7)', [runId, owner, issueId, agentId, deviceId, repoId, JSON.stringify(definition)])
    await pool.query('insert into device_tokens(id,"userId",name,"tokenHash","lastUsedAt","expiresAt") values($1,$2,$3,$4,now(),now()+interval \'5 minutes\')', [deviceTokenId, owner, 'Mailbox default-off CI', tokenHash(deviceToken)])
    await t.test('actual device-authenticated claim keeps ordinary MCP and omits mailbox capability', async () => {
      const response = await claim(request(`/v1/devices/${deviceId}/runs/${runId}/claim`, deviceToken), { params: Promise.resolve({ deviceId, runId }) })
      assert.equal(response.status, 200)
      const assignment = await response.json()
      assert.equal(assignment.runId, runId)
      assert.ok(assignment.mcp && typeof assignment.mcp.token === 'string')
      assert.equal(Object.hasOwn(assignment.mcp, 'mailbox'), false)
      runToken = assignment.mcp.token
      assert.equal((await pool.query('select status from agent_runs where id=$1 and "userId"=$2', [runId, owner])).rows[0].status, 'preparing')
    })
    await t.test('actual run-authenticated MCP advertises legacy worker tools without new schema', async () => {
      assert.ok(runToken)
      const response = await mcp(request('/api/mcp', runToken, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }))
      assert.equal(response.status, 200)
      const text = await response.text()
      const packet = response.headers.get('content-type')?.includes('text/event-stream') ? JSON.parse(text.split('\n').find(line => line.startsWith('data: '))!.slice(6)) : JSON.parse(text)
      const names = packet.result.tools.map((tool: { name: string }) => tool.name)
      assert.ok(names.includes('report') && names.includes('ask') && names.includes('blocked'))
      assert.equal(names.some((name: string) => name.startsWith('mailbox_')), false)
    })
    await t.test('default-off mailbox endpoint refuses before authentication/store SQL', async () => {
      assert.equal((await mailbox(request('/v1/mailbox', runToken, { action: 'inbox' }))).status, 503)
    })
    await t.test('real Coordinator catalogue and callback do not load mailbox schema when off', async () => {
      const registry = createCoordinatorRegistry(owner, null)
      assert.ok('dispatch_run' in registry && 'send_to_run' in registry)
      assert.equal(Object.keys(registry).some(name => name.startsWith('mailbox_')), false)
      assert.deepEqual(await mailboxCatalogue(owner, null, randomUUID()), [])
      assert.deepEqual(await personalMailbox(owner, null, { action: 'inbox' }), { error: 'personal_mailbox_unavailable' })
    })
    await t.test('actual revoked-run bearer fails authentication without querying new schema', async () => {
      const revoked = await pool.query('update run_tokens set "revokedAt"=now() where "runId"=$1 and "userId"=$2 and "tokenHash"=$3 and "revokedAt" is null', [runId, owner, tokenHash(runToken!)])
      assert.equal(revoked.rowCount, 1)
      assert.equal((await mcp(request('/api/mcp', runToken, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }))).status, 401)
    })
  } finally {
    // Retain all records; expire only this nonce's synthetic capabilities.
    try {
      await pool.query('update run_tokens set "revokedAt"=coalesce("revokedAt",now()) where "runId"=$1 and "userId"=$2', [runId, owner])
      await pool.query('update device_tokens set "revokedAt"=now() where id=$1 and "userId"=$2', [deviceTokenId, owner])
    } finally { await Promise.all([pool.end(), workspacePool.end()]) }
  }
})
