import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { createRequire, registerHooks } from 'node:module'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { Pool } from 'pg'
import { apiAliases } from '../apps/api/compat-aliases.mjs'
import { orderMigrations } from '../scripts/migration-order.mjs'
import { bootstrapEnvironment } from '../scripts/test-accounts/bootstrap.mjs'
import { TestAccountPool } from '../scripts/test-accounts/pool.mjs'
import { disposableDatabase, E2E_DB_RULE } from './helpers/e2e-target.mjs'
import { createTestDatabase, dropTestDatabase } from './support/drop-test-database.ts'

const adminUrl = process.env.E2E_DATABASE_URL
if (adminUrl) assert.ok(disposableDatabase(process.env, adminUrl), E2E_DB_RULE)
else if (process.env.REQUIRE_DB === '1') assert.fail(E2E_DB_RULE)

// Run the same writers as the person in the application. Only the previous
// completed transcript and the isolated agent executable are fixtures.
test('a paired daemon runs the owner’s retried Task and its active directory follows the stable thread until stop', {skip: !adminUrl, timeout: 180_000}, async t => {
  const admin = new Pool({connectionString: adminUrl, max: 1})
  const name = 'device_directory_' + randomUUID().replaceAll('-', '') + '_e2e'
  const ownership = await createTestDatabase(admin, name, 'template0')
  const url = new URL(adminUrl)
  url.pathname = '/' + name
  const pool = new Pool({connectionString: url.href})
  const root = await mkdtemp(join(tmpdir(), 'mikka-device-directory-'))
  const local = join(root, 'origin'), home = join(root, 'home')
  const remote = 'https://github.com/mikka-fixtures/device-directory.git'
  const old = {...process.env}
  let server, runtime, daemon, applicationPool, workspacePool, accounts, lease
  const loader = registerHooks({resolve(specifier, context, next) {
    const alias = specifier !== '@' && apiAliases[specifier]
    return next(alias ? pathToFileURL(alias).href : specifier, context)
  }})
  try {
    for (const key of ['E2E_DATABASE_URL','DATABASE_URL','MIKKA_DATABASE_URL','ORVILO_DATABASE_URL']) process.env[key] = url.href
    Object.assign(process.env, {NODE_ENV:'test', MIKKA_EDITION:'community', MIKKA_BASE_PATH:'/mikka', MIKKA_TEST_MODE:'1',
      BETTER_AUTH_SECRET:randomBytes(32).toString('hex'), MIKKA_LOCAL_TEST_ACCOUNTS:'1', HOME:home,
      GIT_CONFIG_GLOBAL:join(home,'.gitconfig'), GIT_CONFIG_NOSYSTEM:'1', GIT_ALLOW_PROTOCOL:'file'})
    await mkdir(local); await mkdir(home)
    const git = (...args) => execFileSync('git', args, {cwd:local, stdio:'pipe'}).toString().trim()
    git('init','--initial-branch=main')
    await writeFile(join(local,'README.md'),'Local, read-only directory test\n')
    git('add','README.md'); git('-c','user.name=Fixture','-c','user.email=test@example.invalid','commit','-m','Local fixture')
    const base = git('rev-parse','HEAD')
    git('config','--global','url.'+pathToFileURL(local).href+'.insteadOf',remote)
    const migrations = new URL('../drizzle/',import.meta.url)
    for (const file of orderMigrations((await readdir(migrations)).filter(file=>file.endsWith('.sql')))) {
      await pool.query(await readFile(new URL(file,migrations),'utf8'))
    }
    const {serve} = await import('srvx/node')
    let application
    // The production node-server build mounts the built-in gateway on these
    // paths (apps/api/builtin-services-module.mjs); the API handler alone has none.
    let gateway
    const gatewayPath = /^\/mikka\/v1\/(?:live\/|devices\/[^/]+\/(?:socket|push|status)$)/
    const route = request => gatewayPath.test(new URL(request.url).pathname) ? gateway.fetch(request) : application.fetch(request)
    runtime = serve({manual:true,silent:true,gracefulShutdown:false,fetch:route})
    server = createServer(runtime.node.handler)
    // The daemon works only while it holds its device session socket
    // (decision 2026-11-17-2215), so upgrades reach the built-in gateway
    // through the same Nitro WebSocket adapter production uses.
    const nitroRequire = createRequire(createRequire(import.meta.url).resolve('nitro/package.json'))
    const {default: websocketAdapter} = await import(pathToFileURL(nitroRequire.resolve('crossws/adapters/node')).href)
    const {NodeRequest} = await import(pathToFileURL(nitroRequire.resolve('srvx/node')).href)
    const websocket = websocketAdapter({resolve: async request => {
      const response = await route(request)
      return response.crossws ?? request[Symbol.for('crossws.hooks')] ?? {}
    }})
    server.on('upgrade', (request, socket, head) => {
      websocket.handleUpgrade(request, socket, head, new NodeRequest({req: request, upgrade: {socket, head}}))
    })
    await new Promise((done,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',done)})
    const origin = 'http://127.0.0.1:'+server.address().port
    process.env.BETTER_AUTH_URL = origin
    process.env.AUTH_TRUSTED_ORIGINS = origin
    const revision = execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()
    process.env.MIKKA_TEST_DEPLOYMENT_SHA = revision
    application = (await import('../apps/api/src/index.ts')).default
    const {H3} = await import('h3')
    const {createGatewayHandler} = await import('../apps/api/routes/builtin-gateway.ts')
    gateway = new H3().all('/**', createGatewayHandler())
    applicationPool = (await import('../lib/db/index.ts')).pool
    workspacePool = (await import('../lib/workspace-db.ts')).workspacePool
    const environment = await bootstrapEnvironment({connectionString:url.href,origin,deploymentSha:revision,
      id:'device-directory-'+randomUUID(), outputFile:join(root,'environment.json'), authorizeDatabase:async db=>{
        // The runner reaches a Docker service over loopback; PostgreSQL can see
        // its container interface. Compare the immutable marker from our CREATE.
        const {rows:[target]} = await db.query(`select datname as name, shobj_description(oid,'pg_database') as ownership,
          current_setting('server_version_num')::int as version from pg_database where datname=current_database()`)
        assert.equal(target.name,name); assert.equal(target.ownership,ownership); assert.equal(Math.floor(target.version/10000),17)
      }})
    accounts = new TestAccountPool(pool, environment)
    await accounts.prepare({pairs:1})
    lease = await accounts.acquire({runId:'directory-'+randomUUID(),workerId:'daemon',requestId:randomUUID(),ttlMs:120_000})
    const {seedPersonalWorkspace} = await import('./support/workspace-admin-db.ts')
    async function signIn(slot) {
      const email = 'test-'+randomUUID()+'@example.test', credentialRef = randomUUID()+'.json'
      await accounts.reserveAccount(lease,{slotId:slot.slotId,email,credentialRef})
      const response = await fetch(origin+'/mikka/api/auth/sign-up/email',{method:'POST',headers:{origin,'content-type':'application/json'},
        body:JSON.stringify({email,password:randomBytes(24).toString('hex'),name:'Test '+slot.role})})
      assert.equal(response.status,200,'normal password signup')
      const {user} = await response.json()
      const cookie = response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ')
      assert.ok(cookie)
      await accounts.bindAccount(lease,{slotId:slot.slotId,email,credentialRef,userId:user.id})
      const workspace = await seedPersonalWorkspace(pool,user.id)
      await accounts.sealAccount(lease,slot.slotId)
      const request = (path, method='GET', body) => fetch(origin+'/mikka/api/'+path,{method,headers:{cookie,origin,
        'x-mikka-workspace-id':workspace,'content-type':'application/json','x-mikka-rpc':'1','sec-fetch-site':'same-origin'},
        ...(body===undefined?{}:{body:JSON.stringify(body)})})
      const authenticated = await request('auth/get-session?disableCookieCache=true')
      assert.equal((await authenticated.json()).user.id,user.id)
      return {id:user.id,workspace,request}
    }
    const owner = await signIn(lease.accounts.find(slot=>slot.role==='owner'))
    const peer = await signIn(lease.accounts.find(slot=>slot.role==='peer'))
    assert.notEqual(owner.id,peer.id)
    async function rpc(action, args) {
      const res = await owner.request('rpc','POST',{version:1,action,args})
      assert.equal(res.status,200,action)
      const body = await res.json()
      assert.ok(body.ok && !body.result?.error,action+': '+(body.result?.error||body.error?.code||''))
      return body.result
    }
    const {registrationLogin} = await import('../packages/daemon/src/login.ts')
    const {HttpServerLink} = await import('../packages/daemon/src/server-link-http.ts')
    const {startDaemon} = await import('../packages/daemon/src/main.ts')
    const {NoSandbox} = await import('../packages/daemon/src/agents/sandbox.ts')
    const grant = await owner.request('devices/enrollment','POST')
    assert.equal(grant.status,200)
    const credential = await registrationLogin({serverUrl:origin+'/mikka',token:(await grant.json()).token})
    const dataDir = join(root,'daemon')
    daemon = await startDaemon({dataDir,flavor:'dev',link:new HttpServerLink(origin+'/mikka'),credential,
      harnesses:[{harness:'codex',installed:true,toolApproval:true,version:'fixture'}],
      harnessBinaries:{codex:resolve('packages/daemon/test/fakes/fake-codex.mjs')}, agentSandbox:new NoSandbox(),
      modelProbe:false, quotaSource:null, retainResources:true})
    await daemon.syncWithServer()
    const {deviceId,server:state} = daemon.status()
    assert.equal(state,'online')
    // Work reaches the daemon only over its open gateway session, which the
    // gateway reports to the application (decision 2026-11-17-2215).
    const sessionDeadline = Date.now()+20_000
    let session
    while (Date.now()<sessionDeadline) {
      session = (await pool.query('select "sessionOpenedAt" is not null and ("sessionClosedAt" is null or "sessionClosedAt"<"sessionOpenedAt") as open from devices where id=$1',[deviceId])).rows[0]
      if (daemon.status().session==='open' && session?.open) break
      await delay(100)
    }
    assert.equal(daemon.status().session,'open','the daemon holds its gateway session')
    assert.equal(session?.open,true,'the gateway reported the session to the application')
    const deviceDirectory = 'devices/'+deviceId+'/active-threads'
    async function directory() {
      const response = await owner.request(deviceDirectory)
      assert.equal(response.status,200)
      return response.json()
    }
    assert.deepEqual(await directory(),{threads:[],cursor:null})
    t.diagnostic('Paired daemon online. Owner and peer have separate leased password sessions.')
    const {taskId} = await rpc('issues.createTaskOnly',[{version:1,intent:'create_only',requestId:randomUUID(),
      workspaceId:owner.workspace,title:'Paired device Task',content:{type:'doc',content:[]},status:'todo',priority:'normal'}])
    const {rows:[agent]} = await pool.query('select id from agents where "userId"=$1 and "deviceId"=$2 and harness=\'codex\'',[owner.id,deviceId])
    const {ensureDeviceRepository} = await import('../lib/device-repositories.ts')
    const repo = await ensureDeviceRepository(owner.id,deviceId,remote)
    const original = randomUUID(), anchor = randomUUID()
    await pool.query(`insert into agent_runs(id,"userId","workspaceId","issueId","agentId","deviceId","deviceRepoId",title,"titleSource",status,"startedAt","finishedAt","lastReply",prompt,"agentDefinition")
      values($1,$2,$3,$4,$5,$6,$7,'Recorded history','manual','succeeded',now()-interval '5 min',now()-interval '1 min','Earlier answer','Read local fixture',$8)`,
      [original,owner.id,owner.workspace,taskId,agent.id,deviceId,repo.id,{harness:'codex',model:'selfhost-ci',modelSource:'native-default',readOnly:true}])
    await pool.query(`insert into run_messages(id,"runId","userId",text,origin,"deliveredAt","createdAt") values($1,$2,$3,'WAIT','owner',now()-interval '4 min',now()-interval '4 min')`,[randomUUID(),original,owner.id])
    await pool.query(`insert into run_chunks(id,"runId",seq,chunk,"createdAt") values($1,$2,1,$3,now()-interval '3 min')`,[randomUUID(),original,{type:'text-delta',id:anchor,delta:'Earlier answer'}])
    const {runId} = await rpc('agents.createThreadReplyVersion',[{issueId:taskId,runId:original,
      change:{operation:'rerun',anchorRunId:original,anchorKey:anchor,requestId:randomUUID()}}])
    assert.ok(runId && runId!==original)
    async function waitForStatus(status) {
      const end = Date.now()+45_000
      let latest, lastPhase, sawRunning = false
      while (Date.now()<end) {
        latest = (await pool.query(`select status,"stopReason", "worktreePath" is not null as checkout,
          exists(select 1 from run_chunks c where c."runId"=r.id and c.chunk->>'type'='text-delta') as replied
          from agent_runs r where r.id=$1`,[runId])).rows[0]
        const phase = latest?.status+' checkout='+latest?.checkout+' reply='+latest?.replied
        if (phase!==lastPhase) { t.diagnostic('Daemon Run '+phase); lastPhase=phase }
        if (latest?.status==='running') sawRunning = true
        if (sawRunning) assert.notEqual(latest?.status,'preparing','a running Task must not return to preparation')
        // The checkout and first persisted output tie the directory read to the opened turn.
        if (latest?.status===status && (status!=='running' || (latest.checkout && latest.replied))) return
        assert.ok(!['failed','succeeded','stopped','cancelled'].includes(latest?.status),
          'unexpected terminal status '+latest?.status+', reason '+latest?.stopReason)
        await delay(100)
      }
      assert.fail('expected '+status+', last persisted status '+latest?.status)
    }
    await waitForStatus('running')
    assert.deepEqual(await directory(),{threads:[{id:original,status:'running'}],cursor:null})
    assert.equal((await peer.request(deviceDirectory)).status,404)
    const {rows:[active]} = await pool.query(`select r."worktreePath" as checkout from agent_runs r join device_tokens t on t.id=r."deviceTokenId"
      where r.id=$1 and r."userId"=$2 and r."workspaceId"=$3 and r."issueId"=$4 and r."continuesRunId"=$5 and r."deviceId"=$6
      and t."userId"=r."userId" and r."startedAt" is not null`,[runId,owner.id,owner.workspace,taskId,original,deviceId])
    assert.equal(active?.checkout,join(dataDir,'worktrees',runId))
    assert.equal(execFileSync('git',['-C',active.checkout,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),base)
    t.diagnostic('The signed directory returned the stable root as running. Device token, Task, new Run and local Git HEAD matched. Peer received 404.')
    assert.ok((await rpc('agents.stopRun',[runId])).stoppedRunIds.includes(runId))
    await waitForStatus('cancelled')
    assert.deepEqual(await directory(),{threads:[],cursor:null})
    const tokens = (await (await owner.request('device-tokens')).json()).tokens
    assert.equal(tokens.length,1)
    const revoked = await owner.request('device-tokens/'+tokens[0].id+'/revoke','POST')
    assert.equal((await revoked.json()).revokedBy,owner.id)
    assert.equal((await rpc('agents.removeDevice',[deviceId])).id,deviceId)
    t.diagnostic('Owner stop was acknowledged by the daemon. The task left the directory and its device credential was revoked.')
  } finally {
    try {
      await daemon?.stop()
      if (lease) assert.equal((await accounts.release(lease,{outcome:'dirty'})).state,'quarantined')
    } finally {
      server?.closeAllConnections()
      if (server?.listening) await new Promise(done=>server.close(done))
      try { await runtime?.close() } finally {
        loader.deregister()
        for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key]
        Object.assign(process.env,old)
        await dropTestDatabase(admin,name,pool,applicationPool,workspacePool)
        await admin.end()
        await rm(root,{recursive:true,force:true})
      }
    }
  }
})
