import { after, before, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Pool } from 'pg'
import { DAEMON_PROTOCOL_VERSION } from '@mikka/protocol/daemon'
import { REPO_ORIGIN_HEADER } from '@mikka/protocol/device'
import { POLICY_SNAPSHOT_HEADER, POLICY_SNAPSHOT_VERSION } from '@mikka/protocol/policy-snapshot'
import { remoteKey } from '@mikka/protocol/repository'

const url = process.env.APPROVAL_TEST_DATABASE_URL
if (!url) throw new Error('isolated database required')
const target = new URL(url)
if (!['localhost','127.0.0.1','[::1]'].includes(target.hostname) || !/^\/approval_e2e(?:_[a-f0-9]{24})?$/.test(target.pathname)) throw new Error('Refusing non-isolated database')
let pool: Pool
const runId = randomUUID(), deviceId = randomUUID(), agentId = randomUUID()
const owner = `synthetic-${randomUUID()}`, issueId = randomUUID(), repoId = randomUUID()
const remoteUrl = `https://github.com/mikka-ci/approval-${repoId}.git`
const harnesses = (toolApproval: boolean) => JSON.stringify([{harness:'codex',installed:true,toolApproval}])
const database = `approval_http_${randomUUID().replaceAll('-','')}`
const application = new URL(url); application.pathname = `/${database}`
const isolatedEnv = {
  MIKKA_DATABASE_URL:application.toString(), DATABASE_URL:application.toString(),
  // This is an ordinary local run with no Factory, Skill or BYOS assignment.
  MIKKA_FACTORY_ROUTING_ENABLED:'0', MIKKA_FACTORY_LIFECYCLE_ENABLED:'0', MIKKA_BYOS_ENABLED:'0',
  MIKKA_NATIVE_COORDINATOR:'0', AI_GATEWAY_API_KEY:'', VERCEL:'', VERCEL_ENV:'',
}
const previousEnv = Object.fromEntries(Object.keys(isolatedEnv).map(key=>[key,process.env[key]]))
Object.assign(process.env,isolatedEnv)
// Use real Drizzle, repository preparation, device authentication, MCP tokens,
// Skill's unassigned path and the final scope/lease response fence. Only the
// browser session identity and unrelated mailbox capability are substituted.
mock.module(new URL('../mcp/resource.ts', import.meta.url).href, { namedExports: { mcpResourceURL: null } })
mock.module(new URL('../personal-mailbox-config.ts', import.meta.url).href, { namedExports: { personalMailboxEnabled: () => false } })
mock.module(new URL('../auth.ts', import.meta.url).href, { namedExports: { auth: { api: { getSession: async ({ headers }: { headers: Headers }) => ({ user: { id: headers.get('cookie') === 'owner=1' ? owner : 'other' } }) } } } })
let server: Server, origin: string
const originalFetch = globalThis.fetch
before(async () => {
  // The preceding policy-store suite retains its deliberately minimal schema.
  // Keep it intact and migrate a separate disposable database for this complete
  // HTTP claim composition. No pre-existing database or table is changed.
  const admin = new Pool({connectionString:url,max:1})
  try {await admin.query(`CREATE DATABASE "${database}"`)} finally {await admin.end()}
  console.info(`Retained fully migrated approval HTTP database: ${database}`)
  const migrated = await promisify(execFile)(process.execPath,['scripts/migrate.mjs'],{
    env:{...process.env,MIGRATE:'1'},maxBuffer:4<<20,timeout:120_000,
  })
  assert.match(migrated.stdout,/migrate: applied/)
  pool = (await import('../db/index')).pool
  globalThis.fetch=(async(input,init)=>{
    const address=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url)
    assert.equal(address.hostname,'127.0.0.1','this fixture cannot contact a real model or provider')
    return originalFetch(input,init)
  }) as typeof fetch
  await pool.query('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,\'Synthetic approval owner\',$2,true,now(),now())',[owner,`${owner}@example.invalid`])
  await pool.query('INSERT INTO issue_prefixes ("userId",prefix) VALUES ($1,\'APPR\')',[owner])
  await pool.query('INSERT INTO devices (id,"ownerId",name,kind,"protocolVersion",harnesses) VALUES ($1,$2,\'Synthetic approval device\',\'local\',$3,$4)',[deviceId,owner,DAEMON_PROTOCOL_VERSION,harnesses(true)])
  await pool.query('INSERT INTO device_tokens (id,"userId","tokenHash") VALUES ($1,$2,$3)',[randomUUID(),owner,createHash('sha256').update('synthetic').digest('hex')])
  await pool.query(`INSERT INTO agents (id,"userId","deviceId",harness,name) VALUES ($1,$2,$3,'codex','Synthetic approval worker')`, [agentId,owner,deviceId])
  await pool.query('INSERT INTO device_repos (id,"deviceId","userId","repoPath","remoteUrl","baseBranch") VALUES ($1,$2,$3,$4,$5,\'main\')',[repoId,deviceId,owner,remoteKey(remoteUrl),remoteUrl])
  await pool.query('INSERT INTO issues (id,"userId",title,content,status,priority,scope) VALUES ($1,$2,\'Synthetic approval task\',$3,\'todo\',\'normal\',\'personal\')',[issueId,owner,JSON.stringify({type:'doc',attrs:{mikka:{number:1}},content:[]})])
  // Network is open by default (decision 2026-11-01-1230). The owner chose
  // `ask` for this bot; the run gate below still asks nothing per tool.
  await pool.query(`INSERT INTO agent_kit_heads (owner_id,bot_key,workspace_id,cli_run_policy) VALUES ($1,'coordinator',NULL,'{"permissions":{"install_dependency":"allow","network":"ask"}}'::jsonb)`, [owner])
  await pool.query(`INSERT INTO agent_runs (id,"userId","deviceId","issueId","deviceRepoId",status,"agentId",kind,prompt) VALUES ($1,$2,$3,$4,$5,'queued',$6,'implement','APPROVAL_TEST')`, [runId,owner,deviceId,issueId,repoId,agentId])
  const device = await import('../../app/v1/runs/[runId]/tool-approval/route')
  const policy = await import('../../app/v1/runs/[runId]/policy-snapshot/route')
  const claim = await import('../../app/v1/devices/[deviceId]/runs/[runId]/claim/route')
  const settings = await import('../../app/api/agent-cli-policy/route')
  server = createServer(async (req,res) => {
    try {
      const chunks: Buffer[]=[]; for await (const part of req) chunks.push(Buffer.from(part))
      const pathname = new URL(req.url!, origin).pathname
      const request = new Request(`${origin}${req.url}`, { method: req.method, headers: req.headers as HeadersInit, ...(req.method==='GET' || req.method==='HEAD' ? {} : {body:Buffer.concat(chunks)}) })
      const runRoute = /^\/v1\/runs\/([^/]+)\/(tool-approval|policy-snapshot)$/.exec(pathname)
      const routeRunId = runRoute?.[1] ?? runId
      const response = req.url === '/api/agent-cli-policy' ? await settings.POST(request) : req.url?.endsWith('/claim') ? await claim.POST(request, { params: Promise.resolve({ runId,deviceId }) }) : runRoute?.[2] === 'policy-snapshot' ? await (req.method==='GET' ? policy.GET : policy.POST)(request, {params:Promise.resolve({runId:routeRunId})}) : await device.POST(request, { params: Promise.resolve({ runId: routeRunId }) })
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()))
    } catch(error) {
      // HTTP failures may include a Drizzle query or response object. Keep the
      // diagnostic useful without writing bearer credentials or MCP tokens.
      console.error('Approval HTTP fixture handler failed',{path:req.url,name:error instanceof Error?error.name:'Unknown',message:error instanceof Error?error.message.replace(/mkw_[A-Za-z0-9_-]+/g,'[run-token]'):undefined})
      res.writeHead(500).end()
    }
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
after(async () => {
  if (server) {server.closeAllConnections();await new Promise<void>(r => server.close(() => r()))}
  globalThis.fetch=originalFetch
  if(pool)await pool.end()
  const workspacePool=(globalThis as {workspacePool?:Pool}).workspacePool
  if(workspacePool)await workspacePool.end()
  for(const [key,value] of Object.entries(previousEnv)){if(value===undefined)delete process.env[key];else process.env[key]=value}
})
// Historical, still UNIMPLEMENTED coverage from def8b396: a native raw-command
// callback for `npm install` creates pending, other user gets 409, owner gets
// 200, and fake Codex receives accept / replay decline / foreign-run decline.
// Native command text does not attest an install action. The real sandbox
// network roundtrip below tests a different, trusted host boundary and must
// not be presented as equivalent implementation of those original assertions.
test('real HTTP claim carries policy, and its run gate creates no approvals (decision 2026-11-01-2335)', async () => {
  const { HttpServerLink } = await import('../../packages/daemon/src/server-link-http')
  const link = new HttpServerLink(origin)
  Object.assign(link, { credential: 'synthetic' })
  const settings = async (cookie: string, payload: object) => fetch(`${origin}/api/agent-cli-policy`, { method:'POST', headers:{cookie,origin,'content-type':'application/json'}, body:JSON.stringify(payload) })
  const unstartedAgent = randomUUID()
  await pool.query(`INSERT INTO agents (id,"userId",harness,name) VALUES ($1,$2,'codex','Synthetic unstarted worker')`, [unstartedAgent,owner])
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
  await pool.query('UPDATE devices SET harnesses=$2 WHERE id=$1',[deviceId,harnesses(false)])
  const oldDaemon = await fetch(`${origin}/v1/devices/${deviceId}/runs/${runId}/claim`, { method:'POST', headers:{ authorization:'Bearer synthetic',[REPO_ORIGIN_HEADER]:'1' } })
  assert.equal(oldDaemon.status,409)
  assert.deepEqual(await oldDaemon.json(),{error:'Run approval capability unavailable.'})
  assert.equal((await pool.query('SELECT status FROM agent_runs WHERE id=$1',[runId])).rows[0].status,'queued')
  assert.equal((await pool.query('SELECT count(*)::int n FROM run_tokens WHERE "runId"=$1',[runId])).rows[0].n,0)
  await pool.query('UPDATE devices SET harnesses=$2 WHERE id=$1',[deviceId,harnesses(true)])
  const claim = await fetch(`${origin}/v1/devices/${deviceId}/runs/${runId}/claim`, { method:'POST', headers:{ authorization:'Bearer synthetic',[REPO_ORIGIN_HEADER]:'1',[POLICY_SNAPSHOT_HEADER]:POLICY_SNAPSHOT_VERSION } })
  assert.equal(claim.status,200,'the real authenticated claim must pass its scope and lease fences')
  assert.equal((await pool.query('SELECT status FROM agent_runs WHERE id=$1',[runId])).rows[0].status,'preparing')
  const assignment = await claim.json() as import('@mikka/protocol/device').RunAssignment
  assert.equal(assignment.prompt,'APPROVAL_TEST')
  assert.equal(assignment.expectedRepoRemote,remoteUrl)
  assert.equal(assignment.pushBranch,'mikka/appr-1')
  assert.equal((await pool.query('SELECT "scopeVersion","pushApproved" FROM run_publications WHERE "runId"=$1',[runId])).rows[0].pushApproved,false)
  const {verifyRunToken}=await import('../mcp/worker')
  assert.ok(await verifyRunToken(new Request(origin),assignment.mcp?.token),'claim issues a real run-scoped token after its lease commits')
  assert.equal(assignment.policy?.permissions.install_dependency, 'allow')
  assert.match(assignment.policyRevision ?? '', /^[a-f0-9]{64}$/)
  assert.equal(assignment.policySnapshot?.algorithm,'Ed25519')
  assert.deepEqual(assignment.policySnapshot?.payload.policy,assignment.policy)
  const gate = await link.prepareRunToolApproval(assignment, new AbortController().signal, () => {})
  // Runs ask nothing per tool or destination; the gate only reports whether the run is live.
  assert.equal(await gate.checkLive(), true)
  assert.equal((await pool.query('SELECT count(*)::int n FROM agent_tool_approvals WHERE "runId"=$1',[runId])).rows[0].n,0)
  gate.revoke()
})


