import { after, before, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { Pool } from 'pg'

const url = process.env.APPROVAL_TEST_DATABASE_URL
if (!url) throw new Error('isolated database required')
const target = new URL(url)
if (!['localhost','127.0.0.1','[::1]'].includes(target.hostname) || target.pathname !== '/approval_e2e') throw new Error('Refusing non-isolated database')
const pool = new Pool({ connectionString: url }); const runId = randomUUID(), deviceId = randomUUID(), agentId = randomUUID()
const owner = `synthetic-${randomUUID()}`, issueId = randomUUID(), repoId = randomUUID()
let selectIndex = 0, support = true
const rows = [
  [{ id:runId, userId:owner, deviceId, agentId, deviceRepoId:repoId, issueId, kind:'implement', prompt:'APPROVAL_TEST', agentDefinition:null, retryOf:null }],
  [{ id:agentId, userId:owner, harness:'codex' }],
  [{ id:repoId, userId:owner, baseBranch:'main', verifyCommand:null }],
]
const db = { select: () => ({ from: () => ({ where: () => ({ limit: async () => rows[selectIndex++] }) }) }) }
mock.module(new URL('../db/index.ts', import.meta.url).href, { namedExports: { pool,db } })
mock.module(new URL('../device-link.ts', import.meta.url).href, { namedExports: { authenticateDevice: async (request: Request) => request.headers.get('authorization') === 'Bearer synthetic' ? { userId: owner } : null, ownedDevice: async () => ({ enabled:true,kind:'local',harnesses:[{harness:'codex',installed:true,...(support ? {toolApproval:true} : {})}] }) } })
mock.module(new URL('../mcp/worker.ts', import.meta.url).href, { namedExports: { issueRunToken: async () => ({token:'synthetic-token'}) } })
mock.module(new URL('../subscription-runtime.ts', import.meta.url).href, { namedExports: { subscriptionRuntime: () => ({ repository:{} }) } })
mock.module(new URL('../run-leases.ts', import.meta.url).href, { namedExports: { latestCheckpoint: async () => null } })
mock.module(new URL('../run-retry.ts', import.meta.url).href, { namedExports: { retryNote: () => '' } })
mock.module(new URL('../mcp/resource.ts', import.meta.url).href, { namedExports: { mcpResourceURL: null } })
mock.module(new URL('../personal-mailbox-config.ts', import.meta.url).href, { namedExports: { personalMailboxEnabled: () => false } })
mock.module(new URL('../auth.ts', import.meta.url).href, { namedExports: { auth: { api: { getSession: async ({ headers }: { headers: Headers }) => ({ user: { id: headers.get('cookie') === 'owner=1' ? owner : 'other' } }) } } } })
let server: Server, origin: string, dir: string, savedAssignment: import('@mikka/protocol/device').RunAssignment
before(async () => {
  await pool.query(`ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS "startedAt" timestamptz; ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS "updatedAt" timestamptz; CREATE TABLE IF NOT EXISTS computer_run_bindings ("runId" uuid PRIMARY KEY)` )
  await pool.query(`INSERT INTO agents (id,"userId",harness) VALUES ($1,$2,'codex')`, [agentId,owner])
  await pool.query(`INSERT INTO devices VALUES ($1,$2,true)`, [deviceId,owner])
  await pool.query(`INSERT INTO agent_kit_heads (owner_id,bot_key,workspace_id,cli_run_policy) VALUES ($1,'coordinator',NULL,'{"permissions":{"install_dependency":"allow"}}'::jsonb)`, [owner])
  await pool.query(`INSERT INTO agent_runs (id,"userId","deviceId",status,"stopRequestedAt","leaseExpiresAt","agentId","agentDefinition","botId") VALUES ($1,$2,$3,'queued',NULL,NULL,$4,NULL,NULL)`, [runId,owner,deviceId,agentId])
  const device = await import('../../app/v1/runs/[runId]/tool-approval/route')
  const claim = await import('../../app/v1/devices/[deviceId]/runs/[runId]/claim/route')
  const browser = await import('../../app/api/agent-tool-approvals/route')
  const settings = await import('../../app/api/agent-cli-policy/route')
  server = createServer(async (req,res) => {
    try {
      const chunks: Buffer[]=[]; for await (const part of req) chunks.push(Buffer.from(part))
      const request = new Request(`${origin}${req.url}`, { method: req.method, headers: req.headers as HeadersInit, body: Buffer.concat(chunks) })
      const response = req.url === '/api/agent-tool-approvals' ? await browser.POST(request) : req.url === '/api/agent-cli-policy' ? await settings.POST(request) : req.url?.endsWith('/claim') ? await claim.POST(request, { params: Promise.resolve({ runId,deviceId }) }) : await device.POST(request, { params: Promise.resolve({ runId }) })
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()))
    } catch { res.writeHead(500).end() }
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  dir = await mkdtemp(resolve(tmpdir(), 'pr13-approval-'))
  execFileSync('git', ['init', '-q', dir])
})
after(async () => { if (server) await new Promise<void>(r => server.close(() => r())); if (dir) await rm(dir,{recursive:true,force:true}); await pool.end() })
test('real HTTP claim carries policy and unavailable CLI callbacks do not create approvals', async () => {
  const { HttpServerLink } = await import('../../packages/daemon/src/server-link-http')
  const { CodexAdapter } = await import('../../packages/daemon/src/adapters/codex')
  const { NoSandbox } = await import('../../packages/daemon/src/agents/sandbox')
  const { createLogger } = await import('../../packages/daemon/src/log')
  const link = new HttpServerLink(origin)
  Object.assign(link, { credential: 'synthetic' })
  const settings = async (cookie: string, payload: object) => fetch(`${origin}/api/agent-cli-policy`, { method:'POST', headers:{cookie,origin,'content-type':'application/json'}, body:JSON.stringify(payload) })
  const unstartedAgent = randomUUID()
  await pool.query(`INSERT INTO agents (id,"userId",harness) VALUES ($1,$2,'codex')`, [unstartedAgent,owner])
  const beforeFirstRun = await settings('owner=1',{operation:'readAgent',agentId:unstartedAgent,botId:null})
  assert.equal(beforeFirstRun.status,200)
  const empty = await beforeFirstRun.json() as {revision:string}
  assert.equal((await settings('other=1',{operation:'setAgent',agentId:unstartedAgent,botId:null,target:'worker',expectedRevision:empty.revision,policy:{permissions:{install_dependency:'deny'}}})).status,409)
  assert.equal((await settings('owner=1',{operation:'setAgent',agentId:unstartedAgent,botId:null,target:'worker',expectedRevision:empty.revision,policy:{permissions:{install_dependency:'deny'}}})).status,200)
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM agent_runs WHERE "agentId"=$1',[unstartedAgent])).rows[0].count,0)
  const settingsRead = await settings('owner=1',{operation:'read',runId})
  assert.equal(settingsRead.status,200)
  const previous = await settingsRead.json() as {revision:string}
  assert.equal((await settings('other=1',{operation:'set',runId,target:'worker',expectedRevision:previous.revision,policy:{permissions:{install_dependency:'deny'}}})).status,409)
  const changed = await settings('owner=1',{operation:'set',runId,target:'worker',expectedRevision:previous.revision,policy:{permissions:{install_dependency:'allow'}}})
  assert.equal(changed.status,200)
  assert.equal((await settings('owner=1',{operation:'set',runId,target:'worker',expectedRevision:previous.revision,policy:{}})).status,409)
  support = false
  const oldDaemon = await fetch(`${origin}/v1/devices/${deviceId}/runs/${runId}/claim`, { method:'POST', headers:{ authorization:'Bearer synthetic' } })
  assert.equal(oldDaemon.status,409)
  support = true; selectIndex = 0
  const claim = await fetch(`${origin}/v1/devices/${deviceId}/runs/${runId}/claim`, { method:'POST', headers:{ authorization:'Bearer synthetic' } })
  assert.equal(claim.status,200)
  assert.equal((await pool.query('SELECT status FROM agent_runs WHERE id=$1',[runId])).rows[0].status,'preparing')
  const assignment = await claim.json() as import('@mikka/protocol/device').RunAssignment
  savedAssignment = assignment
  assert.equal(assignment.policy?.permissions.install_dependency, 'allow')
  assert.match(assignment.policyRevision ?? '', /^[a-f0-9]{64}$/)
  const gate = await link.prepareRunToolApproval(assignment, new AbortController().signal, () => {})
  const adapter = new CodexAdapter({ sandbox: new NoSandbox(), stateDir: dir, userHome: dir, binary: resolve('packages/daemon/test/fakes/fake-codex.mjs') })
  const session = await adapter.start({ runId, cwd: dir, prompt: assignment.prompt, env: { PATH: process.env.PATH ?? '' }, log: createLogger(), toolApproval: gate })
  const browser = async (cookie: string, payload: object) => fetch(`${origin}/api/agent-tool-approvals`, { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify(payload) })
  let output=''; for await (const event of session.events()) if (event.type === 'chunk' && event.chunk.type === 'text-delta') output+=event.chunk.delta
  const result=JSON.parse(output); assert.equal(result.first.decision,'decline'); assert.equal(result.replay.decision,'decline'); assert.equal(result.foreign.decision,'decline')
  const response = await browser('owner=1',{ operation:'list',runId })
  const body = await response.json() as { requests: unknown[] }
  assert.deepEqual(body.requests, [])
})

test('policy revocation invalidates an old assignment before CLI approval', async () => {
  const settings = await fetch(`${origin}/api/agent-cli-policy`, { method:'POST', headers:{cookie:'owner=1',origin,'content-type':'application/json'}, body:JSON.stringify({operation:'set',runId,target:'worker',expectedRevision:savedAssignment.policyRevision,policy:{permissions:{install_dependency:'deny'}}}) })
  assert.equal(settings.status,200)
  const { HttpServerLink } = await import('../../packages/daemon/src/server-link-http')
  const { CodexAdapter } = await import('../../packages/daemon/src/adapters/codex')
  const { NoSandbox } = await import('../../packages/daemon/src/agents/sandbox')
  const { createLogger } = await import('../../packages/daemon/src/log')
  const link=new HttpServerLink(origin); Object.assign(link,{credential:'synthetic'})
  const gate=await link.prepareRunToolApproval(savedAssignment,new AbortController().signal,()=>{})
  const adapter=new CodexAdapter({sandbox:new NoSandbox(),stateDir:dir,userHome:dir,binary:resolve('packages/daemon/test/fakes/fake-codex.mjs')})
  const session=await adapter.start({runId,cwd:dir,prompt:'APPROVAL_TEST',env:{PATH:process.env.PATH ?? ''},log:createLogger(),toolApproval:gate})
  let output=''; for await (const event of session.events()) if (event.type==='chunk' && event.chunk.type==='text-delta') output+=event.chunk.delta
  const result=JSON.parse(output)
  assert.equal(result.first.decision,'decline')
  const pending = await pool.query(`SELECT count(*)::int AS count FROM agent_tool_approvals WHERE "runId"=$1 AND status='pending'`,[runId])
  assert.equal(pending.rows[0].count,0)
})
