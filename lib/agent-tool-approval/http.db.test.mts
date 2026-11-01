import { after, before, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Pool } from 'pg'
import { DAEMON_PROTOCOL_VERSION } from '@mikka/protocol/daemon'
import { REPO_ORIGIN_HEADER } from '@mikka/protocol/device'
import { POLICY_SNAPSHOT_HEADER, POLICY_SNAPSHOT_VERSION } from '@mikka/protocol/policy-snapshot'
import { remoteKey } from '@mikka/protocol/repository'
import type { AgentEvent, AgentSession } from '../../packages/daemon/src/adapters/types'
import type { ToolApprovalGate } from '../../packages/daemon/src/agents/tool-approval'

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
let server: Server, origin: string, savedAssignment: import('@mikka/protocol/device').RunAssignment
const originalFetch = globalThis.fetch
const proposals: { requestId: string; method: string; input: unknown }[] = []
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
  // `ask` for this bot, which is what the approval roundtrip below exercises.
  await pool.query(`INSERT INTO agent_kit_heads (owner_id,bot_key,workspace_id,cli_run_policy) VALUES ($1,'coordinator',NULL,'{"permissions":{"install_dependency":"allow","network":"ask"}}'::jsonb)`, [owner])
  await pool.query(`INSERT INTO agent_runs (id,"userId","deviceId","issueId","deviceRepoId",status,"agentId",kind,prompt) VALUES ($1,$2,$3,$4,$5,'queued',$6,'implement','APPROVAL_TEST')`, [runId,owner,deviceId,issueId,repoId,agentId])
  const device = await import('../../app/v1/runs/[runId]/tool-approval/route')
  const policy = await import('../../app/v1/runs/[runId]/policy-snapshot/route')
  const claim = await import('../../app/v1/devices/[deviceId]/runs/[runId]/claim/route')
  const browser = await import('../../app/api/agent-tool-approvals/route')
  const settings = await import('../../app/api/agent-cli-policy/route')
  server = createServer(async (req,res) => {
    try {
      const chunks: Buffer[]=[]; for await (const part of req) chunks.push(Buffer.from(part))
      const pathname = new URL(req.url!, origin).pathname
      const request = new Request(`${origin}${req.url}`, { method: req.method, headers: req.headers as HeadersInit, ...(req.method==='GET' || req.method==='HEAD' ? {} : {body:Buffer.concat(chunks)}) })
      const runRoute = /^\/v1\/runs\/([^/]+)\/(tool-approval|policy-snapshot)$/.exec(pathname)
      const routeRunId = runRoute?.[1] ?? runId
      if (req.url?.endsWith('/tool-approval')) {
        const body = JSON.parse(Buffer.concat(chunks).toString())
        if (body.operation === 'propose') proposals.push(body)
      }
      const response = req.url === '/api/agent-tool-approvals' ? await browser.POST(request) : req.url === '/api/agent-cli-policy' ? await settings.POST(request) : req.url?.endsWith('/claim') ? await claim.POST(request, { params: Promise.resolve({ runId,deviceId }) }) : runRoute?.[2] === 'policy-snapshot' ? await (req.method==='GET' ? policy.GET : policy.POST)(request, {params:Promise.resolve({runId:routeRunId})}) : await device.POST(request, { params: Promise.resolve({ runId: routeRunId }) })
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
test('real HTTP claim carries policy and unavailable CLI callbacks do not create approvals', async () => {
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
  savedAssignment = assignment
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
  const browser = async (cookie: string, payload: object) => fetch(`${origin}/api/agent-tool-approvals`, { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify(payload) })
  const request = {runId,requestId:'synthetic',harness:'codex' as const,method:'item/commandExecution/requestApproval',input:{command:'npm install synthetic'}}
  assert.equal(await gate.request(request),'deny')
  assert.equal(await gate.request(request),'deny')
  assert.equal(await gate.request({...request,runId:randomUUID(),requestId:'foreign'}),'deny')
  const response = await browser('owner=1',{ operation:'list',runId })
  const body = await response.json() as { requests: unknown[] }
  assert.deepEqual(body.requests, [])
  gate.revoke()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
async function deadline<T>(work: Promise<T>, label: string, ms = 30_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms)
    })])
  } finally { clearTimeout(timer) }
}
async function until<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  const expires = Date.now() + 30_000
  while (Date.now() < expires) {
    const value = await read()
    if (value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`${label} timed out`)
}
type Pending = { id: string; runId: string; harness: string; method: string; input: unknown; digest: string }
const browserRequest = (cookie: string, payload: object) => fetch(`${origin}/api/agent-tool-approvals`, {
  method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify(payload),
})
const deviceRequest = (payload: object, requestedRun = runId, authenticated = true) => fetch(`${origin}/v1/runs/${requestedRun}/tool-approval`, {
  method: 'POST', headers: { ...(authenticated ? { authorization: 'Bearer synthetic' } : {}), 'content-type': 'application/json' }, body: JSON.stringify({ deviceId, ...payload }),
})
async function pendingNetwork(port: number) {
  const pending = await until(async () => {
    const response = await browserRequest('owner=1', { operation: 'list', runId })
    assert.equal(response.status, 200)
    const body = await response.json() as { requests: Pending[] }
    assert.ok(body.requests.length <= 1, 'only one network operation may be waiting')
    return body.requests[0]
  }, 'persisted HTTP network approval')
  assert.equal(pending.runId, runId)
  assert.equal(pending.harness, 'codex')
  assert.equal(pending.method, 'sandbox/network')
  assert.deepEqual(pending.input, { host: '127.0.0.1', port })
  const persisted = (await pool.query(`SELECT status,"userId","deviceId","policyRevision",method,input FROM agent_tool_approvals WHERE id=$1`, [pending.id])).rows[0]
  assert.deepEqual(persisted, { status: 'pending', userId: owner, deviceId, policyRevision: savedAssignment.policyRevision, method: 'sandbox/network', input: { host: '127.0.0.1', port } })
  return pending
}
async function approvalStatus(id: string, expected: string) {
  return until(async () => {
    const status = (await pool.query('SELECT status FROM agent_tool_approvals WHERE id=$1', [id])).rows[0]?.status
    return status === expected ? status : undefined
  }, `approval becomes ${expected}`)
}

