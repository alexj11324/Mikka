import { after, before, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { execFile } from 'node:child_process'
import { mkdtemp, copyFile, chmod, access, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { promisify } from 'node:util'
import { Pool, type PoolClient } from 'pg'
import { DAEMON_PROTOCOL_VERSION } from '@mikka/protocol/daemon'
import { REPO_ORIGIN_HEADER } from '@mikka/protocol/device'
import { POLICY_SNAPSHOT_HEADER, POLICY_SNAPSHOT_VERSION } from '@mikka/protocol/policy-snapshot'
import { remoteKey } from '@mikka/protocol/repository'
import { instrumentFixtureAuthority } from '../../tests/helpers/run-authority-version-fixture'

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
  AI_GATEWAY_API_KEY:'', VERCEL:'', VERCEL_ENV:'',
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
let claimed: import('@mikka/protocol/device').RunAssignment | undefined
let holdControlResponse: { runId: string; entered: () => void; released: Promise<void> } | undefined
const controlRequests = new Map<string, number>()
let authorityWorkspacePool: Pool | undefined
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
      const claimRoute = /^\/v1\/devices\/([^/]+)\/runs\/([^/]+)\/claim$/.exec(pathname)
      if (runRoute?.[2] === 'tool-approval') controlRequests.set(routeRunId, (controlRequests.get(routeRunId) ?? 0) + 1)
      const response = req.url === '/api/agent-cli-policy' ? await settings.POST(request) : claimRoute ? await claim.POST(request, { params: Promise.resolve({ runId:claimRoute[2],deviceId:claimRoute[1] }) }) : runRoute?.[2] === 'policy-snapshot' ? await (req.method==='GET' ? policy.GET : policy.POST)(request, {params:Promise.resolve({runId:routeRunId})}) : await device.POST(request, { params: Promise.resolve({ runId: routeRunId }) })
      // Only delivery is delayed. Device authentication, policy and lease reads
      // above are the real HTTP route and real committed PostgreSQL state.
      const held = runRoute?.[2] === 'tool-approval' && holdControlResponse?.runId === routeRunId ? holdControlResponse : undefined
      if (held) { held.entered(); await held.released }
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
  if(authorityWorkspacePool)await authorityWorkspacePool.end()
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
  const oldDaemon = await fetch(`${origin}/v1/devices/${deviceId}/runs/${runId}/claim`, { method:'POST', headers:{ 'x-mikka-client-version':'0.0.375', authorization:'Bearer synthetic',[REPO_ORIGIN_HEADER]:'1' } })
  assert.equal(oldDaemon.status,409)
  assert.deepEqual(await oldDaemon.json(),{error:'Run approval capability unavailable.'})
  assert.equal((await pool.query('SELECT status FROM agent_runs WHERE id=$1',[runId])).rows[0].status,'queued')
  assert.equal((await pool.query('SELECT count(*)::int n FROM run_tokens WHERE "runId"=$1',[runId])).rows[0].n,0)
  await pool.query('UPDATE devices SET harnesses=$2 WHERE id=$1',[deviceId,harnesses(true)])
  const claim = await fetch(`${origin}/v1/devices/${deviceId}/runs/${runId}/claim`, { method:'POST', headers:{ 'x-mikka-client-version':'0.0.375', authorization:'Bearer synthetic',[REPO_ORIGIN_HEADER]:'1',[POLICY_SNAPSHOT_HEADER]:POLICY_SNAPSHOT_VERSION } })
  const claimBody = await claim.json()
  assert.equal(claim.status,200,`the real authenticated claim must pass its scope and lease fences: ${claim.status === 200 ? 'accepted' : JSON.stringify(claimBody)}`)
  assert.equal((await pool.query('SELECT status FROM agent_runs WHERE id=$1',[runId])).rows[0].status,'preparing')
  const assignment = claimBody as import('@mikka/protocol/device').RunAssignment
  assert.equal(assignment.prompt,'APPROVAL_TEST')
  assert.equal(assignment.expectedRepoRemote,remoteUrl)
  assert.equal(assignment.pushBranch,'mikka/appr-1')
  assert.equal((await pool.query('SELECT "scopeVersion","pushApproved" FROM run_publications WHERE "runId"=$1',[runId])).rows[0].pushApproved,true,'kept for old readers: pushing needs no approval')
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
  claimed = assignment
})

