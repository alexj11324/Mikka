import { scopeSubtest } from './support/scope-acceptance.mjs'
import 'next/dist/server/node-environment-baseline'
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
  const database = process.env.ISSUE184_LOCAL_TEST === '1'
    ? 'scope184_f14235c6695547ae925d808ab35a399e_e2e'
    : `scope184_${randomUUID().replaceAll('-', '')}_e2e`
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
  assert.match(migrated.stdout, /applied 20261027183117_personal_scope_detachment.sql/)
  const pool = new Pool({ connectionString: connection, max: 5 })
  const { changeIssueScopeLocally } = await import('../lib/issue-scope-store')
  const { promoteExistingIssueForUser } = await import('../lib/team-issue-promotion')
  const { actAs } = await import('../lib/acting-user')
  const { saveIssue, setIssueScope, previewIssuePersonalScope, confirmIssuePersonalScope } = await import('../app/actions/issues')
  const { retryLinearIssue } = await import('../app/actions/linear-sync')
  const { AfterContext } = await import('next/dist/server/after/after-context')
  const { workAsyncStorage } = await import('next/dist/server/app-render/work-async-storage.external')
  // Run the public actions and their actual Next after callbacks in request order.
  async function action<T>(fn: () => Promise<T>, beforeClose?: () => Promise<void>) {
    const waits: Promise<unknown>[] = [], errors: unknown[] = []
    let close = () => {}
    const afterContext = new AfterContext({ waitUntil: promise => { waits.push(promise) }, onClose: callback => { close = callback }, onTaskError: error => { errors.push(error) } })
    return workAsyncStorage.run({ afterContext } as NonNullable<ReturnType<typeof workAsyncStorage.getStore>>, async () => {
      try { const result = await actAs(owner, fn); await beforeClose?.(); return result }
      finally { close(); await Promise.all(waits); assert.deepEqual(errors, []) }
    })
  }
  const { issueForUser } = await import('../lib/issue-access')
  const { readRun, queueRun, visibleRuns } = await import('../lib/agent-runs')
  const { issueRunToken, verifyRunToken } = await import('../lib/mcp/worker')
  const { renewRunLeases } = await import('../lib/run-leases')
  const { completeRunForDevice, dispatchCompletedIssue } = await import('../lib/run-completion')
  const { authorizedClaimResponse } = await import('../lib/run-claim-response')
  const { createAppIssueFromLinear, applyLinearIssueToApp, syncAppIssueToLinear } = await import('../lib/linear-sync/issue-sync')
  const { processLinearIssueOutbox, processLinearInboxDelivery } = await import('../lib/linear-sync/worker')
  const { hashDeviceToken } = await import('../lib/device-link')
  const complete = await import('../app/v1/runs/[runId]/complete/route')
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
  let linearLoopbackOrigin: string | undefined
  globalThis.fetch = (async (input, init) => {
    const target = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (target.origin === 'https://api.linear.app' && target.pathname === '/graphql' && linearLoopbackOrigin) return noExternalFetch(new URL('/graphql', linearLoopbackOrigin), init)
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
  // Recreate the pre-verification migration state in this fresh synthetic DB
  // so an unlinked terminal job can exist exactly as it could before 2242.
  // Later replays restore 2242 and 2243 before any application assertions.
  await pool.query(await readFile(new URL('../drizzle/20261027183121_team_issue_creation_gate.sql',import.meta.url),'utf8'))
  const legacyFailed=randomUUID()
  await pool.query('insert into issues (id,"userId",title,content,status,priority,scope) values ($1,$2,\'Legacy failed-only task\',$3,\'todo\',\'normal\',\'workspace\')',[legacyFailed,owner,doc])
  await pool.query('update linear_sync_outbox set status=\'failed\',attempts=8 where "issueId"=$1',[legacyFailed])
  assert.equal((await pool.query('select count(*)::int n from linear_sync_outbox where "issueId"=$1 and status=\'failed\'',[legacyFailed])).rows[0].n,1)
  fixtureIds.push(legacyFailed)
  // A synthetic legacy Linear-origin task imported before verified-target
  // migration, now on generation 2. The trusted migration derives the flag
  // from its immutable revision-1 Linear history; no fixture sets it directly.
  const legacyImported=randomUUID(), legacyLink=randomUUID()
  await pool.query('insert into issues (id,"userId",title,content,status,priority,scope,"scopeVersion",revision) values ($1,$2,\'Legacy imported task\',$3,\'todo\',\'normal\',\'workspace\',2,1)',[legacyImported,owner,doc])
  await pool.query('insert into issue_versions (id,"issueId","userId",revision,title,content,status,priority,actor_type,actor_id) values ($1,$2,$3,1,\'Legacy imported task\',$4,\'todo\',\'normal\',\'system\',\'linear\')',[randomUUID(),legacyImported,owner,doc])
  await pool.query('insert into linear_issue_links (id,"issueId","ownerId","teamSyncId","linearIssueId","linearIdentifier") values ($1,$2,$3,$4,$2::uuid::text,\'MIK-legacy\')',[legacyLink,legacyImported,owner,sync])
  await pool.query('update linear_sync_outbox set status=\'done\' where "issueId"=$1',[legacyImported])
  assert.equal((await pool.query('select "externalTargetVerified" from linear_issue_links where id=$1',[legacyLink])).rows[0].externalTargetVerified,false)
  // Replay the tracked migration's legacy backfill while the isolated DB has
  // only this synthetic legacy fixture. It includes its normal trigger DDL.
  await pool.query(await readFile(new URL('../drizzle/20261027183123_require_verified_team_promotion.sql',import.meta.url),'utf8'))
  // Restore the subsequent tracked scope gate; the older migration replaces
  // its function body. This leaves the suite on the exact final policy.
  await pool.query(await readFile(new URL('../drizzle/20261027183124_team_issue_promotions.sql',import.meta.url),'utf8'))
  assert.equal((await pool.query('select "externalTargetVerified" from linear_issue_links where id=$1',[legacyLink])).rows[0].externalTargetVerified,true)
  fixtureIds.push(legacyImported)
  await pool.query('insert into devices (id,"ownerId",name) values ($1,$2,\'Synthetic\')', [device,member])
  await pool.query('insert into agents (id,"userId",harness,name,"deviceId") values ($1,$2,\'codex\',\'Synthetic\',$3)', [agent,member,device])
  await pool.query('insert into device_repos (id,"deviceId","userId","repoPath","baseBranch") values ($1,$2,$3,\'/synthetic/issue184\',\'main\')', [repo,device,member])
  await pool.query('insert into devices (id,"ownerId",name) values ($1,$2,\'Synthetic owner\')', [ownerDevice,owner])
  await pool.query('insert into agents (id,"userId",harness,name,"deviceId") values ($1,$2,\'codex\',\'Synthetic owner\',$3)', [ownerAgent,owner,ownerDevice])
  await pool.query('insert into device_repos (id,"deviceId","userId","repoPath") values ($1,$2,$3,\'/synthetic/owner\')', [ownerRepo,ownerDevice,owner])
  const deviceToken = `synthetic-${randomUUID()}`
  await pool.query('insert into device_tokens (id,"userId","tokenHash") values ($1,$2,$3)', [randomUUID(),member,hashDeviceToken(deviceToken)])
  const [teamSync] = await db.select().from(linearTeamSyncs).where(eq(linearTeamSyncs.id,sync))
  const remote = (id: string) => ({ id, identifier:'MIK-184', title:'Stale external title', description:'Old workspace description', dueDate:null, priority:0, url:'https://example.invalid/synthetic',updatedAt:new Date(Date.now()+60000).toISOString(),state:null,team:{id:team,key:'MIK',name:'Synthetic'},assignee:null,labels:[] })
  async function seed(id: string, remoteId = id, linked = true) {
    if (!fixtureIds.includes(id)) fixtureIds.push(id)
    if (linked && remoteId === id) {
      const imported=await createAppIssueFromLinear(teamSync,{...remote(id),title:'Synthetic scope task',updatedAt:'2020-01-01T00:00:00.000Z'})
      assert.ok(imported);assert.equal(imported.id,id)
      // Preserve a real import's verified target while giving the test its
      // familiar metadata; the tracked trigger queues the resulting edit.
      await pool.query('update issues set content=$2 where id=$1',[id,doc])
    } else {
      await pool.query('insert into issues (id,"userId",title,content,status,priority,scope) values ($1,$2,\'Synthetic scope task\',$3,\'todo\',\'normal\',\'workspace\')', [id,owner,doc])
      if (linked) await pool.query('insert into linear_issue_links (id,"issueId","ownerId","teamSyncId","linearIssueId","linearIdentifier") values ($1,$2,$3,$4,$5,\'MIK-184\')', [randomUUID(),id,owner,sync,remoteId])
    }
    await pool.query('insert into mikka_team_issues ("issueId","teamId","workspaceId","userId") values ($1,$2,$3,$4)', [id,team,workspace,owner])
  }
  const localFlip = (id: string, revision = 1) => changeIssueScopeLocally(owner, { id,revision,scope:'personal' }, { allowLinkedPersonal: true })
  await seed(issue)
  const [originalLink] = await db.select().from(linearIssueLinks).where(eq(linearIssueLinks.issueId, issue))
  for (const [id,user] of [[memberRun,member],[ownerRun,owner]]) await pool.query('insert into agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId",status,"leaseExpiresAt") values ($1,$2,$3,$4,$5,$6,\'queued\',now()+interval \'1 minute\')', [id,user,issue,user===owner?ownerAgent:agent,user===owner?ownerDevice:device,user===owner?ownerRepo:repo])
  await pool.query('update agent_runs set status=\'running\' where id=$1',[ownerRun])
  const memberToken = (await issueRunToken({id:memberRun,userId:member})).token
  const ownerToken = (await issueRunToken({id:ownerRun,userId:owner})).token
  async function withClaimServer(check: (origin: string)=>Promise<void>, runId = memberRun) {
    const server = createServer(async (incoming,outgoing) => {
      const request = new Request(`http://127.0.0.1${incoming.url}`,{method:'POST',headers:{authorization:incoming.headers.authorization??''}})
      try {
        const response = await claim.POST(request,{params:Promise.resolve({deviceId:device,runId})})
        outgoing.writeHead(response.status,Object.fromEntries(response.headers));outgoing.end(await response.text())
      } catch { outgoing.writeHead(500);outgoing.end('Handler failed') }
    })
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
    try { await check(`http://127.0.0.1:${(server.address() as {port:number}).port}`) }
    finally { await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())) }
  }
  await scopeSubtest(t, 'context and stale classifier cannot publish a personal task without a user choice', async () => {
    const id=randomUUID();fixtureIds.push(id)
    await pool.query('insert into issues (id,"userId",title,content,status,priority,scope) values ($1,$2,\'Ship team work urgently\',$3,\'todo\',\'normal\',\'personal\')',[id,owner,doc])
    await pool.query('insert into mikka_team_issues ("issueId","teamId","workspaceId","userId") values ($1,$2,$3,$4)',[id,team,workspace,owner])
    const { judgeIssueScope }=await import('../lib/issue-scope-judge')
    for (const context of ['Telegram','the Mikka app','ambiguous team conversation']) await judgeIssueScope(id,context)
    await assert.rejects(pool.query('update issues set scope=\'workspace\',"scopeConfidence"=0.99 where id=$1 and "scopeSetBy"=\'agent\'',[id]),(error:unknown)=>(error as {code:string}).code==='23514')
    assert.deepEqual((await pool.query('select scope,"scopeSetBy" from issues where id=$1',[id])).rows[0],{scope:'personal',scopeSetBy:'agent'})
    assert.equal((await pool.query('select count(*)::int n from linear_sync_outbox where "issueId"=$1',[id])).rows[0].n,0)
    assert.equal((await pool.query('select count(*)::int n from linear_issue_publications where "issueId"=$1',[id])).rows[0].n,0)
    assert.ok('issue' in await promoteExistingIssueForUser(owner,{requestId:randomUUID(),issueId:id,revision:1,teamId:team,expectedTeamId:team}))
    assert.deepEqual((await pool.query('select scope,"scopeSetBy" from issues where id=$1',[id])).rows[0],{scope:'workspace',scopeSetBy:'user'})
  })
  await scopeSubtest(t, 'owner preview detects external state changes and confirmation remains fail closed',async()=>{
    const id=randomUUID();await seed(id,id,false)
    const first=await actAs(owner,()=>previewIssuePersonalScope(id))
    assert.ok('preview' in first && first.preview);assert.equal(first.preview.externalCopyPossible,false)
    assert.deepEqual(await actAs(member,()=>previewIssuePersonalScope(id)),{error:'issueScopeOwnerOnly'})
    await pool.query('insert into linear_issue_publications (id,"issueId","ownerId","teamSyncId","scopeVersion","linearIssueId") values ($1,$2,$3,$4,1,$5)',[randomUUID(),id,owner,sync,randomUUID()])
    assert.deepEqual(await actAs(owner,()=>confirmIssuePersonalScope({id,revision:first.preview.revision,confirmation:first.preview.confirmation})),{error:'issueStale'})
    const next=await actAs(owner,()=>previewIssuePersonalScope(id))
    assert.ok('preview' in next && next.preview);assert.equal(next.preview.externalCopyPossible,true);assert.equal(next.preview.hasLinearLink,false)
    assert.deepEqual(await actAs(owner,()=>confirmIssuePersonalScope({id,revision:next.preview.revision,confirmation:next.preview.confirmation})),{error:'issueScopeInLinear'})
    assert.equal((await pool.query('select scope from issues where id=$1',[id])).rows[0].scope,'workspace')
    const linked=await actAs(owner,()=>previewIssuePersonalScope(issue))
    assert.ok('preview' in linked && linked.preview);assert.equal(linked.preview.hasLinearLink,true);assert.equal(linked.preview.externalCopyPossible,true)
    assert.deepEqual(await actAs(owner,()=>confirmIssuePersonalScope({id:issue,revision:linked.preview.revision,confirmation:linked.preview.confirmation})),{error:'issueScopeInLinear'})
    const safe=randomUUID();await seed(safe,safe,false)
    const safePreview=await actAs(owner,()=>previewIssuePersonalScope(safe))
    assert.ok('preview' in safePreview && safePreview.preview);assert.equal(safePreview.preview.externalCopyPossible,false)
    const accepted=await actAs(owner,()=>confirmIssuePersonalScope({id:safe,revision:safePreview.preview.revision,confirmation:safePreview.preview.confirmation}))
    assert.ok('issue' in accepted && accepted.issue);assert.equal(accepted.issue.scope,'personal')
  })
  await scopeSubtest(t, 'pending disposition gate, owner check and stale revisions leave no partial state', async () => {
    assert.ok(await issueForUser(member,issue))
    assert.ok(await readRun(member,memberRun))
    assert.ok(await verifyRunToken(new Request('http://127.0.0.1/'),memberToken))
    assert.deepEqual(await actAs(owner,()=>setIssueScope({id:issue,revision:1,scope:'personal'})),{error:'issueScopeInLinear'})
    assert.deepEqual(await changeIssueScopeLocally(owner,{id:issue,revision:1,scope:'personal'},{allowLinkedPersonal:false}),{error:'issueScopeInLinear'})
    assert.deepEqual(await changeIssueScopeLocally(member,{id:issue,revision:1,scope:'personal'},{allowLinkedPersonal:true}),{error:'issueScopeOwnerOnly'})
    assert.deepEqual(await localFlip(issue,99),{error:'issueStale'})
    assert.equal((await pool.query('select count(*)::int n from linear_issue_detachments where "issueId"=$1',[issue])).rows[0].n,0)
  })
  await scopeSubtest(t, 'the same native claim route succeeds while workspace access is still active', async () => {
    await withClaimServer(async origin=>{
      const response=await fetch(`${origin}/claim`,{method:'POST',headers:{authorization:`Bearer ${deviceToken}`}})
      assert.equal(response.status,200)
      const claimed=await response.json()
      assert.equal(claimed.runId,memberRun)
      assert.ok(await verifyRunToken(new Request(`${origin}/`),claimed.mcp.token))
    })
  })
  await scopeSubtest(t, 'claim paused after commit returns no prompt when retirement wins before token issuance', async () => {
    const id=randomUUID(),run=randomUUID(),barrier=18430127
    await seed(id,id,false)
    await pool.query('insert into agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId",status,prompt) values ($1,$2,$3,$4,$5,$6,\'queued\',\'private claim race instructions\')',[run,member,id,agent,device,repo])
    // This retained, fixture-specific trigger pauses before the scope token
    // fence. Its advisory lock never touches the issue/run retirement locks.
    await pool.query(`create function scope184_claim_response_barrier() returns trigger language plpgsql as $$ begin
      if new."runId"='${run}'::uuid then perform pg_advisory_xact_lock(${barrier}); end if;return new;end $$;
      create trigger aaa_scope184_claim_response_barrier before insert on run_tokens for each row execute function scope184_claim_response_barrier()`)
    const blocker=await pool.connect()
    let responsePromise:Promise<Response>|undefined
    let held=false
    try {
      await blocker.query('select pg_advisory_lock($1)',[barrier]);held=true
      const pid=(await blocker.query('select pg_backend_pid() pid')).rows[0].pid
      await withClaimServer(async origin=>{
        try {
          responsePromise=fetch(`${origin}/claim`,{method:'POST',headers:{authorization:`Bearer ${deviceToken}`}})
          await waitFor(async()=>Boolean((await pool.query("select 1 from pg_stat_activity a where a.wait_event_type='Lock' and $1=any(pg_blocking_pids(a.pid))",[pid])).rowCount),'claim did not pause before token issuance')
          assert.equal((await pool.query('select status from agent_runs where id=$1',[run])).rows[0].status,'preparing')
          const preview=await actAs(owner,()=>previewIssuePersonalScope(id))
          assert.ok('preview' in preview && preview.preview)
          const changed=await actAs(owner,()=>confirmIssuePersonalScope({id,revision:1,confirmation:preview.preview.confirmation}))
          assert.ok('issue' in changed)
          await blocker.query('select pg_advisory_unlock($1)',[barrier]);held=false
          const response=await responsePromise
          assert.equal(response.status,409)
          const body=await response.text()
          for(const field of ['private claim race instructions','prompt','mcp','subscriptionBinding'])assert.equal(body.includes(field),false)
          assert.equal((await pool.query('select status from agent_runs where id=$1',[run])).rows[0].status,'cancelled')
          assert.equal((await pool.query('select count(*)::int n from run_tokens where "runId"=$1 and "revokedAt" is null',[run])).rows[0].n,0)
          assert.equal((await pool.query('select count(*)::int n from linear_sync_outbox where "issueId"=$1',[id])).rows[0].n,0)
        } finally {
          if(held){await blocker.query('select pg_advisory_unlock($1)',[barrier]);held=false}
          if(responsePromise)await Promise.allSettled([responsePromise])
        }
      },run)
    } finally {
      if(held)await blocker.query('select pg_advisory_unlock($1)',[barrier]);blocker.release()
      if(responsePromise)await Promise.allSettled([responsePromise])
    }
  })
  await scopeSubtest(t, 'claim response tolerates a heartbeat holding its run before the issue fence',async()=>{
    const id=randomUUID(),run=randomUUID(),lease=new Date(Date.now()+600_000).toISOString()
    await seed(id,id,false)
    await pool.query('insert into agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId",status,"leaseExpiresAt") values ($1,$2,$3,$4,$5,$6,\'preparing\',$7)',[run,member,id,agent,device,repo,lease])
    const writer=await pool.connect()
    let responding:ReturnType<typeof authorizedClaimResponse>|undefined
    try {
      await writer.query('begin')
      await writer.query('select id from agent_runs where id=$1 for update',[run])
      const pid=(await writer.query('select pg_backend_pid() pid')).rows[0].pid
      responding=authorizedClaimResponse(member,{id:run,issueId:id,agentId:agent,deviceId:device,deviceRepoId:repo},lease,()=>new Response('authorized',{status:200}))
      await waitFor(async()=>Boolean((await pool.query("select 1 from pg_stat_activity a where a.wait_event_type='Lock' and $1=any(pg_blocking_pids(a.pid))",[pid])).rowCount),'response did not wait on the held heartbeat run')
      try {await writer.query('update agent_runs set "updatedAt"=now() where id=$1',[run]);await writer.query('commit')}
      catch(error){assert.equal((error as {code:string}).code,'40P01');await writer.query('rollback')}
      assert.equal((await responding)?.status,200)
      assert.equal((await pool.query('select status from agent_runs where id=$1',[run])).rows[0].status,'preparing')
    } finally {await writer.query('rollback');writer.release();if(responding)await Promise.allSettled([responding])}
  })
  await scopeSubtest(t, 'concurrent clicks commit one revision, one tombstone, and cancel old outbox work', async () => {
    const results = await Promise.all([localFlip(issue),localFlip(issue)])
    assert.equal(results.filter(result=>'issue' in result).length,1)
    assert.equal(results.filter(result=>'error' in result && result.error==='issueStale').length,1)
    const saved = results.find(result=>'issue' in result)!
    assert.ok(saved.issue)
    assert.equal(saved.issue.identifier,'ALEX-12')
    const row = (await pool.query('select scope,"scopeSetBy","scopeConfidence",revision from issues where id=$1',[issue])).rows[0]
    assert.deepEqual(row,{scope:'personal',scopeSetBy:'user',scopeConfidence:null,revision:2})
    assert.equal((await pool.query('select count(*)::int n from issue_versions where "issueId"=$1',[issue])).rows[0].n,2)
    assert.equal((await pool.query('select count(*)::int n from linear_issue_detachments where "issueId"=$1',[issue])).rows[0].n,1)
    assert.equal((await pool.query('select count(*)::int n from linear_issue_links where "issueId"=$1',[issue])).rows[0].n,0)
    assert.equal((await pool.query('select count(*)::int n from linear_sync_outbox where "issueId"=$1 and status<>\'done\'',[issue])).rows[0].n,0)
  })
  await scopeSubtest(t, 'scope commit removes teammate task and own-run access and revokes execution immediately', async () => {
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
  await scopeSubtest(t, 'native claim route rejects the revoked run over real loopback HTTP', async () => {
    await withClaimServer(async origin=>{
      assert.equal((await fetch(`${origin}/claim`,{method:'POST'})).status,401)
      const response=await fetch(`${origin}/claim`,{method:'POST',headers:{authorization:`Bearer ${deviceToken}`}})
      assert.equal(response.status,409)
      assert.equal((await response.text()).includes('prompt'),false)
    })
  })
  await scopeSubtest(t, 'replayed imports, forced snapshots and outbox retries cannot resurrect personal scope', async () => {
    for (let index=0;index<2;index++) assert.equal(await createAppIssueFromLinear(teamSync,remote(issue)),null)
    assert.equal(await applyLinearIssueToApp(teamSync,remote(issue),true),null)
    await pool.query('insert into linear_sync_outbox (id,"issueId") values ($1,$2)',[randomUUID(),issue])
    await processLinearIssueOutbox(issue)
    await syncAppIssueToLinear(issue)
    assert.equal((await pool.query('select scope,title from issues where id=$1',[issue])).rows[0].scope,'personal')
    assert.equal((await pool.query('select count(*)::int n from linear_sync_outbox where "issueId"=$1 and status<>\'done\'',[issue])).rows[0].n,0)
    await assert.rejects(pool.query('insert into linear_issue_links (id,"issueId","ownerId","teamSyncId","linearIssueId","linearIdentifier") values ($1,$2,$3,$4,$5,\'MIK-184\')',[randomUUID(),issue,owner,sync,issue]),(error:unknown)=>(error as {code:string}).code==='23514')
  })
  await scopeSubtest(t, 'delayed issue and comment deliveries finish without fetching the external provider', async () => {
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
    const beforeDocument=(await pool.query('select state from issue_documents where "issueId"=$1',[issue])).rows[0]?.state
    await applyLinearCommentToApp({issue:oldIssue,issueLink:originalLink,id:randomUUID(),body:'late external comment',author:'Synthetic',parentId:null,createdAt:new Date().toISOString(),action:'update'})
    assert.equal((await pool.query('select state from issue_documents where "issueId"=$1',[issue])).rows[0]?.state,beforeDocument)
  })
  await scopeSubtest(t, 'a detached remote UUID different from the local UUID cannot create a second workspace task', async () => {
    const id = randomUUID(),remoteId=randomUUID()
    await seed(id,remoteId);await localFlip(id)
    assert.equal(await createAppIssueFromLinear(teamSync,remote(remoteId)),null)
    assert.equal((await pool.query('select count(*)::int n from issues where id=$1',[remoteId])).rows[0].n,0)
  })
  await scopeSubtest(t, 'version write failure rolls back scope, tombstone, link, outbox and run cancellation', async () => {
    const id=randomUUID();await seed(id)
    const constraint=`scope_rollback_${id.replaceAll('-','')}`
    // Additive, fixture-specific failure injection; no existing row is changed.
    await pool.query(`alter table issue_versions add constraint ${constraint} check ("issueId" <> '${id}'::uuid) not valid`)
    await assert.rejects(localFlip(id))
    assert.equal((await pool.query('select scope from issues where id=$1',[id])).rows[0].scope,'workspace')
    assert.equal((await pool.query('select count(*)::int n from linear_issue_links where "issueId"=$1',[id])).rows[0].n,1)
    assert.equal((await pool.query('select count(*)::int n from linear_issue_detachments where "issueId"=$1',[id])).rows[0].n,0)
    assert.equal((await pool.query('select status from linear_sync_outbox where "issueId"=$1',[id])).rows[0].status,'queued')
  })
  await scopeSubtest(t, 'queue racing a locked scope conversion fails after the conversion commits', async () => {
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
  await scopeSubtest(t, 'a real run-row/scope deadlock is safely retried without a duplicate transition', async () => {
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
      assert.equal((await pool.query('select count(*)::int n from issue_versions where "issueId"=$1',[id])).rows[0].n,2)
    } finally { await writer.query('rollback');writer.release();if(transition) await Promise.allSettled([transition]) }
  })
  await scopeSubtest(t, 'HTTP completion paused after live read cannot write or dispatch after an unlinked task becomes personal', async () => {
    const localOwner=`complete-owner-${randomUUID()}`,id=randomUUID(),run=randomUUID()
    fixtureIds.push(id)
    await pool.query('insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values ($1,\'Complete owner\',$2,true,now(),now())',[localOwner,`${localOwner}@example.invalid`])
    await pool.query('insert into mikka_workspace_members ("workspaceId","userId",name,email,role,status) values ($1,$2,\'Complete owner\',$3,\'member\',\'active\')',[workspace,localOwner,`${localOwner}@example.invalid`])
    await pool.query('insert into issues (id,"userId",title,content,status,priority,scope) values ($1,$2,\'Unlinked completion fixture\',$3,\'todo\',\'normal\',\'workspace\')',[id,localOwner,doc])
    await pool.query('insert into mikka_team_issues ("issueId","teamId","workspaceId","userId") values ($1,$2,$3,$4)',[id,team,workspace,localOwner])
    await pool.query('insert into agent_runs (id,"userId","issueId","agentId","deviceId",status) values ($1,$2,$3,$4,$5,\'running\')',[run,member,id,agent,device])
    const prepared=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
    const server=createServer(async(incoming,outgoing)=>{
      const chunks:Buffer[]=[];for await(const chunk of incoming) chunks.push(Buffer.from(chunk))
      const body=Buffer.concat(chunks).toString()
      const request=new Request(`http://127.0.0.1${incoming.url}`,{method:'POST',headers:{authorization:incoming.headers.authorization??''},body})
      request.json=async()=>{prepared.resolve();await release.promise;return JSON.parse(body)}
      try {const response=await complete.POST(request,{params:Promise.resolve({runId:run})});outgoing.writeHead(response.status);outgoing.end(await response.text())}
      catch {outgoing.writeHead(500);outgoing.end('Completion failed')}
    })
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
    let responsePromise:Promise<Response>|undefined
    try {
      const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`
      const report={summary:'Synthetic verified completion',filesChanged:[],verify:{status:'passed'},openQuestions:[],nextStep:null}
      responsePromise=fetch(`${origin}/complete`,{method:'POST',headers:{authorization:`Bearer ${deviceToken}`,'content-type':'application/json'},body:JSON.stringify({stopReason:'submitted',report})})
      await prepared.promise
      assert.deepEqual(await actAs(localOwner,()=>setIssueScope({id,revision:1,scope:'personal'})),{error:'issueScopeConfirmationRequired'})
      const preview=await actAs(localOwner,()=>previewIssuePersonalScope(id))
      assert.ok('preview' in preview && preview.preview)
      const changed=await actAs(localOwner,()=>confirmIssuePersonalScope({id,revision:1,confirmation:preview.preview.confirmation}))
      assert.ok('issue' in changed)
      release.resolve()
      assert.equal((await responsePromise).status,204)
      const row=(await pool.query('select status,scope from issues where id=$1',[id])).rows[0]
      assert.deepEqual(row,{status:'todo',scope:'personal'})
      assert.equal((await pool.query('select status from agent_runs where id=$1',[run])).rows[0].status,'cancelled')
      assert.equal((await pool.query('select count(*)::int n from linear_sync_outbox where "issueId"=$1',[id])).rows[0].n,0)
      assert.equal((await pool.query('select count(*)::int n from coordinator_events where "runId"=$1',[run])).rows[0].n,0)
    } finally {release.resolve();if(responsePromise) await Promise.allSettled([responsePromise]);await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}
  })
  const passedReport={summary:'Synthetic completion',filesChanged:[],verify:{status:'passed' as const},openQuestions:[],nextStep:null}
  async function completionFixture(issueOwner: string, actor: string, scope='workspace', kind='implement', withIssue=true) {
    const id=randomUUID(),run=randomUUID()
    if(withIssue) {
      fixtureIds.push(id)
      await pool.query('insert into issues (id,"userId",title,content,status,priority,scope) values ($1,$2,\'Completion fixture\',$3,\'todo\',\'normal\',$4)',[id,issueOwner,doc,scope])
      await pool.query('insert into mikka_team_issues ("issueId","teamId","workspaceId","userId") values ($1,$2,$3,$4)',[id,team,workspace,issueOwner])
    }
    await pool.query('insert into agent_runs (id,"userId","issueId","agentId","deviceId",status,kind) values ($1,$2,$3,$4,$5,\'running\',$6)',[run,actor,withIssue?id:null,actor===owner?ownerAgent:agent,actor===owner?ownerDevice:device,kind])
    return {id,run,issueId:withIssue?id:null}
  }
  await scopeSubtest(t, 'completion and review commit before retirement; deferred dispatch is rejected after retirement and republishing', async()=>{
    const fixture=await completionFixture(member,owner)
    const locker=await pool.connect()
    let finishing:ReturnType<typeof completeRunForDevice>|undefined,privatizing:ReturnType<typeof changeIssueScopeLocally>|undefined
    try {
      await locker.query('begin');await locker.query('select id from agent_runs where id=$1 for update',[fixture.run])
      const lockerPid=(await locker.query('select pg_backend_pid() pid')).rows[0].pid
      finishing=completeRunForDevice(owner,{id:fixture.run,issueId:fixture.id},{stopReason:'submitted',report:passedReport})
      let completionPid:number|undefined
      for(let n=0;n<200;n++) {
        const waiting=await pool.query('select pid from pg_stat_activity where $1=any(pg_blocking_pids(pid))',[lockerPid])
        if(waiting.rows[0]) {completionPid=waiting.rows[0].pid;break}
        if(n===199) assert.fail('completion did not acquire the task before waiting for the run')
      }
      privatizing=changeIssueScopeLocally(member,{id:fixture.id,revision:1,scope:'personal'},{allowLinkedPersonal:true})
      for(let n=0;n<200;n++) {
        const waiting=await pool.query('select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) waiting',[completionPid])
        if(waiting.rows[0].waiting) break
        if(n===199) assert.fail('retirement did not wait for the completion transaction')
      }
      await locker.query('commit')
      const completed=await finishing;assert.ok(completed)
      assert.ok('issue' in await privatizing)
      assert.equal((await pool.query('select status from agent_runs where id=$1',[fixture.run])).rows[0].status,'succeeded')
      assert.deepEqual((await pool.query('select status,scope from issues where id=$1',[fixture.id])).rows[0],{status:'review',scope:'personal'})
      let dispatched=0
      assert.equal(await dispatchCompletedIssue(completed,()=>{dispatched++}),false)
      assert.ok('issue' in await promoteExistingIssueForUser(member,{requestId:randomUUID(),issueId:fixture.id,revision:2,teamId:team,expectedTeamId:team}))
      await pool.query('update issues set status=\'doing\' where id=$1',[fixture.id])
      assert.equal(await dispatchCompletedIssue(completed,()=>{dispatched++}),false)
      assert.equal(dispatched,0)
      assert.equal((await pool.query('select status from issues where id=$1',[fixture.id])).rows[0].status,'doing')
    } finally {await locker.query('rollback');locker.release();await Promise.allSettled([finishing,privatizing].filter(Boolean))}
  })
  await scopeSubtest(t, 'completion preserves member, owner-personal, plan, not-run, failed-verify and null-task behavior with idempotent replay',async()=>{
    for(const control of [
      {issueOwner:owner,actor:member,scope:'workspace',kind:'implement',verify:'passed' as const,status:'succeeded',review:true,dispatch:1},
      {issueOwner:owner,actor:member,scope:'workspace',kind:'implement',verify:'not_run' as const,status:'stopped',review:true,dispatch:1},
      {issueOwner:owner,actor:member,scope:'workspace',kind:'plan',verify:'not_run' as const,status:'succeeded',review:true,dispatch:1},
      {issueOwner:owner,actor:member,scope:'workspace',kind:'implement',verify:'failed' as const,status:'failed',review:false,dispatch:0},
      {issueOwner:owner,actor:owner,scope:'personal',kind:'implement',verify:'passed' as const,status:'succeeded',review:true,dispatch:0},
    ]) {
      const fixture=await completionFixture(control.issueOwner,control.actor,control.scope,control.kind)
      const token=(await issueRunToken({id:fixture.run,userId:control.actor})).token
      const completed=await completeRunForDevice(control.actor,{id:fixture.run,issueId:fixture.id},{stopReason:'submitted',report:{...passedReport,verify:{status:control.verify}}})
      assert.ok(completed)
      let dispatched=0;await dispatchCompletedIssue(completed,()=>{dispatched++});assert.equal(dispatched,control.dispatch)
      assert.equal((await pool.query('select status from agent_runs where id=$1',[fixture.run])).rows[0].status,control.status)
      assert.equal((await pool.query('select status from issues where id=$1',[fixture.id])).rows[0].status,control.review?'review':'todo')
      assert.equal(Boolean(await verifyRunToken(new Request('http://127.0.0.1/'),token)),false)
      assert.equal(await completeRunForDevice(control.actor,{id:fixture.run,issueId:fixture.id},{stopReason:'error'}),null)
      assert.equal((await pool.query('select count(*)::int n from coordinator_events where "runId"=$1',[fixture.run])).rows[0].n,1)
      if(control.actor===member) assert.equal((await complete.POST(new Request('http://127.0.0.1/complete',{method:'POST',headers:{authorization:`Bearer ${deviceToken}`},body:'invalid-json'}),{params:Promise.resolve({runId:fixture.run})})).status,204)
    }
    const orphan=await completionFixture(owner,owner,'personal','implement',false)
    const completed=await completeRunForDevice(owner,{id:orphan.run,issueId:null},{stopReason:'error'})
    assert.ok(completed);assert.equal(completed.review,null)
    assert.equal((await pool.query('select status from agent_runs where id=$1',[orphan.run])).rows[0].status,'failed')
  })
  await scopeSubtest(t, 'completion retries a real heartbeat lock-order deadlock and commits one event',async()=>{
    const fixture=await completionFixture(owner,member),writer=await pool.connect()
    let finishing:Promise<{result:Awaited<ReturnType<typeof completeRunForDevice>>;error:unknown}>|undefined
    try {
      await writer.query('begin');await writer.query("set local deadlock_timeout='5s'")
      await writer.query('select id from agent_runs where id=$1 for update',[fixture.run])
      const pid=(await writer.query('select pg_backend_pid() pid')).rows[0].pid
      finishing=completeRunForDevice(member,{id:fixture.run,issueId:fixture.id},{stopReason:'submitted',report:passedReport}).then(result=>({result,error:null}),error=>({result:null,error}))
      for(let n=0;n<200;n++) {
        const waiting=await pool.query('select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) waiting',[pid])
        if(waiting.rows[0].waiting) break
        if(n===199) assert.fail('completion did not wait on the held heartbeat run')
      }
      await writer.query('update agent_runs set "updatedAt"=now() where id=$1',[fixture.run]);await writer.query('commit')
      const outcome=await finishing
      assert.equal(outcome.error,null)
      assert.ok(outcome.result)
      assert.equal((await pool.query('select status from issues where id=$1',[fixture.id])).rows[0].status,'review')
      assert.equal((await pool.query('select count(*)::int n from coordinator_events where "runId"=$1',[fixture.run])).rows[0].n,1)
    } finally {await writer.query('rollback');writer.release();if(finishing) await Promise.allSettled([finishing])}
  })
  await scopeSubtest(t, 'completion rolls back run, token, event and task together when persistence fails',async()=>{
    const fixture=await completionFixture(owner,member)
    const token=(await issueRunToken({id:fixture.run,userId:member})).token
    await pool.query(`alter table coordinator_events add constraint completion_failure_${fixture.run.replaceAll('-','')} check ("runId" <> '${fixture.run}'::uuid)`)
    await assert.rejects(completeRunForDevice(member,{id:fixture.run,issueId:fixture.id},{stopReason:'submitted',report:passedReport}))
    assert.equal((await pool.query('select status from agent_runs where id=$1',[fixture.run])).rows[0].status,'running')
    assert.equal((await pool.query('select status from issues where id=$1',[fixture.id])).rows[0].status,'todo')
    assert.ok(await verifyRunToken(new Request('http://127.0.0.1/'),token))
    assert.equal((await pool.query('select count(*)::int n from coordinator_events where "runId"=$1',[fixture.run])).rows[0].n,0)
  })
  const { linearLoopback }=await import('./support/linear-loopback')
  const provider=await linearLoopback({id:team,key:'MIK',name:'Synthetic'})
  linearLoopbackOrigin=provider.origin
  t.after(()=>provider.close())
  const encryptionKey=process.env.LINEAR_TOKEN_ENCRYPTION_KEY
  // Synthetic-only material in memory; no provider credential is requested or used.
  process.env.LINEAR_TOKEN_ENCRYPTION_KEY='11'.repeat(32)
  t.after(()=>{if(encryptionKey===undefined) delete process.env.LINEAR_TOKEN_ENCRYPTION_KEY;else process.env.LINEAR_TOKEN_ENCRYPTION_KEY=encryptionKey})
  const { seal }=await import('../lib/linear-sync/crypto')
  await pool.query('insert into linear_connections ("userId","linearUserId","organizationId","organizationName","accessToken","refreshToken","expiresAt") values ($1,\'synthetic\',\'synthetic\',\'Synthetic\',$2,$2,now()+interval \'1 hour\')',[owner,seal('synthetic-loopback-only')])
  async function waitFor(check:()=>Promise<boolean>,label:string) {
    for(let n=0;n<300;n++) {if(await check()) return}
    assert.fail(label)
  }
  async function setDiscussion(id:string,body:string) {
    const {loadIssueDocument,upsertLinearComment,encodedIssueDocument}=await import('../lib/linear-sync/document')
    const document=loadIssueDocument(null,{type:'doc',content:[]})
    try {
      upsertLinearComment(document,{threadId:'scope-thread',messageId:'scope-message',author:'Synthetic',body,at:new Date().toISOString()})
      await pool.query('insert into issue_documents ("issueId","userId",state) values ($1,$2,$3) on conflict ("issueId") do update set state=excluded.state',[id,owner,encodedIssueDocument(document)])
    } finally {document.destroy()}
  }
  async function privatize(id:string,title='personal-only-draft') {
    const revision=(await pool.query('select revision from issues where id=$1',[id])).rows[0].revision
    assert.ok('issue' in await localFlip(id,revision))
    const privateContent={type:'doc',attrs:{mikka:{number:12}},content:[{type:'paragraph',content:[{type:'text',text:'privatebodysecret'}]}]}
    await pool.query('update issues set title=$2,content=$3,revision=revision+1,"updatedAt"=now() where id=$1',[id,title,JSON.stringify(privateContent)])
  }
  async function republish(id:string,title='new-publication-title') {
    await pool.query('update issues set title=$2,revision=revision+1,"updatedAt"=now() where id=$1',[id,title])
    const revision=(await pool.query('select revision from issues where id=$1',[id])).rows[0].revision
    const result=await promoteExistingIssueForUser(owner,{requestId:randomUUID(),issueId:id,revision,teamId:team,expectedTeamId:team})
    assert.ok('issue' in result && result.issue);assert.equal(result.issue.scope,'workspace');assert.equal(result.issue.linearSyncBlocked,true)
    assert.deepEqual(result.linearSync,{enabled:false,reason:'no_explicit_target'})
    await processLinearIssueOutbox(id)
    assert.equal((await pool.query('select count(*)::int n from linear_issue_links where "issueId"=$1',[id])).rows[0].n,0)
    return result.issue
  }
  await scopeSubtest(t, 'public app and MCP task creation remain personal without Linear requests',async()=>{
    const calls=provider.requests.length
    const app=await action(()=>saveIssue({title:'Team context alone',content:JSON.parse(doc),status:'todo',priority:'normal'}))
    assert.ok('issue' in app);fixtureIds.push(app.issue.id)
    const {createIssue}=await import('../lib/mcp/actions')
    const bot=await action(()=>createIssue(owner,{title:'Ambiguous work task',body:'Perhaps for the team'}))
    assert.ok('id' in bot);fixtureIds.push(bot.id)
    for(const id of [app.issue.id,bot.id]) {
      assert.equal((await pool.query('select scope from issues where id=$1',[id])).rows[0].scope,'personal')
      assert.equal((await pool.query('select count(*)::int n from linear_sync_outbox where "issueId"=$1',[id])).rows[0].n,0)
      assert.equal((await pool.query('select count(*)::int n from linear_issue_publications where "issueId"=$1',[id])).rows[0].n,0)
    }
    assert.equal(provider.requests.length,calls)
  })
  async function inbound(type:'Issue'|'Comment',action:string,data:Record<string,unknown>) {
    const deliveryId=`scope-inbound-${randomUUID()}`
    await pool.query('insert into linear_sync_inbox ("deliveryId","organizationId","eventType",payload) values ($1,\'synthetic\',$2,$3)',[deliveryId,type,JSON.stringify({type,action,organizationId:'synthetic',data})])
    await processLinearInboxDelivery(deliveryId)
    assert.equal((await pool.query('select status from linear_sync_inbox where "deliveryId"=$1',[deliveryId])).rows[0].status,'done')
  }
  await scopeSubtest(t, 'verified issue and comment removal events preserve links and acknowledge the remote removal',async()=>{
    const id=randomUUID();await seed(id)
    const link=(await pool.query('select id from linear_issue_links where "issueId"=$1',[id])).rows[0]
    const commentId=randomUUID(),commentLinkId=randomUUID()
    await pool.query('insert into linear_comment_links (id,"issueLinkId","threadId","messageId","linearCommentId","bodyHash") values ($1,$2,\'remove-thread\',\'remove-message\',$3,\'synthetic\')',[commentLinkId,link.id,commentId])
    const calls=provider.requests.length
    await inbound('Comment','remove',{id:commentId,issueId:id})
    assert.equal((await pool.query('select "syncStatus" from linear_comment_links where id=$1',[commentLinkId])).rows[0].syncStatus,'remote_removed')
    await inbound('Issue','remove',{id,teamId:team})
    const current=(await pool.query('select "externalTargetVerified","syncStatus","remoteRemovedAt" is not null removed from linear_issue_links where id=$1',[link.id])).rows[0]
    assert.deepEqual(current,{externalTargetVerified:true,syncStatus:'remote_removed',removed:true})
    assert.equal(provider.requests.length,calls)
  })
  await scopeSubtest(t, 'removal waiting for the issue lock cannot write after retirement commits',async()=>{
    const id=randomUUID();await seed(id)
    const locker=await pool.connect();let delivery:Promise<void>|undefined
    const beforeCalls=provider.requests.length
    try {
      await locker.query('begin');await locker.query('select id from issues where id=$1 for update',[id])
      delivery=inbound('Issue','remove',{id,teamId:team})
      await waitFor(async()=>Boolean((await pool.query("select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%issues%for update%' and pid<>pg_backend_pid()")).rows[0]),'remove did not wait for the issue lock')
      await locker.query('update issues set scope=\'personal\',revision=revision+1 where id=$1',[id])
      await locker.query('commit')
      const snapshot=(await pool.query('select title,status,scope,revision,"updatedAt" from issues where id=$1',[id])).rows[0]
      await delivery
      assert.deepEqual((await pool.query('select title,status,scope,revision,"updatedAt" from issues where id=$1',[id])).rows[0],snapshot)
      assert.equal((await pool.query('select count(*)::int n from linear_issue_links where "issueId"=$1',[id])).rows[0].n,0)
      assert.equal(provider.requests.length,beforeCalls)
    } finally {await locker.query('rollback');locker.release();if(delivery) await Promise.allSettled([delivery])}
  })
  await scopeSubtest(t, 'external UUID collision with personal task cannot clear diagnostics or change personal data',async()=>{
    const result=await action(()=>saveIssue({title:'Personal external collision',content:JSON.parse(doc),status:'todo',priority:'normal'}))
    assert.ok('issue' in result && result.issue);const id=result.issue.id;fixtureIds.push(id)
    provider.issues.set(id,remote(id))
    await pool.query('update linear_team_syncs set "lastError"=\'preserved-personal-diagnostic\' where id=$1',[sync])
    const snapshot=(await pool.query('select title,status,scope,revision,"updatedAt" from issues where id=$1',[id])).rows[0]
    const calls=provider.requests.length
    await inbound('Issue','update',{id,teamId:team})
    assert.deepEqual((await pool.query('select title,status,scope,revision,"updatedAt" from issues where id=$1',[id])).rows[0],snapshot)
    assert.equal((await pool.query('select "lastError" from linear_team_syncs where id=$1',[sync])).rows[0].lastError,'preserved-personal-diagnostic')
    assert.equal((await pool.query('select count(*)::int n from linear_issue_links where "issueId"=$1',[id])).rows[0].n,0)
    assert.ok(provider.requests.length>calls)
    assert.ok(provider.requests.slice(calls).every(call=>call.operation==='MikkaLinearIssue'))
  })
  await scopeSubtest(t, 'blocked workspace reservation cannot let an incoming snapshot clear later diagnostics',async()=>{
    const id=randomUUID();await seed(id,id,false);await privatize(id);const promoted=await republish(id)
    const remoteId=randomUUID()
    await pool.query('insert into linear_issue_publications (id,"issueId","ownerId","teamSyncId","scopeVersion","linearIssueId") values ($1,$2,$3,$4,$5,$6)',[randomUUID(),id,owner,sync,promoted.scopeVersion,remoteId])
    provider.issues.set(remoteId,remote(remoteId))
    await pool.query('update linear_team_syncs set "lastError"=\'preserved-blocked-diagnostic\' where id=$1',[sync])
    const snapshot=(await pool.query('select title,status,scope,revision,"updatedAt" from issues where id=$1',[id])).rows[0]
    const calls=provider.requests.length
    await inbound('Issue','update',{id:remoteId,teamId:team})
    assert.deepEqual((await pool.query('select title,status,scope,revision,"updatedAt" from issues where id=$1',[id])).rows[0],snapshot)
    assert.equal((await pool.query('select "lastError" from linear_team_syncs where id=$1',[sync])).rows[0].lastError,'preserved-blocked-diagnostic')
    assert.equal((await pool.query('select count(*)::int n from linear_issue_links where "issueId"=$1',[id])).rows[0].n,0)
    assert.ok(provider.requests.length>calls)
    assert.ok(provider.requests.slice(calls).every(call=>call.operation==='MikkaLinearIssue'))
  })
  await scopeSubtest(t, 'a genuinely new remote task still imports through the authorized team and clears its diagnostic',async()=>{
    const id=randomUUID();fixtureIds.push(id);provider.issues.set(id,remote(id))
    await pool.query('update linear_team_syncs set "lastError"=\'new-remote-control\' where id=$1',[sync])
    const calls=provider.requests.length
    await inbound('Issue','update',{id,teamId:team})
    const current=(await pool.query('select i.scope,i."linearSyncBlocked",l."externalTargetVerified" from issues i join linear_issue_links l on l."issueId"=i.id where i.id=$1',[id])).rows[0]
    assert.deepEqual(current,{scope:'workspace',linearSyncBlocked:false,externalTargetVerified:true})
    assert.equal((await pool.query('select "lastError" from linear_team_syncs where id=$1',[sync])).rows[0].lastError,null)
    assert.ok(provider.requests.length>calls)
    assert.ok(provider.requests.slice(calls).every(call=>call.operation==='MikkaLinearIssue'))
  })
  await scopeSubtest(t, 'an in-flight old update cannot write personal state or upload its captured comments',async()=>{
    const id=randomUUID();await seed(id)
    provider.issues.set(id,{...remote(id),updatedAt:'2020-01-01T00:00:00.000Z'})
    await setDiscussion(id,'old-publication-comment')
    const hold=provider.hold('MikkaLinearUpdateIssue'),request=processLinearIssueOutbox(id)
    try {
      await hold.arrived
      await privatize(id)
      const snapshot=(await pool.query('select scope,title from issues where id=$1',[id])).rows[0]
      assert.deepEqual(snapshot,{scope:'personal',title:'personal-only-draft'})
      const before=provider.requests.length
      hold.release();await request
      assert.deepEqual((await pool.query('select scope,title from issues where id=$1',[id])).rows[0],snapshot)
      assert.equal((await pool.query('select count(*)::int n from linear_issue_links where "issueId"=$1',[id])).rows[0].n,0)
      assert.equal((await pool.query('select count(*)::int n from linear_sync_outbox where "issueId"=$1 and status<>\'done\'',[id])).rows[0].n,0)
      await syncAppIssueToLinear(id);await processLinearIssueOutbox(id)
      assert.equal(provider.requests.length,before)
      assert.equal(JSON.stringify(provider.requests.filter(record=>record.variables.id===id||record.variables.input?.id===id)).includes('personal-only-draft'),false)
      assert.equal(JSON.stringify(provider.requests.filter(record=>record.variables.id===id||record.variables.input?.id===id)).includes('privatebodysecret'),false)
      assert.equal([...provider.comments.values()].some(comment=>comment.issue.id===id),false)
    } finally {hold.release();await request}
  })
  await scopeSubtest(t, 'old in-flight update cannot attach, publish edits or upload comments after explicit Mikka promotion',async()=>{
    const id=randomUUID();await seed(id);provider.issues.set(id,{...remote(id),updatedAt:'2020-01-01T00:00:00.000Z'})
    await setDiscussion(id,'old-publication-comment')
    const hold=provider.hold('MikkaLinearUpdateIssue'),old=processLinearIssueOutbox(id)
    try {
      await hold.arrived
      const oldPublication=(await pool.query('select * from linear_issue_publications where "issueId"=$1',[id])).rows[0]
      assert.ok(oldPublication)
      await privatize(id);await setDiscussion(id,'new-private-comment')
      const promoted=await republish(id)
      assert.equal(promoted.id,id);assert.equal(promoted.linearSyncBlocked,true)
      const before=provider.requests.length
      hold.release();await old
      // Requeue the actual retained first-generation job, rather than a new
      // INSERT rejected by the current gate. A stale claimant must not obtain
      // a usable claim or publish even after workspace scope returns.
      await pool.query('update linear_sync_outbox set status=\'queued\',"claimToken"=$2 where "issueId"=$1 and "scopeVersion"=1',[id,randomUUID()])
      assert.deepEqual((await pool.query('select status,"claimToken","scopeVersion" from linear_sync_outbox where "issueId"=$1 and "scopeVersion"=1',[id])).rows[0],{status:'failed',claimToken:null,scopeVersion:1})
      await pool.query('update issues set title=\'post-promotion-edit\' where id=$1',[id])
      await setDiscussion(id,'post-promotion-comment')
      assert.deepEqual(await action(()=>retryLinearIssue(id)),{error:'linearIssueInvalid'})
      await syncAppIssueToLinear(id);await processLinearIssueOutbox(id)
      assert.equal(provider.requests.length,before)
      assert.equal((await pool.query('select count(*)::int n from linear_issue_links where "issueId"=$1',[id])).rows[0].n,0)
      assert.equal((await pool.query('select count(*)::int n from linear_issue_publications where "issueId"=$1',[id])).rows[0].n,1)
      assert.equal((await pool.query('select "retiredAt" is not null retired from linear_issue_publications where id=$1',[oldPublication.id])).rows[0].retired,true)
      assert.equal(JSON.stringify(provider.requests).includes('privatebodysecret'),false)
      assert.equal(JSON.stringify(provider.requests).includes('post-promotion-edit'),false)
      assert.equal([...provider.comments.values()].some(comment=>comment.issue.id===id),false)
    } finally {hold.release();await old}
  })
  await scopeSubtest(t, 'late retired provider failure cannot attach a link or change later diagnostics',async()=>{
    const id=randomUUID();await seed(id);provider.issues.set(id,{...remote(id),updatedAt:'2020-01-01T00:00:00.000Z'})
    const hold=provider.hold('MikkaLinearUpdateIssue','after',true),old=processLinearIssueOutbox(id)
    try {
      await hold.arrived;await privatize(id);await republish(id)
      await pool.query('update linear_team_syncs set "lastError"=\'new-generation-diagnostic\' where id=$1',[sync])
      hold.release();await old
      assert.equal((await pool.query('select "lastError" from linear_team_syncs where id=$1',[sync])).rows[0].lastError,'new-generation-diagnostic')
      assert.equal((await pool.query('select count(*)::int n from linear_issue_links where "issueId"=$1',[id])).rows[0].n,0)
      assert.equal((await pool.query('select count(*)::int n from linear_issue_publications where "issueId"=$1',[id])).rows[0].n,1)
    } finally {hold.release();await old}
  })
  await scopeSubtest(t, 'webhook paused in HTTP cannot mutate promoted task or later diagnostics',async()=>{
    const id=randomUUID();await seed(id);provider.issues.set(id,{...remote(id),updatedAt:'2020-01-01T00:00:00.000Z'})
    const deliveryId=`held-webhook-${randomUUID()}`
    await pool.query('insert into linear_sync_inbox ("deliveryId","organizationId","eventType",payload) values ($1,\'synthetic\',\'Issue\',$2)',[deliveryId,JSON.stringify({type:'Issue',action:'update',organizationId:'synthetic',data:{id,teamId:team}})])
    const hold=provider.hold('MikkaLinearIssue'),inbox=processLinearInboxDelivery(deliveryId)
    try {
      await hold.arrived;await privatize(id);await republish(id)
      await pool.query('update linear_team_syncs set "lastError"=\'new-inbox-generation\' where id=$1',[sync])
      hold.release();await inbox
      assert.equal((await pool.query('select "lastError" from linear_team_syncs where id=$1',[sync])).rows[0].lastError,'new-inbox-generation')
      assert.equal((await pool.query('select count(*)::int n from linear_issue_links where "issueId"=$1',[id])).rows[0].n,0)
      assert.equal((await pool.query('select title from issues where id=$1',[id])).rows[0].title,'new-publication-title')
    } finally {hold.release();await inbox}
  })
  await scopeSubtest(t, 'no verified Linear target means promotion, editing, old claims and manual retry cannot publish',async()=>{
    const id=randomUUID();fixtureIds.push(id)
    await pool.query('insert into issues (id,"userId",title,content,status,priority,scope) values ($1,$2,\'Explicit team control\',$3,\'todo\',\'normal\',\'personal\')',[id,owner,doc])
    const before=provider.requests.length
    assert.deepEqual(await action(()=>setIssueScope({id,revision:1,scope:'workspace'})),{error:'issueScopeTeamRequired'})
    const result=await promoteExistingIssueForUser(owner,{requestId:randomUUID(),issueId:id,revision:1,teamId:team,expectedTeamId:null})
    assert.ok('issue' in result && result.issue);assert.equal(result.issue.linearSyncBlocked,true)
    assert.equal((await pool.query('select "scopeVersion" from issues where id=$1',[id])).rows[0].scopeVersion,2)
    await pool.query('update issues set title=\'blocked edit\' where id=$1',[id])
    await setDiscussion(id,'blocked comment')
    await pool.query('insert into linear_sync_outbox (id,"issueId","scopeVersion",status,"claimToken") values ($1,$2,1,\'processing\',$3)',[randomUUID(),id,randomUUID()])
    assert.deepEqual(await action(()=>retryLinearIssue(id)),{error:'linearIssueInvalid'})
    await processLinearIssueOutbox(id);await syncAppIssueToLinear(id)
    assert.equal((await pool.query('select count(*)::int n from linear_sync_outbox where "issueId"=$1',[id])).rows[0].n,0)
    assert.equal((await pool.query('select count(*)::int n from linear_issue_links where "issueId"=$1',[id])).rows[0].n,0)
    assert.equal((await pool.query('select count(*)::int n from linear_issue_publications where "issueId"=$1',[id])).rows[0].n,0)
    assert.equal(provider.requests.length,before)
  })
  await scopeSubtest(t, 'public retry revalidates retirement while waiting and makes no provider call',async()=>{
    const id=randomUUID();await seed(id)
    const lock=await pool.connect();let retry:Promise<unknown>|undefined
    try {
      await lock.query('begin');await lock.query('select id from issues where id=$1 for update',[id])
      retry=action(()=>retryLinearIssue(id))
      await waitFor(async()=>Boolean((await pool.query("select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%issues%for update%' and pid<>pg_backend_pid()")).rows[0]),'retry did not reach the task lock')
      await lock.query('update issues set scope=\'personal\',revision=revision+1 where id=$1',[id])
      const calls=provider.requests.length;await lock.query('commit')
      assert.deepEqual(await retry,{error:'linearIssueInvalid'});assert.equal(provider.requests.length,calls)
      assert.equal((await pool.query('select count(*)::int n from linear_sync_outbox where "issueId"=$1 and status<>\'done\'',[id])).rows[0].n,0)
    } finally {await lock.query('rollback');lock.release();if(retry) await retry}
  })
  await scopeSubtest(t, 'a retained uncertain publication independently gates public retirement',async()=>{
    const id=randomUUID();await seed(id,id,false)
    const publication=randomUUID()
    await pool.query('insert into linear_issue_publications (id,"issueId","ownerId","teamSyncId","scopeVersion","linearIssueId") values ($1,$2,$3,$4,1,$5)',[publication,id,owner,sync,randomUUID()])
    const calls=provider.requests.length
    assert.deepEqual(await actAs(owner,()=>setIssueScope({id,revision:1,scope:'personal'})),{error:'issueScopeInLinear'})
    assert.equal((await pool.query('select count(*)::int n from linear_issue_publications where id=$1',[publication])).rows[0].n,1)
    assert.deepEqual((await pool.query('select scope,revision from issues where id=$1',[id])).rows[0],{scope:'workspace',revision:1})
    assert.equal(provider.requests.length,calls)
  })
  await scopeSubtest(t, 'retained failed outbox alone gates retirement without a link or publication',async()=>{
    assert.equal((await pool.query('select count(*)::int n from linear_issue_links where "issueId"=$1',[legacyFailed])).rows[0].n,0)
    assert.equal((await pool.query('select count(*)::int n from linear_issue_publications where "issueId"=$1',[legacyFailed])).rows[0].n,0)
    assert.equal((await pool.query('select count(*)::int n from linear_sync_outbox where "issueId"=$1 and status=\'failed\'',[legacyFailed])).rows[0].n,1)
    assert.deepEqual(await actAs(owner,()=>setIssueScope({id:legacyFailed,revision:1,scope:'personal'})),{error:'issueScopeInLinear'})
  })
  await scopeSubtest(t, 'legacy generation 2 verified import is retried by the public action with generation 2',async()=>{
    provider.issues.set(legacyImported,{...remote(legacyImported),title:'Legacy imported task',updatedAt:'2020-01-01T00:00:00.000Z'})
    assert.equal((await pool.query('select count(*)::int n from linear_sync_outbox where "issueId"=$1 and status in (\'queued\',\'processing\',\'failed\')',[legacyImported])).rows[0].n,0)
    const calls=provider.requests.length
    assert.deepEqual(await action(()=>retryLinearIssue(legacyImported),async()=>{
      const job=(await pool.query('select "scopeVersion" from linear_sync_outbox where "issueId"=$1 and status=\'queued\'',[legacyImported])).rows[0]
      assert.equal(job.scopeVersion,2)
    }),{success:true})
    assert.ok(provider.requests.length>calls)
    const link=(await pool.query('select "linearIssueId","externalTargetVerified","syncStatus" from linear_issue_links where "issueId"=$1',[legacyImported])).rows[0]
    assert.deepEqual(link,{linearIssueId:legacyImported,externalTargetVerified:true,syncStatus:'synced'})
    assert.equal((await pool.query('select "scopeVersion" from linear_issue_publications where "issueId"=$1',[legacyImported])).rows[0].scopeVersion,2)
  })
  await scopeSubtest(t, 'manual retry reaches the explicitly imported verified target and retains its generation',async()=>{
    const id=randomUUID();await seed(id);provider.issues.set(id,{...remote(id),updatedAt:'2020-01-01T00:00:00.000Z'})
    await pool.query('update linear_sync_outbox set status=\'done\' where "issueId"=$1',[id])
    const calls=provider.requests.length
    assert.deepEqual(await action(()=>retryLinearIssue(id),async()=>{
      const job=(await pool.query('select "scopeVersion" from linear_sync_outbox where "issueId"=$1 and status=\'queued\'',[id])).rows[0]
      assert.equal(job.scopeVersion,1)
    }),{success:true})
    assert.ok(provider.requests.length>calls)
    const link=(await pool.query('select "linearIssueId","externalTargetVerified","syncStatus" from linear_issue_links where "issueId"=$1',[id])).rows[0]
    assert.deepEqual(link,{linearIssueId:id,externalTargetVerified:true,syncStatus:'synced'})
  })
  await scopeSubtest(t, 'a reclaimed outbox claim fences the old response and refreshes its snapshot after the writer lock',async()=>{
    const id=randomUUID();await seed(id);provider.issues.set(id,{...remote(id),updatedAt:'2020-01-01T00:00:00.000Z'})
    await pool.query('update linear_issue_links set "linearUpdatedAt"=\'2020-01-01T00:00:00Z\' where "issueId"=$1',[id])
    const hold=provider.hold('MikkaLinearUpdateIssue'),old=processLinearIssueOutbox(id)
    let reclaimed:Promise<void>|undefined
    try {
      await hold.arrived
      const token=(await pool.query('select "claimToken" from linear_sync_outbox where "issueId"=$1',[id])).rows[0].claimToken
      await pool.query('update issues set title=\'newer-same-generation\',"updatedAt"=now() where id=$1',[id])
      await pool.query('update linear_sync_outbox set "lastAttemptAt"=now()-interval \'6 minutes\' where "issueId"=$1',[id])
      reclaimed=processLinearIssueOutbox(id)
      await waitFor(async()=>Boolean((await pool.query('select 1 from linear_sync_outbox where "issueId"=$1 and "claimToken"<>$2',[id,token])).rows[0]),'new claim did not take ownership')
      hold.release();await old;await reclaimed
      assert.equal(provider.issues.get(id)?.title,'newer-same-generation')
      assert.equal((await pool.query('select "syncStatus" from linear_issue_links where "issueId"=$1',[id])).rows[0].syncStatus,'synced')
      assert.deepEqual((await pool.query('select status,attempts from linear_sync_outbox where "issueId"=$1',[id])).rows[0],{status:'done',attempts:2})
    } finally {hold.release();await Promise.allSettled([old,reclaimed].filter(Boolean))}
  })
  await pool.query('create table scope184_provider_evidence (payload jsonb not null)')
  await pool.query('insert into scope184_provider_evidence values ($1)',[JSON.stringify({requests:provider.requests,issues:[...provider.issues.values()],comments:[...provider.comments.values()]})])
  t.diagnostic(`Synthetic provider boundary: ${provider.requests.length} GraphQL calls redirected to loopback HTTP; retained in scope184_provider_evidence; no real Linear acceptance`)
  assert.equal(rejectedExternalRequests,0,'no real provider request is permitted or required')
  assert.equal((await pool.query('select scope from issues where id=$1',[issue])).rows[0].scope,'personal')
  assert.equal((await pool.query('select count(*)::int n from linear_issue_detachments where "issueId"=$1',[issue])).rows[0].n,1)
  t.diagnostic(`Synthetic fixtures retained: ${JSON.stringify({database,owner,member,workspace,team,fixtureIds,memberRun,ownerRun})}`)
})