test('authenticated claim → sandboxed fake Codex → pending network → owner decision → real HTTP, replay, cancellation and revocation', { timeout: 120_000 }, async () => {
  const { CodexAdapter } = await import('../../packages/daemon/src/adapters/codex')
  const { SandboxRuntime, shellJoin, shellQuote } = await import('../../packages/daemon/src/agents/sandbox')
  const { createLogger } = await import('../../packages/daemon/src/log')
  const { HttpServerLink } = await import('../../packages/daemon/src/server-link-http')
  assert.equal(savedAssignment.policy?.permissions.network, 'ask')
  // This selected integration target requires real official isolation. Missing
  // dependencies or a host that denies namespace setup are failures, not skips.
  assert.equal(SandboxRuntime.supported(), true, 'official sandbox runtime dependencies are required')
  const probe = new SandboxRuntime()
  try { await deadline(probe.probe(), 'real official sandbox probe') }
  finally { await probe.reset() }

  const dir = mkdtempSync(join(tmpdir(), 'mikka-http-network-approval-'))
  console.info(`Retained HTTP/sandbox network approval evidence: ${dir}`)
  const hits: string[] = [], outsideHits: string[] = [], events: AgentEvent[][] = []
  const network = createServer((request, response) => { hits.push(request.url ?? ''); response.end('synthetic-network-ok') })
  const outside = createServer((request, response) => { outsideHits.push(request.url ?? ''); response.end('outside-ceiling-must-not-be-reached') })
  const active: { gate: ToolApprovalGate; session?: AgentSession; finished?: Promise<void> }[] = []
  const evidence: Record<string, unknown> = { classification: 'fake Codex protocol; real official sandbox and HTTP network; no model/provider invocation', dir, runId }
  async function listen(http: Server) {
    await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve) })
    return (http.address() as { port: number }).port
  }
  try {
    const port = await listen(network), outsidePort = await listen(outside)
    const target = `http://127.0.0.1:${port}/approved`, outsideTarget = `http://127.0.0.1:${outsidePort}/blocked`
    const link = new HttpServerLink(origin); Object.assign(link, { credential: 'synthetic' })
    assert.equal((await deviceRequest({ operation: 'check', policyRevision: savedAssignment.policyRevision }, runId, false)).status, 401)
    const foreignRun = randomUUID()
    async function start(name: string, includeOutside = false) {
      const root = join(dir, name), cwd = join(root, 'repo'), home = join(root, 'empty-user-home')
      mkdirSync(cwd, { recursive: true }); mkdirSync(home, { recursive: true })
      execFileSync('git', ['init', '--quiet', cwd], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', NODE_ENV:'test' } })
      const binary = join(cwd, 'fake-codex-network.sh')
      const fixture = fileURLToPath(new URL('../../packages/daemon/test/fakes/fake-codex-network-approval.mjs', import.meta.url))
      writeFileSync(binary, `#!/bin/sh\nexec ${shellJoin([process.execPath, fixture])} "$@" 2>>${shellQuote(join(cwd, 'cli.stderr.log'))}\n`, { mode: 0o700 })
      const gate = await link.prepareRunToolApproval(savedAssignment, new AbortController().signal, () => {}, cwd)
      const owned: (typeof active)[number] = { gate }; active.push(owned)
      const adapter = new CodexAdapter({ sandbox: new SandboxRuntime(), stateDir: join(root, 'adapters'), userHome: home, binary, networkCeiling: [`127.0.0.1:${port}`] })
      owned.session = await deadline(adapter.start({
        runId, cwd, prompt: JSON.stringify({ target, ...(includeOutside ? { outside: outsideTarget } : {}) }),
        // A trusted repo capability admits just the fixture to the immutable
        // ceiling. Policy still comes unchanged from the authenticated claim.
        policy: savedAssignment.policy, policyHash:savedAssignment.policySnapshot?.payload.policyHash, networkAllow: [`127.0.0.1:${port}`], toolApproval: gate,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home }, log: createLogger(),
      }), `${name} adapter start`)
      const output = deferred<string>(), observed: AgentEvent[] = []; events.push(observed)
      owned.finished = (async () => {
        for await (const event of owned.session!.events()) {
          observed.push(event)
          if (event.type === 'chunk' && event.chunk.type === 'text-delta') output.resolve(event.chunk.delta)
        }
      })()
      return { ...owned, session: owned.session, finished: owned.finished, output: output.promise, observed }
    }

    const allowed = await start('approved', true)
    const pending = await pendingNetwork(port)
    const liveRequest = proposals.at(-1)!
    assert.equal(liveRequest.method, 'sandbox/network')
    assert.deepEqual(liveRequest.input, { host: '127.0.0.1', port })
    assert.deepEqual(hits, [])
    assert.deepEqual(outsideHits, [])
    const decide = { operation: 'decide', runId, id: pending.id, digest: pending.digest, decision: 'approve' }
    assert.equal((await browserRequest('other=1', decide)).status, 409)
    assert.equal((await pool.query('SELECT status FROM agent_tool_approvals WHERE id=$1', [pending.id])).rows[0].status, 'pending')
    assert.deepEqual(hits, [])
    assert.equal((await browserRequest('owner=1', decide)).status, 200)
    const output = JSON.parse(await deadline(allowed.output, 'fake CLI actual proxy results'))
    assert.deepEqual(output.allowed, { status: 200, body: 'synthetic-network-ok' })
    assert.equal(output.outside.status, 403)
    assert.equal(output.proxyConfigured, true)
    assert.equal(output.privateIpcInherited, false)
    assert.ok(Number.isInteger(output.pid))
    assert.deepEqual(hits, ['/approved'])
    assert.deepEqual(outsideHits, [])
    await approvalStatus(pending.id, 'consumed')
    assert.equal((await browserRequest('owner=1', decide)).status, 409)
    const replay = await deviceRequest({ operation: 'take', id: pending.id, digest: pending.digest })
    assert.equal(replay.status, 200)
    assert.deepEqual(await replay.json(), { decision: 'deny' })
    assert.equal((await deviceRequest({ operation: 'take', id: pending.id, digest: pending.digest }, foreignRun)).status, 409)
    const requestCount = proposals.length
    assert.equal(requestCount, 1, 'outside-ceiling traffic never reaches the approval callback')
    // Reuse the original host callback ID while the turn/gate is still live.
    const requestId = liveRequest.requestId.slice(liveRequest.requestId.indexOf('/') + 1)
    assert.equal(allowed.gate.revoked, false)
    const request = { runId, requestId, harness: 'codex' as const, method: 'sandbox/network', input: { host: '127.0.0.1', port } }
    assert.equal(await allowed.gate.request(request), 'deny')
    assert.equal(await allowed.gate.request({ ...request, runId: foreignRun, requestId: 'foreign-network' }), 'deny')
    assert.equal(proposals.length, requestCount)
    await allowed.session.send('COMPLETE')
    await deadline(allowed.finished, 'approved CLI completion')
    assert.deepEqual(allowed.observed.at(-1), { type: 'exit', outcome: 'succeeded' })
    evidence.approved = { pending, output, liveRequest }

    const cancelled = await start('cancelled')
    const cancelPending = await pendingNetwork(port)
    await deadline(cancelled.session.cancel(), 'cancel pending sandboxed CLI')
    await deadline(cancelled.finished, 'cancelled CLI exit')
    await approvalStatus(cancelPending.id, 'cancelled')
    assert.equal(cancelled.gate.revoked, true)
    assert.deepEqual(cancelled.observed.at(-1), { type: 'exit', outcome: 'cancelled' })
    assert.equal((await browserRequest('owner=1', { ...decide, id: cancelPending.id, digest: cancelPending.digest })).status, 409)
    const lateCancel = await deviceRequest({ operation: 'take', id: cancelPending.id, digest: cancelPending.digest })
    assert.equal(lateCancel.status, 200)
    assert.deepEqual(await lateCancel.json(), { decision: 'deny' })
    assert.deepEqual(hits, ['/approved'])

    const revoked = await start('policy-revoked')
    const revokePending = await pendingNetwork(port)
    const changed = await fetch(`${origin}/api/agent-cli-policy`, { method: 'POST', headers: { cookie: 'owner=1', origin, 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'set', runId, target: 'worker', expectedRevision: savedAssignment.policyRevision, policy: { permissions: { install_dependency: 'deny', network: 'deny' } } }) })
    assert.equal(changed.status, 200)
    assert.equal((await browserRequest('owner=1', { ...decide, id: revokePending.id, digest: revokePending.digest })).status, 409)
    const lateRevoked = await deviceRequest({ operation: 'take', id: revokePending.id, digest: revokePending.digest })
    assert.equal(lateRevoked.status, 409)
    await deadline(revoked.finished, 'policy revocation stops owned CLI')
    await approvalStatus(revokePending.id, 'cancelled')
    assert.equal(revoked.gate.revoked, true)
    assert.equal(revoked.observed.at(-1)?.type, 'exit')
    assert.deepEqual(hits, ['/approved'])
    assert.deepEqual(outsideHits, [])
    // A stale signed assignment is refused before another gate/CLI can start.
    await assert.rejects(link.prepareRunToolApproval(savedAssignment, new AbortController().signal, () => {}), /Run policy context changed/)
    const remaining = await pool.query(`SELECT count(*)::int AS count FROM agent_tool_approvals WHERE "runId"=$1 AND status='pending'`, [runId])
    assert.equal(remaining.rows[0].count, 0)
    evidence.cancelled = cancelPending
    evidence.revoked = revokePending
  } finally {
    for (const owned of active) owned.gate.revoke()
    const cleanup = await Promise.allSettled(active.map(owned => deadline(owned.session?.cancel() ?? Promise.resolve(), 'owned fixture teardown')))
    network.closeAllConnections(); outside.closeAllConnections()
    await Promise.all([network, outside].map(http => new Promise<void>(resolve => http.close(() => resolve()))))
    writeFileSync(join(dir, 'evidence.json'), JSON.stringify({ ...evidence, hits, outsideHits, proposals, events, cleanup: cleanup.map(result => result.status === 'fulfilled' ? 'fulfilled' : String(result.reason)) }, null, 2))
    assert.ok(cleanup.every(result => result.status === 'fulfilled'), 'all newly owned fixture processes must stop')
  }
})
