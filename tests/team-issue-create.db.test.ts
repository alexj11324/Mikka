import 'next/dist/server/node-environment-baseline'
import './fixtures/team-auth-runtime.mjs'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { promisify } from 'node:util'
import test from 'node:test'

const url = process.env.E2E_DATABASE_URL
if (url) {
  const target = new URL(url)
  const ci = process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true' && target.port === '5432' && target.pathname === '/mikka_e2e'
  const cloud = process.env.ISSUE184_LOCAL_TEST === '1' && target.port === '55484' && target.pathname === '/issue184_e2e'
  if (target.hostname !== '127.0.0.1' || (!ci && !cloud) || target.search || target.hash || process.env.MIKKA_DATABASE_URL !== url || process.env.DATABASE_URL !== url) throw new Error('Team task tests require the isolated PG17 service')
}
if (!url && process.env.REQUIRE_DB === '1') throw new Error('Team task DB tests cannot skip in required CI')

test('explicit team task creation across two real PostgreSQL databases', { skip: !url }, async t => {
  const { Pool } = await import('pg')
  const suffix=randomUUID().replaceAll('-',''), appName=`team184_app_${suffix}_e2e`, workspaceName=`team184_workspace_${suffix}_e2e`
  const admin=new Pool({connectionString:url,max:1})
  try { await admin.query(`create database "${appName}"`);await admin.query(`create database "${workspaceName}"`) } finally {await admin.end()}
  const appUrl=new URL(url!), workspaceUrl=new URL(url!);appUrl.pathname=`/${appName}`;workspaceUrl.pathname=`/${workspaceName}`
  process.env.MIKKA_DATABASE_URL=appUrl.toString();process.env.DATABASE_URL=workspaceUrl.toString()
  await promisify(execFile)(process.execPath,['scripts/migrate.mjs'],{env:{...process.env,MIGRATE:'1',VERCEL_ENV:''},maxBuffer:4<<20})
  const app=new Pool({connectionString:appUrl.toString(),max:5}), workspace=new Pool({connectionString:workspaceUrl.toString(),max:6})
  const originalFetch=globalThis.fetch;let externalCalls=0
  globalThis.fetch=(async(input,init)=>{ const target=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url); if(target.hostname==='127.0.0.1') return originalFetch(input,init); externalCalls++;throw new Error('Real provider requests prohibited') }) as typeof fetch
  t.after(async()=>{globalThis.fetch=originalFetch;await Promise.all([app.end(),workspace.end()])})
  const {actAs}=await import('../lib/acting-user')
  const {agentActor,userActor}=await import('../lib/activity-actor')
  const {workspaceDb}=await import('../lib/workspace-db')
  const {db}=await import('../lib/db')
  const {teamIssueCreateRequests}=await import('../lib/db/schema')
  const {createIssueForUserInTransaction}=await import('../lib/issue-create')
  const {issueForUser}=await import('../lib/issue-access')
  const {createIssueForTeam,promoteIssueToTeam,setIssueScope,saveIssue}=await import('../app/actions/issues')
  const {exchangeDocument}=await import('../app/actions/collaboration')
  const {AfterContext}=await import('next/dist/server/after/after-context')
  const {workAsyncStorage}=await import('next/dist/server/app-render/work-async-storage.external')
  const Y=await import('yjs')
  async function withAfter<T>(fn:()=>Promise<T>) {
    const waits:Promise<unknown>[]=[],errors:unknown[]=[];let close=()=>{}
    const afterContext=new AfterContext({waitUntil:promise=>{waits.push(promise)},onClose:callback=>{close=callback},onTaskError:error=>{errors.push(error)}})
    return workAsyncStorage.run({afterContext} as NonNullable<ReturnType<typeof workAsyncStorage.getStore>>,async()=>{
      try{return await fn()}finally{close();await Promise.all(waits);assert.deepEqual(errors,[])}
    })
  }
  const {retryLinearIssue}=await import('../app/actions/linear-sync')
  const {syncAppIssueToLinear}=await import('../lib/linear-sync/issue-sync')
  const {processLinearIssueOutbox}=await import('../lib/linear-sync/worker')
  const owner=`team-owner-${randomUUID()}`, racer=`team-racer-${randomUUID()}`, stranger=`team-stranger-${randomUUID()}`
  const workspaceId=randomUUID(), teamId=randomUUID(), raceTeam=randomUUID(), badTeam=randomUUID()
  for(const user of [owner,racer,stranger]) await app.query('insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values ($1,\'Synthetic\',$2,true,now(),now())',[user,`${user}@example.invalid`])
  await app.query('insert into linear_team_syncs (id,"ownerId","linearTeamId","linearTeamKey","linearTeamName") values ($1,$2,$3,\'EXT\',\'Other external team\')',[randomUUID(),owner,randomUUID()])
  await workspace.query('insert into mikka_workspaces (id,"userId",name) values ($1,$2,\'Synthetic team workspace\')',[workspaceId,owner])
  for(const user of [owner,racer]) await workspace.query('insert into mikka_workspace_members ("workspaceId","userId",name,email,role,status) values ($1,$2,\'Synthetic\',$3,\'member\',\'active\')',[workspaceId,user,`${user}@example.invalid`])
  for(const [id,key] of [[teamId,'OK'],[raceTeam,'RACE'],[badTeam,'FAIL']]) await workspace.query('insert into mikka_teams (id,"workspaceId","userId",name,identifier) values ($1,$2,$3,\'Synthetic\',$4)',[id,workspaceId,owner,key])
  await app.query(`create table team184_app_controls (title text primary key, fail boolean not null, "failCreate" boolean not null default false)`)
  await app.query(`create function team184_fail_promotion() returns trigger language plpgsql as $$ begin if new.scope='workspace' and exists(select 1 from team184_app_controls where title=new.title and fail) then raise exception 'synthetic promotion failure'; end if; return new; end $$`)
  await app.query('create trigger team184_fail_promotion before update of scope on issues for each row execute function team184_fail_promotion()')
  await app.query(`create function team184_fail_create() returns trigger language plpgsql as $$ begin if exists(select 1 from team184_app_controls where title=new.title and "failCreate") then raise exception 'synthetic creation failure'; end if; return new; end $$`)
  await app.query('create trigger team184_fail_create before insert on issue_versions for each row execute function team184_fail_create()')
  const content={type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'synthetic task'}]}]}
  const input=(team:string)=>({requestId:randomUUID(),teamId:team,title:'Explicit team task',content,status:'todo',priority:'normal'})
  const testGlobals=globalThis as typeof globalThis & {teamCreateTestUser?:string}
  const query=(who:string,value:ReturnType<typeof input>)=>{testGlobals.teamCreateTestUser=who;return createIssueForTeam(value)}
  await workspace.query(`create table team184_controls ("teamId" uuid primary key, fail boolean not null default false, pause boolean not null default false)`)
  await workspace.query(`create function team184_inject() returns trigger language plpgsql as $$ begin
    if exists(select 1 from team184_controls where "teamId"=new."teamId" and fail) then raise exception 'synthetic association failure'; end if;
    if exists(select 1 from team184_controls where "teamId"=new."teamId" and pause) then perform pg_advisory_xact_lock(hashtextextended('team184-barrier',0)); end if;
    return new; end $$`)
  await workspace.query('create trigger team184_inject before insert on mikka_team_issues for each row execute function team184_inject()')
  await t.test('save, legacy scope click, title/document writes and manual retry keep personal data out of Linear',async()=>{
    const created=await withAfter(()=>actAs(owner,()=>saveIssue({title:'Legacy UI task',content,status:'todo',priority:'normal'})))
    assert.ok('issue' in created && created.issue);const id=created.issue.id
    await workspace.query('insert into mikka_team_issues ("issueId","teamId","workspaceId","userId") values ($1,$2,$3,$4)',[id,teamId,workspaceId,owner])
    // The real legacy UI passes only these three fields, no explicit target.
    assert.deepEqual(await actAs(owner,()=>setIssueScope({id,revision:created.issue.revision,scope:'workspace'})),{error:'issueScopeTeamRequired'})
    const updated=await withAfter(()=>actAs(owner,()=>saveIssue({id,revision:created.issue.revision,title:'Private revised title',content,status:'todo',priority:'normal'})))
    assert.ok('issue' in updated && updated.issue);assert.equal(updated.issue.scope,'personal')
    const ydoc=new Y.Doc()
    try {
      const seed=Buffer.from(Y.encodeStateAsUpdate(ydoc)).toString('base64')
      await withAfter(()=>actAs(owner,()=>exchangeDocument({id,seed})))
    } finally {ydoc.destroy()}
    assert.deepEqual(await actAs(owner,()=>retryLinearIssue(id)),{error:'linearIssueInvalid'})
    await syncAppIssueToLinear(id);await processLinearIssueOutbox(id)
    assert.equal((await app.query('select scope from issues where id=$1',[id])).rows[0].scope,'personal')
    for(const table of ['linear_sync_outbox','linear_issue_publications','linear_issue_links']) {
      assert.equal((await app.query(`select count(*)::int n from ${table} where "issueId"=$1`,[id])).rows[0].n,0)
    }
    assert.equal(externalCalls,0)
  })
  await t.test('existing personal task requires explicit authorized team, preserves identity and never publishes',async()=>{
    testGlobals.teamCreateTestUser=owner
    const created=await withAfter(()=>saveIssue({title:'Promote existing private task',content,status:'todo',priority:'normal'}))
    assert.ok('issue' in created && created.issue)
    const original=created.issue
    const request={requestId:randomUUID(),issueId:original.id,revision:original.revision,teamId,expectedTeamId:null}
    testGlobals.teamCreateTestUser=stranger
    assert.deepEqual(await promoteIssueToTeam(request),{error:'teamIssueAccessDenied',requestId:request.requestId})
    testGlobals.teamCreateTestUser=owner
    assert.deepEqual(await promoteIssueToTeam({...request,revision:original.revision+1}),{error:'teamIssueChanged',requestId:request.requestId})
    const result=await promoteIssueToTeam(request)
    assert.ok('issue' in result && result.issue);assert.equal(result.issue.id,original.id);assert.equal(result.issue.userId,owner)
    assert.equal(result.issue.scope,'workspace');assert.equal(result.issue.linearSyncBlocked,true);assert.equal(result.issue.title,original.title)
    assert.deepEqual(result.issue.content,original.content);assert.deepEqual(result.linearSync,{enabled:false,reason:'no_explicit_target'})
    const repeat=await promoteIssueToTeam(request);assert.ok('issue' in repeat && repeat.issue);assert.equal(repeat.issue.id,original.id)
    await app.query('update issues set title=\'Promoted title update\' where id=$1',[original.id])
    await syncAppIssueToLinear(original.id);await processLinearIssueOutbox(original.id)
    for(const table of ['linear_sync_outbox','linear_issue_publications','linear_issue_links']) assert.equal((await app.query(`select count(*)::int n from ${table} where "issueId"=$1`,[original.id])).rows[0].n,0)
    assert.equal((await workspace.query('select count(*)::int n from team_issue_promotion_receipts where "requestId"=$1',[request.requestId])).rows[0].n,1)
    await workspace.query('update mikka_team_issues set "teamId"=$2 where "issueId"=$1',[original.id,badTeam])
    assert.deepEqual(await promoteIssueToTeam(request),{error:'teamIssueChanged',requestId:request.requestId})
    assert.equal((await workspace.query('select "teamId" from mikka_team_issues where "issueId"=$1',[original.id])).rows[0].teamId,badTeam)
    assert.equal(externalCalls,0)
  })
  await t.test('existing task lost workspace commit response retains personal state and resumes same receipt',async()=>{
    testGlobals.teamCreateTestUser=owner
    const created=await withAfter(()=>saveIssue({title:'Existing task lost response',content,status:'todo',priority:'normal'}))
    assert.ok('issue' in created && created.issue);const id=created.issue.id
    const request={requestId:randomUUID(),issueId:id,revision:created.issue.revision,teamId,expectedTeamId:null}
    const target=workspaceDb as unknown as {transaction:(...args:unknown[])=>Promise<unknown>}, original=target.transaction
    let mode:'lost'|'unavailable'|'normal'='lost'
    target.transaction=async (...args:unknown[])=>{if(mode==='unavailable') throw new Error('synthetic unavailable');const result=await original.apply(workspaceDb,args);if(mode==='lost'){mode='unavailable';throw new Error('synthetic lost response')}return result}
    try {
      assert.deepEqual(await promoteIssueToTeam(request),{error:'teamIssueRetry',requestId:request.requestId})
      assert.deepEqual((await app.query('select scope,"linearSyncBlocked" from issues where id=$1',[id])).rows[0],{scope:'personal',linearSyncBlocked:true})
      assert.ok(await issueForUser(owner,id));assert.equal(await issueForUser(racer,id),null)
      assert.deepEqual(await promoteIssueToTeam(request),{error:'teamIssueRetry',requestId:request.requestId})
      mode='normal';const result=await promoteIssueToTeam(request);assert.ok('issue' in result && result.issue);assert.equal(result.issue.id,id);assert.equal(result.issue.scope,'workspace')
      assert.equal((await workspace.query('select count(*)::int n from team_issue_promotion_receipts where "requestId"=$1',[request.requestId])).rows[0].n,1)
      assert.equal((await app.query('select count(*)::int n from linear_sync_outbox where "issueId"=$1',[id])).rows[0].n,0)
    } finally {target.transaction=original}
  })
  await t.test('revocation after existing-task relation commit prevents promotion',async()=>{
    const revoked=`promotion-owner-${randomUUID()}`
    await app.query('insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values ($1,\'Synthetic\',$2,true,now(),now())',[revoked,`${revoked}@example.invalid`])
    await workspace.query('insert into mikka_workspace_members ("workspaceId","userId",name,email,role,status) values ($1,$2,\'Synthetic\',$3,\'member\',\'active\')',[workspaceId,revoked,`${revoked}@example.invalid`])
    testGlobals.teamCreateTestUser=revoked
    const created=await withAfter(()=>saveIssue({title:'Existing revoked promotion',content,status:'todo',priority:'normal'}))
    assert.ok('issue' in created && created.issue);const id=created.issue.id
    const request={requestId:randomUUID(),issueId:id,revision:created.issue.revision,teamId,expectedTeamId:null}
    const target=workspaceDb as unknown as {transaction:(...args:unknown[])=>Promise<unknown>},original=target.transaction
    let first=true
    target.transaction=async (...args:unknown[])=>{const value=await original.apply(workspaceDb,args);if(first){first=false;await workspace.query('update mikka_workspace_members set status=\'inactive\' where "workspaceId"=$1 and "userId"=$2',[workspaceId,revoked])}return value}
    try {
      assert.deepEqual(await promoteIssueToTeam(request),{error:'teamIssueAccessDenied',requestId:request.requestId})
      assert.deepEqual((await app.query('select scope,"linearSyncBlocked" from issues where id=$1',[id])).rows[0],{scope:'personal',linearSyncBlocked:true})
      assert.ok(await issueForUser(revoked,id));assert.equal(await issueForUser(racer,id),null)
      assert.equal((await app.query('select count(*)::int n from linear_sync_outbox where "issueId"=$1',[id])).rows[0].n,0)
    } finally {target.transaction=original}
  })
  await t.test('MCP creation ignores a spoofed scope or team context and stays personal',async()=>{
    const {createIssue}=await import('../lib/mcp/actions')
    const input={title:'MCP scope spoof',body:'ambiguous work',scope:'workspace',teamId} as Parameters<typeof createIssue>[1]
    const created=await withAfter(()=>createIssue(owner,input,agentActor(randomUUID())))
    assert.ok('id' in created)
    const row=(await app.query('select scope,"linearSyncBlocked" from issues where id=$1',[created.id])).rows[0]
    assert.deepEqual(row,{scope:'personal',linearSyncBlocked:false})
    for(const table of ['linear_sync_outbox','linear_issue_publications','linear_issue_links']) assert.equal((await app.query(`select count(*)::int n from ${table} where "issueId"=$1`,[created.id])).rows[0].n,0)
    assert.equal(externalCalls,0)
  })
  await t.test('legacy scope UI/action cannot promote even when a team relation or active Linear team exists',async()=>{
    const id=randomUUID()
    await app.query('insert into issues (id,"userId",title,content,status,priority,scope) values ($1,$2,\'Legacy scope action\',$3,\'todo\',\'normal\',\'personal\')',[id,owner,JSON.stringify(content)])
    // An existing association is context, not proof that this call explicitly
    // selected and authorized a destination.
    await workspace.query('insert into mikka_team_issues ("issueId","teamId","workspaceId","userId") values ($1,$2,$3,$4)',[id,teamId,workspaceId,owner])
    assert.deepEqual(await actAs(owner,()=>setIssueScope({id,revision:1,scope:'workspace'})),{error:'issueScopeTeamRequired'})
    assert.deepEqual((await app.query('select scope,"linearSyncBlocked" from issues where id=$1',[id])).rows[0],{scope:'personal',linearSyncBlocked:false})
    assert.equal((await app.query('select count(*)::int n from linear_sync_outbox where "issueId"=$1',[id])).rows[0].n,0)
    assert.equal((await app.query('select count(*)::int n from linear_issue_publications where "issueId"=$1',[id])).rows[0].n,0)
    // Reproduce an old application instance attempting the former DB write.
    await assert.rejects(app.query('update issues set scope=\'workspace\',"scopeSetBy"=\'user\' where id=$1',[id]),(error:unknown)=>(error as {code:string}).code==='23514')
    // A blocked but incomplete team create is also not sufficient: only the
    // verified transaction holding current team locks can promote it.
    await app.query('update issues set "linearSyncBlocked"=true where id=$1',[id])
    await assert.rejects(app.query('update issues set scope=\'workspace\',"scopeSetBy"=\'user\' where id=$1',[id]),(error:unknown)=>(error as {code:string}).code==='23514')
    const forged=await app.connect()
    try {
      await forged.query('begin')
      await forged.query("select set_config('mikka.team_scope_verified',$1,true),set_config('mikka.team_scope_team',$2,true)",[id,teamId])
      // A marker alone is insufficient without the matching pending request.
      await assert.rejects(forged.query('update issues set scope=\'workspace\',"scopeSetBy"=\'user\' where id=$1',[id]),(error:unknown)=>(error as {code:string}).code==='23514')
    } finally {await forged.query('rollback');forged.release()}
    assert.equal((await app.query('select scope from issues where id=$1',[id])).rows[0].scope,'personal')
    assert.equal(externalCalls,0)
  })
  await t.test('an unlinked legacy workspace task never infers the owner active Linear team',async()=>{
    const id=randomUUID()
    await app.query('insert into issues (id,"userId",title,content,status,priority,scope) values ($1,$2,\'Unlinked legacy workspace\',$3,\'todo\',\'normal\',\'workspace\')',[id,owner,JSON.stringify(content)])
    await app.query('update issues set title=\'Unlinked legacy update\' where id=$1',[id])
    await app.query('insert into issue_documents ("issueId","userId",state) values ($1,$2,\'synthetic\')',[id,owner])
    await app.query('insert into linear_sync_outbox (id,"issueId","scopeVersion") values ($1,$2,1)',[randomUUID(),id])
    assert.equal((await app.query('select count(*)::int n from linear_sync_outbox where "issueId"=$1',[id])).rows[0].n,0)
    assert.deepEqual(await actAs(owner,()=>retryLinearIssue(id)),{error:'linearIssueInvalid'})
    await assert.rejects(syncAppIssueToLinear(id),/No verified Linear issue link/)
    assert.equal((await app.query('select count(*)::int n from linear_issue_publications where "issueId"=$1',[id])).rows[0].n,0)
    assert.equal((await app.query('select count(*)::int n from linear_issue_links where "issueId"=$1',[id])).rows[0].n,0)
    assert.equal(externalCalls,0)
    // An unacknowledged old reservation is preserved, not treated as explicit
    // consent and not removed or used to infer a provider destination.
    const team=(await app.query('select id from linear_team_syncs where "ownerId"=$1',[owner])).rows[0].id
    const publication=randomUUID(),remote=randomUUID()
    await app.query('insert into linear_issue_publications (id,"issueId","ownerId","teamSyncId","scopeVersion","linearIssueId") values ($1,$2,$3,$4,1,$5)',[publication,id,owner,team,remote])
    await assert.rejects(syncAppIssueToLinear(id),/No verified Linear issue link/)
    await assert.rejects(app.query('insert into linear_issue_links (id,"issueId","ownerId","teamSyncId","linearIssueId","linearIdentifier","externalTargetVerified") values ($1,$2,$3,$4,$5,\'EXT-2\',true)',[randomUUID(),id,owner,team,remote]),(error:unknown)=>(error as {code:string}).code==='23514')
    await app.query('insert into linear_issue_links (id,"issueId","ownerId","teamSyncId","linearIssueId","linearIdentifier") values ($1,$2,$3,$4,$5,\'EXT-2\')',[randomUUID(),id,owner,team,remote])
    assert.equal((await app.query('select "externalTargetVerified" from linear_issue_links where "issueId"=$1',[id])).rows[0].externalTargetVerified,false)
    await assert.rejects(syncAppIssueToLinear(id),/No verified Linear issue link/)
    await app.query('update issues set title=\'Unverified linked update\' where id=$1',[id])
    assert.equal((await app.query('select count(*)::int n from linear_sync_outbox where "issueId"=$1',[id])).rows[0].n,0)
    assert.equal((await app.query('select count(*)::int n from linear_issue_publications where id=$1',[publication])).rows[0].n,1)
    assert.equal(externalCalls,0)
  })
  await t.test('an explicitly imported external task retains its verified link and can enqueue',async()=>{
    const remoteId=randomUUID()
    const {linearTeamSyncs}=await import('../lib/db/schema')
    const {eq}=await import('drizzle-orm')
    const [team]=await db.select().from(linearTeamSyncs).where(eq(linearTeamSyncs.ownerId,owner)).limit(1)
    const remote={id:remoteId,identifier:'EXT-1',title:'Existing imported workspace',description:'Synthetic',dueDate:null,priority:0,url:'https://example.invalid/synthetic',updatedAt:new Date().toISOString(),state:null,team:{id:team.linearTeamId,key:team.linearTeamKey,name:team.linearTeamName},assignee:null,labels:[]}
    const {createAppIssueFromLinear}=await import('../lib/linear-sync/issue-sync')
    const imported=await createAppIssueFromLinear(team,remote);assert.ok(imported)
    const id=imported.id
    assert.equal((await app.query('select "externalTargetVerified" from linear_issue_links where "issueId"=$1',[id])).rows[0].externalTargetVerified,true)
    await app.query('update issues set title=\'Authorized linked update\' where id=$1',[id])
    assert.equal((await app.query('select count(*)::int n from linear_sync_outbox where "issueId"=$1 and status=\'queued\'',[id])).rows[0].n,1)
    const {reserveLinearPublication}=await import('../lib/linear-sync/publication')
    const reserved=await reserveLinearPublication(id)
    assert.ok(reserved);assert.equal(reserved.publication.linearIssueId,remoteId);assert.equal(reserved.team.id,team.id)
    // Emulate a link losing verification while an old queued worker exists.
    // The DB claim fence keeps the row as failed and never releases a token.
    await app.query('update linear_issue_links set "externalTargetVerified"=false where "issueId"=$1',[id])
    await processLinearIssueOutbox(id)
    const pending=(await app.query('select status,"claimToken","lastError" from linear_sync_outbox where "issueId"=$1',[id])).rows[0]
    assert.equal(pending.status,'failed');assert.equal(pending.claimToken,null);assert.match(pending.lastError,/No active verified Linear/)
    assert.equal((await app.query('select count(*)::int n from linear_issue_links where "issueId"=$1',[id])).rows[0].n,1)
    assert.equal(externalCalls,0)
  })
  await t.test('explicit authorized team succeeds once with durable provider gate and no outbox',async()=>{
    const value=input(teamId), result=await query(owner,value)
    assert.ok('issue' in result && result.issue);assert.equal(result.issue.scope,'workspace');assert.deepEqual(result.linearSync,{enabled:false,reason:'no_explicit_target'});assert.equal(result.issue.linearSyncBlocked,true)
    const id=result.issue.id
    const repeated=await query(owner,value);assert.ok('issue' in repeated && repeated.issue);assert.equal(repeated.issue.id,id)
    assert.equal((await workspace.query('select count(*)::int n from mikka_team_issues where "issueId"=$1 and "teamId"=$2',[id,teamId])).rows[0].n,1)
    assert.equal((await app.query('select count(*)::int n from team_issue_create_requests where "requestId"=$1',[value.requestId])).rows[0].n,1)
    assert.deepEqual((await app.query('select scope,"linearSyncBlocked" from issues where id=$1',[id])).rows[0],{scope:'workspace',linearSyncBlocked:true})
    await app.query('update issues set title=\'changed after creation\' where id=$1',[id])
    await app.query('insert into linear_sync_outbox (id,"issueId","scopeVersion") values ($1,$2,2)',[randomUUID(),id])
    await app.query('insert into issue_documents ("issueId","userId",state) values ($1,$2,\'synthetic\')',[id,owner])
    const externalTeam=(await app.query('select id from linear_team_syncs where "ownerId"=$1',[owner])).rows[0].id
    await assert.rejects(app.query('insert into linear_issue_links (id,"issueId","ownerId","teamSyncId","linearIssueId","linearIdentifier") values ($1,$2,$3,$4,$5,\'EXT-1\')',[randomUUID(),id,owner,externalTeam,randomUUID()]),(error:unknown)=>(error as {code:string}).code==='23514')
    await syncAppIssueToLinear(id);await processLinearIssueOutbox(id)
    assert.deepEqual(await actAs(owner,()=>retryLinearIssue(id)),{error:'linearIssueInvalid'})
    assert.equal((await app.query('select count(*)::int n from linear_sync_outbox where "issueId"=$1',[id])).rows[0].n,0)
    assert.equal((await app.query('select count(*)::int n from linear_issue_publications where "issueId"=$1',[id])).rows[0].n,0)
    await assert.rejects(app.query('update issues set "linearSyncBlocked"=false where id=$1',[id]),(error:unknown)=>(error as {code:string}).code==='23514')
    assert.deepEqual(await query(owner,{...value,title:'different replay'}),{error:'teamIssueRequestConflict',requestId:value.requestId})
    assert.deepEqual(await actAs(owner,()=>createIssueForTeam(input(teamId)),agentActor(randomUUID())),{error:'teamIssueAccessDenied'})
    assert.equal(externalCalls,0)
    await workspace.query('update mikka_team_issues set "teamId"=$2 where "issueId"=$1',[id,badTeam])
    assert.deepEqual(await query(owner,value),{error:'teamIssueChanged',requestId:value.requestId})
    assert.equal((await workspace.query('select "teamId" from mikka_team_issues where "issueId"=$1',[id])).rows[0].teamId,badTeam)
  })
  await t.test('concurrent replays create one issue and one team association',async()=>{
    const value=input(teamId)
    const results=await Promise.all([query(owner,value),query(owner,value),query(owner,value)])
    for(const result of results) assert.ok('issue' in result && result.issue)
    const ids=results.map(result=>'issue' in result && result.issue?.id)
    assert.equal(new Set(ids).size,1)
    assert.equal((await app.query('select count(*)::int n from team_issue_create_requests where "requestId"=$1',[value.requestId])).rows[0].n,1)
    assert.equal((await workspace.query('select count(*)::int n from team_issue_create_receipts where "requestId"=$1',[value.requestId])).rows[0].n,1)
  })
  await t.test('failed initial app transaction creates no partial issue or association',async()=>{
    const value={...input(teamId),title:`creation-failure-${randomUUID()}`}
    await app.query('insert into team184_app_controls (title,fail,"failCreate") values ($1,false,true)',[value.title])
    assert.deepEqual(await query(owner,value),{error:'teamIssueRetry',requestId:value.requestId})
    assert.equal((await app.query('select count(*)::int n from team_issue_create_requests where "requestId"=$1',[value.requestId])).rows[0].n,0)
    assert.equal((await app.query('select count(*)::int n from issues where title=$1',[value.title])).rows[0].n,0)
    assert.equal((await workspace.query('select count(*)::int n from team_issue_create_receipts where "requestId"=$1',[value.requestId])).rows[0].n,0)
    await app.query('update team184_app_controls set "failCreate"=false where title=$1',[value.title])
    const retried=await query(owner,value);assert.ok('issue' in retried && retried.issue);assert.equal(retried.issue.scope,'workspace')
  })
  await t.test('actual loopback HTTP invokes the public action and returns the blocked sync status',async()=>{
    const server=createServer(async(req,res)=>{
      try {
        const parts:Buffer[]=[];for await(const part of req) parts.push(Buffer.from(part))
        const value=JSON.parse(Buffer.concat(parts).toString()) as ReturnType<typeof input>
        const result=await query(owner,value);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result))
      } catch {res.writeHead(500);res.end()}
    })
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
    try {
      const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`
      const response=await fetch(`${origin}/synthetic-team-create`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input(teamId))})
      assert.equal(response.status,200)
      const result=await response.json() as {issue:{id:string;scope:string;linearSyncBlocked:boolean};linearSync:{enabled:boolean;reason:string}}
      assert.equal(result.issue.scope,'workspace');assert.equal(result.issue.linearSyncBlocked,true);assert.deepEqual(result.linearSync,{enabled:false,reason:'no_explicit_target'})
      assert.equal((await app.query('select count(*)::int n from linear_sync_outbox where "issueId"=$1',[result.issue.id])).rows[0].n,0)
    } finally {await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}
  })
  await t.test('unauthorized team is rejected before an issue or request is created',async()=>{
    const value=input(teamId)
    assert.deepEqual(await query(stranger,value),{error:'teamIssueAccessDenied',requestId:value.requestId})
    assert.equal((await app.query('select count(*)::int n from team_issue_create_requests where "requestId"=$1',[value.requestId])).rows[0].n,0)
  })
  await t.test('failed workspace relation leaves a retained private issue and retry completes without duplication',async()=>{
    await workspace.query('insert into team184_controls ("teamId",fail) values ($1,true)',[badTeam])
    const value=input(badTeam), failed=await query(owner,value)
    assert.deepEqual(failed,{error:'teamIssueRetry',requestId:value.requestId})
    const before=(await app.query('select i.id,i.scope,i."linearSyncBlocked" from issues i join team_issue_create_requests r on r."issueId"=i.id where r."requestId"=$1',[value.requestId])).rows[0]
    assert.equal(before.scope,'personal');assert.equal(before.linearSyncBlocked,true)
    assert.equal((await workspace.query('select count(*)::int n from mikka_team_issues where "issueId"=$1',[before.id])).rows[0].n,0)
    await workspace.query('update team184_controls set fail=false where "teamId"=$1',[badTeam])
    const retried=await query(owner,value);assert.ok('issue' in retried && retried.issue);assert.equal(retried.issue.id,before.id);assert.equal(retried.issue.scope,'workspace')
    assert.equal((await app.query('select count(*)::int n from team_issue_create_requests where "requestId"=$1',[value.requestId])).rows[0].n,1)
  })
  await t.test('failed promotion after association remains private and resumes the same request',async()=>{
    const value={...input(teamId),title:`promotion-failure-${randomUUID()}`}
    await app.query('insert into team184_app_controls (title,fail) values ($1,true)',[value.title])
    assert.deepEqual(await query(owner,value),{error:'teamIssueRetry',requestId:value.requestId})
    const row=(await app.query('select i.id,i.scope,i."linearSyncBlocked" from issues i join team_issue_create_requests r on r."issueId"=i.id where r."requestId"=$1',[value.requestId])).rows[0]
    assert.equal(row.scope,'personal');assert.equal(row.linearSyncBlocked,true)
    assert.equal((await workspace.query('select count(*)::int n from mikka_team_issues where "issueId"=$1',[row.id])).rows[0].n,1)
    assert.equal((await app.query('select count(*)::int n from linear_sync_outbox where "issueId"=$1',[row.id])).rows[0].n,0)
    await app.query('update team184_app_controls set fail=false where title=$1',[value.title])
    const resumed=await query(owner,value);assert.ok('issue' in resumed && resumed.issue);assert.equal(resumed.issue.id,row.id);assert.equal(resumed.issue.scope,'workspace')
    await app.query('update issues set scope=\'personal\',revision=revision+1 where id=$1',[row.id])
    const replay=await query(owner,value);assert.ok('issue' in replay && replay.issue);assert.equal(replay.issue.scope,'personal')
    assert.equal((await app.query('select count(*)::int n from linear_sync_outbox where "issueId"=$1',[row.id])).rows[0].n,0)
  })
  await t.test('a changed relation while pending is not restored by retry',async()=>{
    const value={...input(teamId),title:`changed-pending-${randomUUID()}`}
    await app.query('insert into team184_app_controls (title,fail) values ($1,true)',[value.title])
    assert.deepEqual(await query(owner,value),{error:'teamIssueRetry',requestId:value.requestId})
    const row=(await app.query('select i.id,i.scope from issues i join team_issue_create_requests r on r."issueId"=i.id where r."requestId"=$1',[value.requestId])).rows[0]
    await workspace.query('update mikka_team_issues set "teamId"=$2 where "issueId"=$1',[row.id,badTeam])
    await app.query('update team184_app_controls set fail=false where title=$1',[value.title])
    assert.deepEqual(await query(owner,value),{error:'teamIssueChanged',requestId:value.requestId})
    assert.equal((await workspace.query('select "teamId" from mikka_team_issues where "issueId"=$1',[row.id])).rows[0].teamId,badTeam)
    assert.equal((await app.query('select scope from issues where id=$1',[row.id])).rows[0].scope,'personal')
  })
  await t.test('lost workspace commit response retries one request and preserves private visibility until promotion',async()=>{
    const value=input(teamId)
    const target=workspaceDb as unknown as {transaction:(...args:unknown[])=>Promise<unknown>}
    const original=target.transaction
    let mode:'lost'|'unavailable'|'normal'='lost'
    // Throw only after the real first workspace transaction has committed.
    // The next attempt simulates an unavailable workspace recheck without
    // changing or deleting a fixture; restoring the method permits recovery.
    target.transaction=async (...args:unknown[])=>{
      if(mode==='unavailable') throw new Error('synthetic workspace recheck unavailable')
      const result=await original.apply(workspaceDb,args)
      if(mode==='lost') {mode='unavailable';throw new Error('synthetic lost commit response')}
      return result
    }
    try {
      assert.deepEqual(await query(owner,value),{error:'teamIssueRetry',requestId:value.requestId})
      const row=(await app.query('select i.id,i.scope,i."linearSyncBlocked" from issues i join team_issue_create_requests r on r."issueId"=i.id where r."requestId"=$1',[value.requestId])).rows[0]
      assert.equal(row.scope,'personal');assert.equal(row.linearSyncBlocked,true)
      assert.equal((await workspace.query('select count(*)::int n from team_issue_create_receipts where "requestId"=$1',[value.requestId])).rows[0].n,1)
      assert.equal((await workspace.query('select count(*)::int n from mikka_team_issues where "issueId"=$1',[row.id])).rows[0].n,1)
      assert.ok(await issueForUser(owner,row.id));assert.equal(await issueForUser(racer,row.id),null)
      assert.deepEqual(await query(owner,value),{error:'teamIssueRetry',requestId:value.requestId})
      assert.equal((await app.query('select scope from issues where id=$1',[row.id])).rows[0].scope,'personal')
      assert.equal((await app.query('select count(*)::int n from linear_sync_outbox where "issueId"=$1',[row.id])).rows[0].n,0)
      mode='normal'
      const recovered=await query(owner,value);assert.ok('issue' in recovered && recovered.issue);assert.equal(recovered.issue.id,row.id);assert.equal(recovered.issue.scope,'workspace')
      assert.equal((await app.query('select count(*)::int n from team_issue_create_requests where "requestId"=$1',[value.requestId])).rows[0].n,1)
      assert.equal((await workspace.query('select count(*)::int n from team_issue_create_receipts where "requestId"=$1',[value.requestId])).rows[0].n,1)
    } finally {target.transaction=original}
  })
  await t.test('a durable receipt with an absent relation is not restored on retry',async()=>{
    // Construct the state after a later removal without deleting any fixture.
    const value=input(teamId), {requestId,teamId:selectedTeam,...fields}=value
    const fingerprint=createHash('sha256').update(JSON.stringify({teamId:selectedTeam,...fields})).digest('hex')
    const id=randomUUID()
    await db.transaction(async tx=>{
      assert.ok(await createIssueForUserInTransaction(tx,owner,fields,userActor(owner),{id,linearSyncBlocked:true}))
      await tx.insert(teamIssueCreateRequests).values({requestId,issueId:id,ownerId:owner,teamId:selectedTeam,fingerprint})
    })
    await workspace.query('insert into team_issue_create_receipts ("requestId","issueId","ownerId","teamId","workspaceId") values ($1,$2,$3,$4,$5)',[requestId,id,owner,selectedTeam,workspaceId])
    assert.deepEqual(await query(owner,value),{error:'teamIssueChanged',requestId})
    assert.equal((await workspace.query('select count(*)::int n from mikka_team_issues where "issueId"=$1',[id])).rows[0].n,0)
    assert.equal((await app.query('select scope from issues where id=$1',[id])).rows[0].scope,'personal')
    assert.ok(await issueForUser(owner,id));assert.equal(await issueForUser(racer,id),null)
  })
  await t.test('membership revoked after a lost association commit cannot promote on retry',async()=>{
    const lostOwner=`team-lost-owner-${randomUUID()}`,value=input(teamId)
    await app.query('insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values ($1,\'Synthetic\',$2,true,now(),now())',[lostOwner,`${lostOwner}@example.invalid`])
    await workspace.query('insert into mikka_workspace_members ("workspaceId","userId",name,email,role,status) values ($1,$2,\'Synthetic\',$3,\'member\',\'active\')',[workspaceId,lostOwner,`${lostOwner}@example.invalid`])
    const target=workspaceDb as unknown as {transaction:(...args:unknown[])=>Promise<unknown>},original=target.transaction
    let once=true
    target.transaction=async (...args:unknown[])=>{
      const result=await original.apply(workspaceDb,args)
      if(once) {once=false;throw new Error('synthetic lost commit response')}
      return result
    }
    try {
      assert.deepEqual(await query(lostOwner,value),{error:'teamIssueRetry',requestId:value.requestId})
      const row=(await app.query('select i.id,i.scope from issues i join team_issue_create_requests r on r."issueId"=i.id where r."requestId"=$1',[value.requestId])).rows[0]
      await workspace.query('update mikka_workspace_members set status=\'inactive\' where "workspaceId"=$1 and "userId"=$2',[workspaceId,lostOwner])
      assert.deepEqual(await query(lostOwner,value),{error:'teamIssueAccessDenied',requestId:value.requestId})
      assert.equal((await app.query('select scope from issues where id=$1',[row.id])).rows[0].scope,'personal')
      assert.ok(await issueForUser(lostOwner,row.id));assert.equal(await issueForUser(racer,row.id),null)
      assert.equal((await app.query('select count(*)::int n from linear_sync_outbox where "issueId"=$1',[row.id])).rows[0].n,0)
    } finally {target.transaction=original}
  })
  await t.test('revocation between association and promotion leaves the task personal',async()=>{
    await workspace.query('insert into team184_controls ("teamId",pause) values ($1,true)',[raceTeam])
    const gate=await workspace.connect(), revoke=await workspace.connect();const value=input(raceTeam)
    let create:ReturnType<typeof query>|undefined, revocation:Promise<unknown>|undefined
    try {
      await gate.query("select pg_advisory_lock(hashtextextended('team184-barrier',0))")
      create=query(racer,value)
      let blocked=false
      for(let i=0;i<500;i++) {if((await workspace.query("select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%mikka_team_issues%'" )).rowCount){blocked=true;break}}
      assert.ok(blocked,'association did not reach the barrier')
      await revoke.query('begin');revocation=revoke.query("select pg_advisory_xact_lock(hashtextextended('mikka-team-relations',0))")
      let waiting=false
      for(let i=0;i<500;i++) {if((await workspace.query("select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%mikka-team-relations%'" )).rowCount){waiting=true;break}}
      assert.ok(waiting,'revocation did not wait for the relation lock')
      await gate.query("select pg_advisory_unlock(hashtextextended('team184-barrier',0))");await revocation
      await revoke.query('update mikka_workspace_members set status=\'inactive\' where "workspaceId"=$1 and "userId"=$2',[workspaceId,racer]);await revoke.query('commit')
      assert.deepEqual(await create,{error:'teamIssueAccessDenied',requestId:value.requestId})
      const row=(await app.query('select i.id,i.scope,i."linearSyncBlocked" from issues i join team_issue_create_requests r on r."issueId"=i.id where r."requestId"=$1',[value.requestId])).rows[0]
      assert.equal(row.scope,'personal');assert.equal(row.linearSyncBlocked,true)
      assert.equal((await app.query('select count(*)::int n from linear_sync_outbox where "issueId"=$1',[row.id])).rows[0].n,0)
      assert.deepEqual(await query(racer,value),{error:'teamIssueAccessDenied',requestId:value.requestId})
    } finally {await gate.query("select pg_advisory_unlock(hashtextextended('team184-barrier',0))");await revoke.query('rollback');gate.release();revoke.release();if(create) await Promise.allSettled([create])}
  })
  assert.equal(externalCalls,0)
  t.diagnostic(`Retained synthetic databases: ${appName}, ${workspaceName}; real provider calls: ${externalCalls}`)
})