test('a changed run policy answers live:false, revokes the real daemon gate, and each check logs one line', async () => {
  assert.ok(claimed, 'the claim test above runs first')
  const { HttpServerLink } = await import('../../packages/daemon/src/server-link-http')
  const link = new HttpServerLink(origin)
  Object.assign(link, { credential: 'synthetic' })
  const lines: Record<string, unknown>[] = []
  const restore = (['log','warn','error'] as const).map(level => {
    const original = console[level]
    console[level] = (...args: unknown[]) => {
      if (typeof args[0] === 'string' && args[0].includes('"tool_approval_check"')) lines.push(JSON.parse(args[0]))
      else original(...args)
    }
    return () => { console[level] = original }
  })
  const gate = await link.prepareRunToolApproval(claimed, new AbortController().signal, () => {})
  try {
    assert.equal(await gate.checkLive(), true)
    assert.deepEqual(Object.keys(lines.at(-1)!).sort(), ['durationMs','level','live','msg','reason','runId','status','timestamp'])
    assert.deepEqual({ ...lines.at(-1), timestamp: 0, durationMs: 0 }, { level:'info', msg:'tool_approval_check', timestamp:0, runId, live:true, reason:'ok', status:200, durationMs:0 })
    const settings = async (payload: object) => fetch(`${origin}/api/agent-cli-policy`, { method:'POST', headers:{cookie:'owner=1',origin,'content-type':'application/json'}, body:JSON.stringify(payload) })
    const current = await (await settings({operation:'read',runId})).json() as {revision:string}
    assert.equal(current.revision, claimed.policyRevision, 'nothing changed the run policy since its claim')
    assert.equal((await settings({operation:'set',runId,target:'worker',expectedRevision:current.revision,policy:{permissions:{install_dependency:'deny'}}})).status,200)
    // The gate's own 1 s monitor sees the new revision and revokes the run.
    const deadline = Date.now() + 10_000
    while (!gate.revoked && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(gate.revoked, true)
    assert.equal(await gate.checkLive(), false)
    const stale = lines.find(line => line.live === false)
    assert.deepEqual({ ...stale, timestamp: 0, durationMs: 0 }, { level:'info', msg:'tool_approval_check', timestamp:0, runId, live:false, reason:'policy_revision_mismatch', status:200, durationMs:0 })
    // Another device's check for this run: the run row is not its own.
    const foreign = await fetch(`${origin}/v1/runs/${runId}/tool-approval`, { method:'POST', headers:{'x-mikka-client-version':'0.0.375',authorization:'Bearer synthetic','content-type':'application/json'}, body:JSON.stringify({operation:'check',deviceId:randomUUID(),policyRevision:claimed.policyRevision}) })
    assert.equal(foreign.status, 409)
    assert.deepEqual({ ...lines.at(-1), timestamp: 0, durationMs: 0 }, { level:'warn', msg:'tool_approval_check', timestamp:0, runId, live:false, reason:'run_unavailable', status:409, durationMs:0 })
    const invalid = await fetch(`${origin}/v1/runs/${runId}/tool-approval`, { method:'POST', headers:{'x-mikka-client-version':'0.0.375',authorization:'Bearer synthetic','content-type':'application/json'}, body:'{}' })
    assert.equal(invalid.status, 400)
    assert.equal(lines.at(-1)?.reason, 'invalid_request')
    // The log carries no revision, policy or credential.
    const logged = JSON.stringify(lines)
    for (const secret of [claimed.policyRevision!, current.revision, 'synthetic', 'install_dependency']) assert.equal(logged.includes(secret), false)
  } finally { gate.revoke(); for (const undo of restore) undo() }
})

test('real authenticated HTTP retains a lease-loss cause but never invents it for manual Stop', async () => {
  assert.ok(claimed)
  const {readCliRunPolicy} = await import('./policy-store')
  const revision = (await readCliRunPolicy(pool,runId,owner)).revision
  const check = (extra: object = {}) => fetch(`${origin}/v1/runs/${runId}/tool-approval`, {
    method:'POST', headers:{'x-mikka-client-version':'0.0.375',authorization:'Bearer synthetic','content-type':'application/json'},
    body:JSON.stringify({operation:'check',deviceId,policyRevision:revision,...extra}),
  })
  await pool.query(`UPDATE agent_runs SET "leaseExpiresAt"=now()-interval '1 second' WHERE id=$1`, [runId])
  const expired = await check()
  assert.equal(expired.status,200)
  assert.deepEqual(await expired.json(),{live:false,revokeReason:'device_lost'})
  await pool.query(`UPDATE agent_runs SET "stopRequestedAt"=now(),"leaseExpiresAt"=now()+interval '5 minutes' WHERE id=$1`, [runId])
  const stopped = await check()
  assert.equal(stopped.status,409)
  assert.deepEqual(await stopped.json(),{error:'approvalUnavailable'})
  assert.equal((await check({revokeReason:'device_lost'})).status,400,'the caller cannot supply a host cause')
})

async function assertIdleChildDeadline(fault:'http_delivery'|'postgres_barrier') {
  const idleRun = randomUUID(), idleAgent = randomUUID()
  await pool.query(`UPDATE devices SET harnesses=$2 WHERE id=$1`, [deviceId, JSON.stringify([
    {harness:'codex',installed:true,toolApproval:true},
    {harness:'claude_code',installed:true,toolApproval:true},
  ])])
  await pool.query(`INSERT INTO agents (id,"userId","deviceId",harness,name) VALUES ($1,$2,$3,'claude_code',$4)`, [idleAgent,owner,deviceId,`Synthetic silent CLI ${fault}`])
  await pool.query(`INSERT INTO agent_runs (id,"userId","deviceId","issueId","deviceRepoId",status,"agentId",kind,prompt) VALUES ($1,$2,$3,$4,$5,'queued',$6,'implement','SILENT_AUTHORITY_TEST')`, [idleRun,owner,deviceId,issueId,repoId,idleAgent])
  const response = await fetch(`${origin}/v1/devices/${deviceId}/runs/${idleRun}/claim`, {method:'POST',headers:{'x-mikka-client-version':'0.0.375',authorization:'Bearer synthetic',[REPO_ORIGIN_HEADER]:'1',[POLICY_SNAPSHOT_HEADER]:POLICY_SNAPSHOT_VERSION}})
  const body = await response.json()
  assert.equal(response.status,200,`real isolated claim: ${response.status === 200 ? 'accepted' : JSON.stringify(body)}`)
  const assignment = body as import('@mikka/protocol/device').RunAssignment
  const { HttpServerLink } = await import('../../packages/daemon/src/server-link-http')
  const { ClaudeAdapter } = await import('../../packages/daemon/src/adapters/claude')
  const { createLogger } = await import('../../packages/daemon/src/log')
  const { stopOwnedRun } = await import('../run-control')
  const { db } = await import('../db/index')
  const { completeRunAuthoritySource } = await import('../run-authority/source')
  if(!authorityWorkspacePool) {
    const workspaceName=`authority_ws_${randomUUID().replaceAll('-','')}_e2e`
    const admin=new Pool({connectionString:url,max:1})
    try {await admin.query(`CREATE DATABASE "${workspaceName}"`)} finally {await admin.end()}
    const workspaceURL=new URL(application);workspaceURL.pathname=`/${workspaceName}`
    await promisify(execFile)(process.execPath,['scripts/migrate.mjs'],{env:{...process.env,MIGRATE:'1',DATABASE_URL:workspaceURL.toString()},maxBuffer:4<<20,timeout:120_000})
    authorityWorkspacePool=new Pool({connectionString:workspaceURL.toString(),max:4})
    await instrumentFixtureAuthority(pool)
    await instrumentFixtureAuthority(authorityWorkspacePool)
  }
  let challenges=0
  const versionQueries={app:0,workspace:0}
  const counted=(database:Pool,key:'app'|'workspace')=>({query:((...args:unknown[])=>{versionQueries[key]++;return Reflect.apply(database.query,database,args)}) as Pool['query']})
  const completeSource=completeRunAuthoritySource({runId:idleRun,app:counted(pool,'app'),workspace:counted(authorityWorkspacePool,'workspace'),read:async signal=>{
    const checked=await fetch(`${origin}/v1/runs/${idleRun}/tool-approval`,{method:'POST',signal,headers:{'x-mikka-client-version':'0.0.375',authorization:'Bearer synthetic','content-type':'application/json'},body:JSON.stringify({operation:'check',deviceId,policyRevision:assignment.policyRevision})})
    if(!checked.ok)return {live:false,validForMs:0}
    const current=await checked.json() as {live:boolean;paused?:boolean}
    // This first source fixture opts in only an active local run. Paused-run
    // restoration and production source placement remain separate work.
    const {rows:[timed]}=await pool.query<{remainingMs:number}>(`SELECT EXTRACT(EPOCH FROM (LEAST(r."leaseExpiresAt",COALESCE(t."expiresAt",'infinity'::timestamptz))-clock_timestamp()))*1000 AS "remainingMs"
      FROM agent_runs r JOIN device_tokens t ON t."userId"=r."userId" AND t."tokenHash"=$2 WHERE r.id=$1`,[idleRun,createHash('sha256').update('synthetic').digest('hex')])
    const remaining=Math.min(Number(timed?.remainingMs),assignment.policySnapshot!.payload.expiresAt-Date.now())
    return {live:current.live&&!current.paused,validForMs:remaining}
  }})
  const link = new HttpServerLink(origin)
  Object.assign(link,{credential:'synthetic'})
  const gate = await link.prepareRunToolApproval(assignment,new AbortController().signal,()=>{},undefined,(challenge,signal)=>{challenges++;return completeSource(challenge,signal)})
  const dir = await mkdtemp(join(tmpdir(),'mikka-idle-authority-'))
  const marker = join(dir,'child-exit')
  const binary = join(dir,'fake-claude.mjs')
  await copyFile(resolve('packages/daemon/test/fakes/fake-claude.mjs'),binary)
  await copyFile(resolve('packages/daemon/test/fakes/mcp-call.mjs'),join(dir,'mcp-call.mjs'))
  await chmod(binary,0o700)
  await promisify(execFile)('git',['init','-q','-b','main',dir])
  await promisify(execFile)('git',['-C',dir,'-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','-q','--allow-empty','-m','Isolated fixture'])
  const exists = (path:string) => access(path).then(()=>true,()=>false)
  const until = async (condition:()=>boolean|Promise<boolean>, timeout:number) => {
    const deadline=performance.now()+timeout
    while (!await condition() && performance.now()<deadline) await new Promise(resolve=>setTimeout(resolve,5))
    return condition()
  }
  let release!:()=>void, entered!:()=>void
  const released=new Promise<void>(r=>{release=r}), held=new Promise<void>(r=>{entered=r})
  let exitedAt:number|undefined, revokedAt:number|undefined
  const events:unknown[]=[]
  const adapter=new ClaudeAdapter({stateDir:dir,binary})
  let session:Awaited<ReturnType<typeof adapter.start>>|undefined
  let consumed:Promise<void>|undefined
  let blocker:PoolClient|undefined
  let postgresBarrierBlocked=false
  gate.onRevoke(()=>{revokedAt=performance.now()})
  try {
    session=await adapter.start({runId:idleRun,cwd:dir,prompt:`HANG SIGTERM_EXIT_143:${marker}`,policy:assignment.policy,env:{PATH:process.env.PATH??''},log:createLogger(),toolApproval:gate})
    consumed=(async()=>{for await(const event of session!.events()){events.push(event);if(event.type==='exit')exitedAt=performance.now()}})()
    assert.equal(await until(()=>exists(`${marker}.ready`),5000),true,'the actual child must be running before fault injection')
    if(fault==='http_delivery') {
      holdControlResponse={runId:idleRun,entered,released}
      await Promise.race([held,new Promise<never>((_,reject)=>setTimeout(()=>reject(Error('No actual background authority request')),2500))])
    }
    const eventsBeforeStop=events.length
    assert.equal(exitedAt,undefined,'the actual child must still be running before Stop is submitted')
    const committedAt=performance.now()
    assert.equal(await stopOwnedRun(db,owner,idleRun),false,'an admitted run requests daemon cancellation instead of ending synchronously')
    const commitReturnedAt=performance.now()
    if(fault==='postgres_barrier') {
      // The Stop and its version have committed. Block the actual subsequent
      // source SELECT at PostgreSQL, without replacing its result or clock.
      blocker=await pool.connect()
      await blocker.query('BEGIN')
      await blocker.query('LOCK TABLE run_authority_version IN ACCESS EXCLUSIVE MODE')
      postgresBarrierBlocked=await until(async()=>Number((await pool.query(`SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT source::text,%'`)).rows[0].n)>0,600)
      assert.equal(postgresBarrierBlocked,true,'the source barrier must actually be waiting inside PostgreSQL')
    }
    const observed=await pool.query(`SELECT "stopRequestedAt" IS NOT NULL AS stopped FROM agent_runs WHERE id=$1`,[idleRun])
    assert.equal(observed.rows[0].stopped,true,'a separate pool query sees the committed stop')
    await until(()=>exitedAt!==undefined,Math.max(0,1000-(performance.now()-commitReturnedAt)))
    const observedAt=performance.now()
    const deadlineMet=exitedAt!==undefined && exitedAt-commitReturnedAt<=1000
    const eventsAfterStop=events.slice(eventsBeforeStop).map(event=>(event as {type:string}).type)
    console.info(JSON.stringify({event:'authority_idle_child_deadline',sourceSha:'a410b292cc53cfef43992a91d7696023e3481567',fault,runId:idleRun,committedStop:true,commitDurationMs:commitReturnedAt-committedAt,observationAfterCommitMs:observedAt-commitReturnedAt,revokedAfterCommitMs:revokedAt===undefined?null:revokedAt-commitReturnedAt,childExitAfterCommitMs:exitedAt===undefined?null:exitedAt-commitReturnedAt,childSignalMarker:await exists(marker)?(await readFile(marker,'utf8')).trim():null,authorityHttpRequests:controlRequests.get(idleRun)??0,challenges,versionQueries,postgresBarrierBlocked,eventsAfterStop,deadlineMs:1000,deadlineMet}))
    assert.equal(deadlineMet,true,'a silent actual CLI must stop by the local one-second authority deadline even when the origin response stalls')
    assert.ok(exitedAt!==undefined && exitedAt-committedAt<=1000,'the measured exit also satisfies the conservative bound from before the Stop transaction')
    assert.equal(gate.revoked,true,'the authority deadline must revoke the actual gate')
    assert.equal((await readFile(marker,'utf8')).trim(),'143','the actual child must have handled SIGTERM and exited')
    assert.deepEqual(eventsAfterStop,['exit'])
  } finally {
    if(blocker){await blocker.query('ROLLBACK');blocker.release()}
    holdControlResponse=undefined
    gate.revoke();release()
    if(session)await session.cancel()
    await consumed
    await rm(dir,{recursive:true,force:true})
  }
}

test('idle CLI stops within one second after committed Stop with stalled HTTP delivery', {timeout:60_000},()=>assertIdleChildDeadline('http_delivery'))
test('idle CLI stops within one second after committed Stop with an actual blocked PostgreSQL barrier', {timeout:60_000},()=>assertIdleChildDeadline('postgres_barrier'))

