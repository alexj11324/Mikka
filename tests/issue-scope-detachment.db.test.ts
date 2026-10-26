import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

// Only the dedicated cloud-Linux test DB or Actions' ephemeral service. Never
// fall back to business credentials. Fixtures are intentionally retained.
const url = process.env.E2E_DATABASE_URL
if (url) {
  const target = new URL(url)
  const ci = process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true' && target.port === '5432' && target.pathname === '/mikka_e2e'
  const cloud = process.env.ISSUE184_LOCAL_TEST === '1' && target.port === '55484' && target.pathname === '/issue184_e2e'
  if (target.hostname !== '127.0.0.1' || (!ci && !cloud) || target.search || target.hash) throw new Error('Scope tests require the isolated issue184_e2e or Actions ephemeral service')
  if (process.env.MIKKA_DATABASE_URL !== url || process.env.DATABASE_URL !== url) throw new Error('Scope tests must use the same isolated application/workspace target')
}
if (!url && process.env.REQUIRE_DB === '1') throw new Error('Scope DB tests cannot skip in required CI')

test('workspace to personal local safety on real PostgreSQL and native HTTP claim route', { skip: !url }, async t => {
  const { Pool } = await import('pg')
  // CI's shared E2E setup creates columns, not the production triggers/FKs.
  // Bootstrap a fresh retained database from the real tracked migrations instead
  // of relying on the state left by earlier suites or changing their fixtures.
  const database = `scope184_${randomUUID().replaceAll('-', '')}_e2e`
  const admin = new Pool({ connectionString: url, max: 1 })
  try { await admin.query(`create database "${database}"`) } finally { await admin.end() }
  const target = new URL(url!)
  target.pathname = `/${database}`
  const connection = target.toString()
  const originalApplication = process.env.MIKKA_DATABASE_URL!
  const originalWorkspace = process.env.DATABASE_URL!
  process.env.MIKKA_DATABASE_URL = connection
  process.env.DATABASE_URL = connection
  t.after(() => { process.env.MIKKA_DATABASE_URL = originalApplication; process.env.DATABASE_URL = originalWorkspace })
  const migrated = await promisify(execFile)(process.execPath, ['scripts/migrate.mjs'], {
    env: { ...process.env, MIGRATE: '1', VERCEL_ENV: '' }, maxBuffer: 4 << 20,
  })
  assert.match(migrated.stdout, /applied 20261026025303_personal_scope_detachment.sql/)
  const pool = new Pool({ connectionString: connection, max: 5 })
  const { changeIssueScopeLocally } = await import('../lib/issue-scope-store')
  const { actAs } = await import('../lib/acting-user')
  const { setIssueScope } = await import('../app/actions/issues')
  const { issueForUser } = await import('../lib/issue-access')
  const { readRun, queueRun, visibleRuns } = await import('../lib/agent-runs')
  const { issueRunToken, verifyRunToken } = await import('../lib/mcp/worker')
  const { renewRunLeases } = await import('../lib/run-leases')
  const { createAppIssueFromLinear, applyLinearIssueToApp, syncAppIssueToLinear } = await import('../lib/linear-sync/issue-sync')
  const { processLinearIssueOutbox, processLinearInboxDelivery } = await import('../lib/linear-sync/worker')
  const { hashDeviceToken } = await import('../lib/device-link')
  const claim = await import('../app/v1/devices/[deviceId]/runs/[runId]/claim/route')
  const { db } = await import('../lib/db')
  const { linearTeamSyncs, linearIssueLinks } = await import('../lib/db/schema')
  const { eq } = await import('drizzle-orm')
  const owner = `scope-owner-${randomUUID()}`, member = `scope-member-${randomUUID()}`
  const workspace = randomUUID(), team = randomUUID(), sync = randomUUID(), device = randomUUID(), agent = randomUUID(), repo = randomUUID()
  const ownerDevice=randomUUID(),ownerAgent=randomUUID(),ownerRepo=randomUUID()
  const issue = randomUUID(), memberRun = randomUUID(), ownerRun = randomUUID()
  const fixtureIds: string[] = [issue]
  const noExternalFetch = globalThis.fetch
  let rejectedExternalRequests = 0
  globalThis.fetch = (async (input, init) => {
    const target = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (target.hostname !== '127.0.0.1') { rejectedExternalRequests++; throw new Error('External network prohibited in scope acceptance') }
    return noExternalFetch(input, init)
  }) as typeof fetch
  t.after(async () => { globalThis.fetch = noExternalFetch; await pool.end() })
  const doc = JSON.stringify({ type: 'doc', attrs: { mikka: { number: 12 } }, content: [] })
  for (const id of [owner, member]) await pool.query('insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values ($1,$2,$3,true,now(),now())', [id,'Alex',`${id}@example.invalid`])
  await pool.query('insert into issue_prefixes ("userId",prefix) values ($1,\'ALEX\')', [owner])
  await pool.query('insert into mikka_workspaces (id,"userId",name) values ($1,$2,\'scope synthetic acceptance\')', [workspace,owner])
  for (const id of [owner,member]) await pool.query('insert into mikka_workspace_members ("workspaceId","userId",name,email,role,status) values ($1,$2,\'Synthetic\',$3,\'member\',\'active\')', [workspace,id,`${id}@example.invalid`])
  await pool.query('insert into mikka_teams (id,"workspaceId","userId",name,identifier) values ($1,$2,$3,\'Scope\',\'MIK\')', [team,workspace,owner])
  await pool.query('insert into linear_team_syncs (id,"ownerId","linearTeamId","linearTeamKey","linearTeamName") values ($1,$2,$3,\'MIK\',\'Synthetic\')', [sync,owner,team])
  await pool.query('insert into devices (id,"ownerId",name) values ($1,$2,\'Synthetic\')', [device,member])
  await pool.query('insert into agents (id,"userId",harness,name,"deviceId") values ($1,$2,\'codex\',\'Synthetic\',$3)', [agent,member,device])
  await pool.query('insert into device_repos (id,"deviceId","userId","repoPath","baseBranch") values ($1,$2,$3,\'/synthetic/issue184\',\'main\')', [repo,device,member])
  await pool.query('insert into devices (id,"ownerId",name) values ($1,$2,\'Synthetic owner\')', [ownerDevice,owner])
  await pool.query('insert into agents (id,"userId",harness,name,"deviceId") values ($1,$2,\'codex\',\'Synthetic owner\',$3)', [ownerAgent,owner,ownerDevice])
  await pool.query('insert into device_repos (id,"deviceId","userId","repoPath") values ($1,$2,$3,\'/synthetic/owner\')', [ownerRepo,ownerDevice,owner])
  const deviceToken = `synthetic-${randomUUID()}`
  await pool.query('insert into device_tokens (id,"userId","tokenHash") values ($1,$2,$3)', [randomUUID(),member,hashDeviceToken(deviceToken)])
  async function seed(id: string, remote = id) {
    if (!fixtureIds.includes(id)) fixtureIds.push(id)
    await pool.query('insert into issues (id,"userId",title,content,status,priority,scope) values ($1,$2,\'Synthetic scope task\',$3,\'todo\',\'normal\',\'workspace\')', [id,owner,doc])
    await pool.query('insert into mikka_team_issues ("issueId","teamId","workspaceId","userId") values ($1,$2,$3,$4)', [id,team,workspace,owner])
    await pool.query('insert into linear_issue_links (id,"issueId","ownerId","teamSyncId","linearIssueId","linearIdentifier") values ($1,$2,$3,$4,$5,\'MIK-184\')', [randomUUID(),id,owner,sync,remote])
  }
  const localFlip = (id: string, revision = 1) => changeIssueScopeLocally(owner, { id,revision,scope:'personal' }, { allowLinkedPersonal: true })
  await seed(issue)
  const [originalLink] = await db.select().from(linearIssueLinks).where(eq(linearIssueLinks.issueId, issue))
  for (const [id,user] of [[memberRun,member],[ownerRun,owner]]) await pool.query('insert into agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId",status,"leaseExpiresAt") values ($1,$2,$3,$4,$5,$6,\'queued\',now()+interval \'1 minute\')', [id,user,issue,user===owner?ownerAgent:agent,user===owner?ownerDevice:device,user===owner?ownerRepo:repo])
  await pool.query('update agent_runs set status=\'running\' where id=$1',[ownerRun])
  const memberToken = (await issueRunToken({id:memberRun,userId:member})).token
  const ownerToken = (await issueRunToken({id:ownerRun,userId:owner})).token
  const [teamSync] = await db.select().from(linearTeamSyncs).where(eq(linearTeamSyncs.id,sync))
  const remote = (id: string) => ({ id, identifier:'MIK-184', title:'Stale external title', description:'Old workspace description', dueDate:null, priority:0, url:'https://example.invalid/synthetic',updatedAt:new Date(Date.now()+60000).toISOString(),state:null,team:{id:team,key:'MIK',name:'Synthetic'},assignee:null,labels:[] })

  async function withClaimServer(check: (origin: string)=>Promise<void>) {
    const server = createServer(async (incoming,outgoing) => {
      const request = new Request(`http://127.0.0.1${incoming.url}`,{method:'POST',headers:{authorization:incoming.headers.authorization??''}})
      try {
        const response = await claim.POST(request,{params:Promise.resolve({deviceId:device,runId:memberRun})})
        outgoing.writeHead(response.status,Object.fromEntries(response.headers));outgoing.end(await response.text())
      } catch { outgoing.writeHead(500);outgoing.end('Handler failed') }
    })
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
    try { await check(`http://127.0.0.1:${(server.address() as {port:number}).port}`) }
    finally { await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())) }
  }
  await t.test('pending disposition gate, owner check and stale revisions leave no partial state', async () => {
    assert.ok(await issueForUser(member,issue))
    assert.ok(await readRun(member,memberRun))
    assert.ok(await verifyRunToken(new Request('http://127.0.0.1/'),memberToken))
    assert.deepEqual(await actAs(owner,()=>setIssueScope({id:issue,revision:1,scope:'personal'})),{error:'issueScopeInLinear'})
    assert.deepEqual(await changeIssueScopeLocally(owner,{id:issue,revision:1,scope:'personal'},{allowLinkedPersonal:false}),{error:'issueScopeInLinear'})
    assert.deepEqual(await changeIssueScopeLocally(member,{id:issue,revision:1,scope:'personal'},{allowLinkedPersonal:true}),{error:'issueScopeOwnerOnly'})
    assert.deepEqual(await localFlip(issue,99),{error:'issueStale'})
    assert.equal((await pool.query('select count(*)::int n from linear_issue_detachments where "issueId"=$1',[issue])).rows[0].n,0)
  })
  await t.test('the same native claim route succeeds while workspace access is still active', async () => {
    await withClaimServer(async origin=>{
      const response=await fetch(`${origin}/claim`,{method:'POST',headers:{authorization:`Bearer ${deviceToken}`}})
      assert.equal(response.status,200)
      const claimed=await response.json()
      assert.equal(claimed.runId,memberRun)
      assert.ok(await verifyRunToken(new Request(`${origin}/`),claimed.mcp.token))
    })
  })
  await t.test('concurrent clicks commit one revision, one tombstone, and cancel old outbox work', async () => {
    const results = await Promise.all([localFlip(issue),localFlip(issue)])
    assert.equal(results.filter(result=>'issue' in result).length,1)
    assert.equal(results.filter(result=>'error' in result && result.error==='issueStale').length,1)
    const saved = results.find(result=>'issue' in result)!
    assert.ok(saved.issue)
    assert.equal(saved.issue.identifier,'ALEX-12')
    const row = (await pool.query('select scope,"scopeSetBy","scopeConfidence",revision from issues where id=$1',[issue])).rows[0]
    assert.deepEqual(row,{scope:'personal',scopeSetBy:'user',scopeConfidence:null,revision:2})
    assert.equal((await pool.query('select count(*)::int n from issue_versions where "issueId"=$1',[issue])).rows[0].n,1)
    assert.equal((await pool.query('select count(*)::int n from linear_issue_detachments where "issueId"=$1',[issue])).rows[0].n,1)
    assert.equal((await pool.query('select count(*)::int n from linear_issue_links where "issueId"=$1',[issue])).rows[0].n,0)
    assert.equal((await pool.query('select count(*)::int n from linear_sync_outbox where "issueId"=$1 and status<>\'done\'',[issue])).rows[0].n,0)
  })
  await t.test('scope commit removes teammate task and own-run access and revokes execution immediately', async () => {
    assert.equal(await issueForUser(member,issue),null)
    assert.equal(await readRun(member,memberRun),null)
    assert.deepEqual(await visibleRuns(member,{issueId:issue}),[])
    assert.ok(await issueForUser(owner,issue))
    assert.ok(await readRun(owner,ownerRun))
    assert.equal(Boolean(await verifyRunToken(new Request('http://127.0.0.1/'),memberToken)),false)
    assert.ok(await verifyRunToken(new Request('http://127.0.0.1/'),ownerToken))
    const renewal = await renewRunLeases(device,[memberRun])
    assert.deepEqual(renewal.revoked,[memberRun])
    assert.ok((await renewRunLeases(ownerDevice,[ownerRun])).leases[ownerRun])
    const row = (await pool.query('select status,"leaseExpiresAt","stopRequestedAt" from agent_runs where id=$1',[memberRun])).rows[0]
    assert.equal(row.status,'cancelled'); assert.equal(row.leaseExpiresAt,null); assert.ok(row.stopRequestedAt)
    await assert.rejects(queueRun(member,{issueId:issue,agentId:agent,deviceRepoId:repo}),/issueNotFound/)
    await assert.rejects(issueRunToken({id:memberRun,userId:member}))
    await assert.rejects(pool.query('insert into run_chunks (id,"runId",seq,chunk) values ($1,$2,1,$3)',[randomUUID(),memberRun,JSON.stringify({type:'text-delta',delta:'late'})]),(error:unknown)=>(error as {code:string}).code==='23514')
    await assert.rejects(pool.query('update agent_runs set status=\'running\' where id=$1',[memberRun]),(error: unknown)=>(error as {code:string}).code==='23514')
  })
  await t.test('native claim route rejects the revoked run over real loopback HTTP', async () => {
    await withClaimServer(async origin=>{
      assert.equal((await fetch(`${origin}/claim`,{method:'POST'})).status,401)
      const response=await fetch(`${origin}/claim`,{method:'POST',headers:{authorization:`Bearer ${deviceToken}`}})
      assert.equal(response.status,409)
      assert.equal((await response.text()).includes('prompt'),false)
    })
  })
  await t.test('replayed imports, forced snapshots and outbox retries cannot resurrect personal scope', async () => {
    for (let index=0;index<2;index++) assert.equal(await createAppIssueFromLinear(teamSync,remote(issue)),null)
    assert.equal(await applyLinearIssueToApp(teamSync,remote(issue),true),null)
    await pool.query('insert into linear_sync_outbox (id,"issueId") values ($1,$2)',[randomUUID(),issue])
    await processLinearIssueOutbox(issue)
    await syncAppIssueToLinear(issue)
    assert.equal((await pool.query('select scope,title from issues where id=$1',[issue])).rows[0].scope,'personal')
    assert.equal((await pool.query('select count(*)::int n from linear_sync_outbox where "issueId"=$1 and status<>\'done\'',[issue])).rows[0].n,0)
    await assert.rejects(pool.query('insert into linear_issue_links (id,"issueId","ownerId","teamSyncId","linearIssueId","linearIdentifier") values ($1,$2,$3,$4,$5,\'MIK-184\')',[randomUUID(),issue,owner,sync,issue]),(error:unknown)=>(error as {code:string}).code==='23514')
  })
  await t.test('delayed issue and comment deliveries finish without fetching the external provider', async () => {
    for (const type of ['Issue','Comment']) {
      const deliveryId=`scope-${randomUUID()}`
      const data=type==='Issue'?{id:issue,teamId:team}:{id:randomUUID(),issueId:issue,issue:{id:issue,teamId:team}}
      const payload={type,action:'update',organizationId:'synthetic',data}
      await pool.query('insert into linear_sync_inbox ("deliveryId","organizationId","eventType",payload) values ($1,\'synthetic\',$2,$3)',[deliveryId,type,JSON.stringify(payload)])
      await processLinearInboxDelivery(deliveryId)
      await processLinearInboxDelivery(deliveryId)
      assert.equal((await pool.query('select status,attempts from linear_sync_inbox where "deliveryId"=$1',[deliveryId])).rows[0].status,'done')
    }
    const { applyLinearCommentToApp }=await import('../lib/linear-sync/comment-sync')
    const [oldIssue]=(await pool.query('select * from issues where id=$1',[issue])).rows
    await applyLinearCommentToApp({issue:oldIssue,issueLink:originalLink,id:randomUUID(),body:'late external comment',author:'Synthetic',parentId:null,createdAt:new Date().toISOString(),action:'update'})
    assert.equal((await pool.query('select count(*)::int n from issue_documents where "issueId"=$1',[issue])).rows[0].n,0)
  })
  await t.test('a detached remote UUID different from the local UUID cannot create a second workspace task', async () => {
    const id = randomUUID(),remoteId=randomUUID()
    await seed(id,remoteId);await localFlip(id)
    assert.equal(await createAppIssueFromLinear(teamSync,remote(remoteId)),null)
    assert.equal((await pool.query('select count(*)::int n from issues where id=$1',[remoteId])).rows[0].n,0)
  })
  await t.test('version write failure rolls back scope, tombstone, link, outbox and run cancellation', async () => {
    const id=randomUUID();await seed(id)
    const constraint=`scope_rollback_${id.replaceAll('-','')}`
    // Additive, fixture-specific failure injection; no existing row is changed.
    await pool.query(`alter table issue_versions add constraint ${constraint} check ("issueId" <> '${id}'::uuid)`)
    await assert.rejects(localFlip(id))
    assert.equal((await pool.query('select scope from issues where id=$1',[id])).rows[0].scope,'workspace')
    assert.equal((await pool.query('select count(*)::int n from linear_issue_links where "issueId"=$1',[id])).rows[0].n,1)
    assert.equal((await pool.query('select count(*)::int n from linear_issue_detachments where "issueId"=$1',[id])).rows[0].n,0)
    assert.equal((await pool.query('select status from linear_sync_outbox where "issueId"=$1',[id])).rows[0].status,'queued')
  })
  await t.test('queue racing a locked scope conversion fails after the conversion commits', async () => {
    const id=randomUUID();await seed(id)
    const lock=await pool.connect()
    try {
      await lock.query('begin');await lock.query('select id from issues where id=$1 for update',[id])
      const raced=pool.query('insert into agent_runs (id,"userId","issueId","agentId",status) values ($1,$2,$3,$4,\'queued\')',[randomUUID(),member,id,agent]).then(()=>({error:null}),error=>({error}))
      // A separate connection is actually waiting for our row lock, not a timer.
      for (let n=0;n<100;n++) {
        await lock.query('select pg_stat_clear_snapshot()')
        const waiting=await lock.query("select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like 'insert into agent_runs%'")
        if (waiting.rows[0].n) break
        if(n===99) assert.fail('queue did not reach the scope lock')
      }
      await lock.query('update issues set scope=\'personal\' where id=$1',[id]);await lock.query('commit');assert.equal((await raced).error?.code,'23514')
    } finally { await lock.query('rollback');lock.release() }
  })
  await t.test('a real run-row/scope deadlock is safely retried without a duplicate transition', async () => {
    const id=randomUUID(),run=randomUUID();await seed(id)
    await pool.query('insert into agent_runs (id,"userId","issueId","agentId",status) values ($1,$2,$3,$4,\'running\')',[run,member,id,agent])
    const writer=await pool.connect()
    let transition: ReturnType<typeof localFlip> | undefined
    try {
      await writer.query('begin');await writer.query("set local deadlock_timeout = '50ms'")
      await writer.query('select id from agent_runs where id=$1 for update',[run])
      const writerPid=(await writer.query('select pg_backend_pid() pid')).rows[0].pid
      transition=localFlip(id)
      for(let n=0;n<200;n++) {
        const waiting=await pool.query("select exists(select 1 from pg_stat_activity a where a.wait_event_type='Lock' and $1=any(pg_blocking_pids(a.pid))) waiting",[writerPid])
        if(waiting.rows[0].waiting) break
        if(n===199) assert.fail('scope transition did not reach the held run row')
      }
      try {
        await writer.query('update agent_runs set "updatedAt"=now() where id=$1',[run])
        await writer.query('commit')
      } catch(error) {
        assert.equal((error as {code:string}).code,'40P01');await writer.query('rollback')
      }
      const result=await transition
      assert.ok(result.issue)
      assert.equal(result.issue.revision,2)
      assert.equal((await pool.query('select status from agent_runs where id=$1',[run])).rows[0].status,'cancelled')
      assert.equal((await pool.query('select count(*)::int n from issue_versions where "issueId"=$1',[id])).rows[0].n,1)
    } finally { await writer.query('rollback');writer.release();if(transition) await Promise.allSettled([transition]) }
  })
  assert.equal(rejectedExternalRequests,0,'no real provider request is permitted or required')
  await pool.query(await readFile(new URL('../drizzle/20261026025303_personal_scope_detachment.sql', import.meta.url), 'utf8'))
  assert.equal((await pool.query('select scope from issues where id=$1',[issue])).rows[0].scope,'personal')
  assert.equal((await pool.query('select count(*)::int n from linear_issue_detachments where "issueId"=$1',[issue])).rows[0].n,1)
  t.diagnostic(`Synthetic fixtures retained: ${JSON.stringify({database,owner,member,workspace,team,fixtureIds,memberRun,ownerRun})}`)
})
