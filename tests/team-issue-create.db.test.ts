import { scopeSubtest,teamResumeBootstrap } from './support/scope-acceptance.mjs'
import { SCOPE_DATABASES } from '../scripts/scope-acceptance-policy.mjs'
import 'next/dist/server/node-environment-baseline'
import { installTeamSessionFixture } from './fixtures/team-auth-runtime.mjs'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { promisify } from 'node:util'
import test from 'node:test'
import type { PoolClient } from 'pg'
import { assertE2eTarget, disposableDatabase } from './helpers/e2e-target.mjs'

const url = process.env.E2E_DATABASE_URL
if (url) {
  const target = assertE2eTarget(url)
  const cloud = target.port === '55484' && target.pathname === '/issue184_e2e'
  if (!disposableDatabase() || process.env.ISSUE184_LOCAL_TEST === '1' && !cloud || process.env.MIKKA_DATABASE_URL !== url || process.env.DATABASE_URL !== url) throw new Error('Team task tests require the isolated PG17 service')
}
if (!url && process.env.REQUIRE_DB === '1') throw new Error('Team task DB tests cannot skip in required CI')

test('explicit team task creation across two real PostgreSQL databases', { skip: !url }, async t => {
  const { Pool } = await import('pg')
  const suffix=randomUUID().replaceAll('-','')
  const appName=process.env.ISSUE184_LOCAL_TEST === '1' ? SCOPE_DATABASES.app : `team184_app_${suffix}_e2e`
  const workspaceName=process.env.ISSUE184_LOCAL_TEST === '1' ? SCOPE_DATABASES.workspace : `team184_workspace_${suffix}_e2e`
  const resumed=await teamResumeBootstrap(appName,workspaceName)
  if(!resumed){
  const admin=new Pool({connectionString:url,max:1})
  try {
    assert.equal(String((await admin.query('show server_version_num')).rows[0].server_version_num).slice(0,2),'17')
    await admin.query(`create database "${appName}"`);await admin.query(`create database "${workspaceName}"`)
  } finally {await admin.end()}
  }
  const appUrl=new URL(url!), workspaceUrl=new URL(url!);appUrl.pathname=`/${appName}`;workspaceUrl.pathname=`/${workspaceName}`
  process.env.MIKKA_DATABASE_URL=appUrl.toString();process.env.DATABASE_URL=workspaceUrl.toString()
  if(!resumed)await promisify(execFile)(process.execPath,['scripts/migrate.mjs'],{env:{...process.env,MIGRATE:'1',VERCEL_ENV:''},maxBuffer:4<<20})
  const app=new Pool({connectionString:appUrl.toString(),max:5}), workspace=new Pool({connectionString:workspaceUrl.toString(),max:6})
  const originalFetch=globalThis.fetch;let externalCalls=0
  const originalFlagKey=process.env.NEXT_PUBLIC_POSTHOG_KEY,flagKey=`synthetic-team-flag-${randomUUID()}`
  process.env.NEXT_PUBLIC_POSTHOG_KEY=flagKey
  t.after(()=>{if(originalFlagKey===undefined)delete process.env.NEXT_PUBLIC_POSTHOG_KEY;else process.env.NEXT_PUBLIC_POSTHOG_KEY=originalFlagKey})
  globalThis.fetch=(async(input,init)=>{
    const target=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url)
    // Exercise the real on-state gate before the task scope/target checks.
    if(target.href==='https://us.i.posthog.com/flags?v=2') {
      assert.equal(JSON.parse(String(init?.body)).api_key,flagKey)
      return Response.json({errorsWhileComputingFlags:false,flags:{'mikka-linear-sync':{enabled:true}}})
    }
    if(target.hostname==='127.0.0.1') return originalFetch(input,init)
    externalCalls++;throw new Error('Real provider requests prohibited')
  }) as typeof fetch
  t.after(async()=>{globalThis.fetch=originalFetch;await Promise.all([app.end(),workspace.end()])})
  const {auth}=await import('../lib/auth')
  const restoreAuth=installTeamSessionFixture(auth)
  t.after(restoreAuth)
  // Let the real initialization finish against the selected test DB before
  // task fixtures. No auth endpoints or external identity providers are called.
  await auth.$context
  const {actAs}=await import('../lib/acting-user')
  const {tokenWorkspace}=await import('../lib/tokens/principal')
  const {agentActor,userActor}=await import('../lib/activity-actor')
  const {workspacePool}=await import('../lib/workspace-db')
  // Inject at the actual PostgreSQL commit boundary. workspaceDb deliberately
  // owns transaction dispatch, so replacing its method does not reach the
  // pinned client used by an authoritative workspace transaction.
  function injectWorkspaceCommit(requestId: string, hooks: { beforeReceiptRead?: () => void; afterCommit?: () => void | Promise<void> }) {
    const originals = new Map<PoolClient, PoolClient['query']>()
    const acquire = (client: PoolClient) => {
      if (originals.has(client)) return
      const original = client.query
      originals.set(client, original)
      let matchesRequest = false
      client.query = ((...args: unknown[]) => {
        const statement = args[0]
        const text = typeof statement === 'string' ? statement : statement && typeof statement === 'object' && 'text' in statement && typeof statement.text === 'string' ? statement.text : ''
        if (/^\s*(?:begin|rollback)\b/i.test(text)) matchesRequest = false
        const configValues = typeof statement === 'object' && statement && 'values' in statement ? statement.values : undefined
        const parameters = Array.isArray(args[1]) ? args[1] : configValues
        if (/\bfrom "team_issue_(?:create|promotion)_receipts"/i.test(text) && Array.isArray(parameters) && parameters.includes(requestId)) {
          matchesRequest = true
          hooks.beforeReceiptRead?.()
        }
        const result: unknown = Reflect.apply(original, client, args)
        if (!matchesRequest || !/^\s*commit\b/i.test(text)) return result
        matchesRequest = false
        assert.ok(result && typeof result === 'object' && 'then' in result && typeof result.then === 'function', 'Drizzle COMMIT must use the promise query API')
        return Promise.resolve(result).then(async value => { await hooks.afterCommit?.(); return value })
      }) as PoolClient['query']
    }
    workspacePool.on('acquire', acquire)
    return () => {
      workspacePool.off('acquire', acquire)
      for (const [client, original] of originals) client.query = original
    }
  }
  function observeWorkspaceLockWaits() {
    const originals=new Map<PoolClient,PoolClient['query']>()
    const observed={timeouts:[] as string[],transactions:0}
    const acquire=(client:PoolClient)=>{
      if(originals.has(client)) return
      const original=client.query;originals.set(client,original)
      client.query=((...args:unknown[])=>{
        const statement=args[0]
        const text=typeof statement==='string'?statement:statement&&typeof statement==='object'&&'text' in statement&&typeof statement.text==='string'?statement.text:''
        const result:unknown=Reflect.apply(original,client,args)
        if(/^\s*begin(?:\s|$)/i.test(text)) {
          assert.ok(result&&typeof result==='object'&&'then' in result&&typeof result.then==='function')
          return Promise.resolve(result).then(async value=>{
            // Bound a real blocked lock upgrade. This is not a deadline for
            // promotion work, and every business query still reaches PG.
            await Reflect.apply(original,client,["set local lock_timeout='1s'"])
            observed.transactions++
            return value
          })
        }
        if(result&&typeof result==='object'&&'then' in result&&typeof result.then==='function') return Promise.resolve(result).catch((error:unknown)=>{
          if(error&&typeof error==='object'&&'code' in error&&error.code==='55P03') observed.timeouts.push(error.code)
          throw error
        })
        return result
      }) as PoolClient['query']
    }
    workspacePool.on('acquire',acquire)
    return {observed,restore(){
      workspacePool.off('acquire',acquire)
      for(const [client,original] of originals) client.query=original
    }}
  }
  const {db}=await import('../lib/db')
  const {teamIssueCreateRequests}=await import('../lib/db/schema')
  const {createIssueForUserInTransaction}=await import('../lib/issue-create')
  const {issueForUser}=await import('../lib/issue-access')
  const {createIssueForTeam,promoteIssueToTeam,setIssueScope,saveIssue}=await import('../app/actions/issues')
  const {exchangeDocument}=await import('../app/actions/collaboration')
  const {AfterContext}=await import('next/dist/server/after/after-context')
  const {workAsyncStorage}=await import('next/dist/server/app-render/work-async-storage.external')
  const {workUnitAsyncStorage}=await import('next/dist/server/app-render/work-unit-async-storage.external')
  const {createRequestStoreForAPI}=await import('next/dist/server/async-storage/request-store')
  const {NextRequest}=await import('next/server')
  const Y=await import('yjs')
  async function withAfter<T>(fn:()=>Promise<T>) {
    const waits:Promise<unknown>[]=[],errors:unknown[]=[],closes:Array<()=>void>=[]
    const afterContext=new AfterContext({waitUntil:promise=>{waits.push(promise)},onClose:callback=>{closes.push(callback)},onTaskError:error=>{errors.push(error)}})
    const request=new NextRequest('http://127.0.0.1/mikka')
    // Include Next 16.4's optional HMR argument; local 16.1 ignores it.
    const requestStore:ReturnType<typeof createRequestStoreForAPI>=Reflect.apply(createRequestStoreForAPI,undefined,[request,new URL(request.url),{tags:[],expirationsByCacheKind:new Map()},undefined,undefined,undefined])
    return workAsyncStorage.run({afterContext} as NonNullable<ReturnType<typeof workAsyncStorage.getStore>>,()=>workUnitAsyncStorage.run(requestStore,async()=>{
      try{return await fn()}finally{for(const close of closes)close();await Promise.all(waits);assert.deepEqual(errors,[])}
    }))
  }
  const {retryLinearIssue}=await import('../app/actions/linear-sync')
  const {syncAppIssueToLinear}=await import('../lib/linear-sync/issue-sync')
  const {processLinearIssueOutbox,processLinearInboxDelivery}=await import('../lib/linear-sync/worker')
  const owner=`team-owner-${randomUUID()}`, racer=`team-racer-${randomUUID()}`, stranger=`team-stranger-${randomUUID()}`
  const workspaceId=randomUUID(), personalWorkspaceId=randomUUID(), teamId=randomUUID(), raceTeam=randomUUID(), badTeam=randomUUID()
  for(const user of [owner,racer,stranger]) await app.query('insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values ($1,\'Synthetic\',$2,true,now(),now())',[user,`${user}@example.invalid`])
  await app.query('insert into linear_team_syncs (id,"ownerId","linearTeamId","workspaceId","linearTeamKey","linearTeamName") values ($1,$2,$3,$4,\'EXT\',\'Other external team\')',[randomUUID(),owner,randomUUID(),workspaceId])
  await workspace.query('insert into mikka_workspaces (id,"userId",name,kind) values ($1,$2,\'Synthetic personal workspace\',\'personal\')',[personalWorkspaceId,owner])
  await workspace.query('insert into mikka_workspace_members ("workspaceId","userId",name,email,role,status) values ($1,$2,\'Synthetic\',$3,\'admin\',\'active\')',[personalWorkspaceId,owner,`${owner}@example.invalid`])
  await workspace.query('insert into mikka_workspaces (id,"userId",name) values ($1,$2,\'Synthetic team workspace\')',[workspaceId,owner])
  for(const user of [owner,racer]) await workspace.query('insert into mikka_workspace_members ("workspaceId","userId",name,email,role,status) values ($1,$2,\'Synthetic\',$3,\'member\',\'active\')',[workspaceId,user,`${user}@example.invalid`])
  for(const [id,key] of [[teamId,'OK'],[raceTeam,'RACE'],[badTeam,'FAIL']]) await workspace.query('insert into mikka_teams (id,"workspaceId","userId",name,identifier) values ($1,$2,$3,\'Synthetic\',$4)',[id,workspaceId,owner,key])
  await app.query(`create table team184_app_controls (title text primary key, fail boolean not null, "failCreate" boolean not null default false)`)
  await app.query(`create function team184_fail_promotion() returns trigger language plpgsql as $$ begin if new.scope='workspace' and exists(select 1 from team184_app_controls where title=new.title and fail) then raise exception 'synthetic promotion failure'; end if; return new; end $$`)
  await app.query('create trigger team184_fail_promotion before update of "linearSyncPolicy" on issues for each row execute function team184_fail_promotion()')
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
  await scopeSubtest(t, 'task attachments use current task ACLs and persist independently of any thread', async () => {
    const route = await import('../app/api/tasks/[taskId]/attachments/route')
    const { createLegacyPersonalAccessToken } = await import('../lib/tokens/store')
    const taskId = randomUUID(), otherId = randomUUID(), fileId = randomUUID()
    await app.query(`INSERT INTO issues(id,"userId","workspaceId","ownershipState",title,content,status,priority)
      SELECT id,$1,$2,'bound','File test','{"type":"doc"}','todo','normal' FROM unnest($3::uuid[]) AS id`, [owner, workspaceId, [taskId, otherId]])
    const token = async (user: string, tenant: string) => (await createLegacyPersonalAccessToken(user, tenant, { name: 'File acceptance' })).token
    const editor = await token(owner, workspaceId), member = await token(racer, workspaceId), elsewhere = await token(owner, personalWorkspaceId)
    const server = createServer(async (incoming, outgoing) => {
      try {
        const incomingBytes: Buffer[] = []
        for await (const chunk of incoming) incomingBytes.push(chunk)
        const request = new Request(`http://${incoming.headers.host}${incoming.url}`, {
          method: incoming.method, headers: incoming.headers as Record<string, string>,
          body: incoming.method === 'POST' ? Buffer.concat(incomingBytes) : undefined,
        })
        const id = new URL(request.url).pathname.split('/')[2]!
        const method = incoming.method as 'GET' | 'POST' | 'DELETE'
        const response = await route[method](request, { params: Promise.resolve({ taskId: id }) })
        outgoing.writeHead(response.status, Object.fromEntries(response.headers))
        outgoing.end(Buffer.from(await response.arrayBuffer()))
      } catch { outgoing.writeHead(500); outgoing.end() }
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      assert.ok(address && typeof address !== 'string')
      const endpoint = `http://127.0.0.1:${address.port}/tasks/${taskId}/attachments`
      const data = new Uint8Array([0, 80, 68, 70, 255]), name = '附件 (1).bin'
      const request = (who: string, method: 'GET' | 'POST' | 'DELETE' = 'GET', id = '', bytes = data, url = endpoint) => {
        const body = new FormData()
        body.set('file', new File([bytes], name))
        return fetch(url + (id ? `?id=${id}` : ''), {
          method, headers: { authorization: `Bearer ${who}` }, ...(method === 'POST' && { body }),
        })
      }
      assert.equal((await request('mkp_' + '0'.repeat(43))).status, 401)
      assert.deepEqual(await (await request(editor)).json(), { files: [], canEdit: true })
      const file = { id: fileId, name, size: data.length }
      for (const response of await Promise.all([request(editor, 'POST', fileId), request(editor, 'POST', fileId)])) {
        assert.equal(response.status, 200)
        assert.deepEqual(await response.json(), file)
      }
      assert.equal((await request(editor, 'POST', fileId, new Uint8Array([1]))).status, 409)
      assert.deepEqual(await (await request(member)).json(), { files: [file], canEdit: true })
      const download = await request(member, 'GET', fileId)
      assert.equal(download.status, 200)
      assert.match(download.headers.get('content-disposition')!, /^attachment;/)
      assert.deepEqual(new Uint8Array(await download.arrayBuffer()), data)
      assert.equal((await request(elsewhere, 'GET', fileId)).status, 404)
      assert.equal((await request(editor, 'GET', fileId, data, endpoint.replace(taskId, otherId))).status, 404)
      await app.query(`UPDATE resource_access_policies SET visibility='private' WHERE kind='task' AND id=$1`, [taskId])
      assert.equal((await request(member)).status, 404)
      await app.query(`INSERT INTO resource_access_grants("resourceKind","resourceId","subjectKind","subjectId",capabilities)
        VALUES('task',$1,'account',$2,ARRAY['canReadContent'])`, [taskId, racer])
      assert.deepEqual(await (await request(member)).json(), { files: [file], canEdit: false })
      assert.equal((await request(member, 'POST', randomUUID())).status, 404)
      assert.equal((await request(member, 'DELETE', fileId)).status, 404)
      await app.query(`UPDATE resource_access_grants SET capabilities=ARRAY['canSteer'] WHERE "resourceKind"='task' AND "resourceId"=$1 AND "subjectId"=$2`, [taskId, racer])
      assert.equal((await request(member, 'GET', fileId)).status, 404)
      assert.equal((await request(member, 'POST', randomUUID())).status, 404)
      assert.equal((await request(member, 'DELETE', fileId)).status, 404)
      assert.equal((await request(editor, 'DELETE', fileId)).status, 204)
      assert.deepEqual(await (await request(editor)).json(), { files: [], canEdit: true })
      assert.equal((await request(editor, 'GET', fileId)).status, 404)
      // One more upload at the count boundary wins; declined uploads do not add rows.
      for (let n = 0; n < 9; n++) assert.equal((await request(editor, 'POST', randomUUID())).status, 200)
      const concurrent = await Promise.all([request(editor, 'POST', randomUUID()), request(editor, 'POST', randomUUID())])
      assert.deepEqual(concurrent.map(r => r.status).sort(), [200, 409])
      assert.equal((await (await request(editor)).json()).files.length, 10)
      assert.equal((await request(editor, 'POST', randomUUID(), new Uint8Array(3 * 1024 * 1024 + 1))).status, 413)

      // Drive the real S3 transport, retention trigger and existing cleanup worker
      // against an isolated object server, including an interrupted final commit.
      const objects = new Map<string, Buffer>()
      const bucket = createServer(async (req, res) => {
        const key = req.url!.slice('/private/'.length)
        if (req.method === 'PUT') {
          const parts = []
          for await (const chunk of req) parts.push(Buffer.from(chunk))
          objects.set(key, Buffer.concat(parts))
          res.writeHead(200).end()
        } else if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204).end() }
        else if (objects.has(key)) res.writeHead(200).end(objects.get(key))
        else res.writeHead(404).end()
      })
      await new Promise<void>(resolve => bucket.listen(0, '127.0.0.1', resolve))
      const bucketAddress = bucket.address()
      assert.ok(bucketAddress && typeof bucketAddress !== 'string')
      const settings = { S3_ENDPOINT: `http://127.0.0.1:${bucketAddress.port}`, S3_BUCKET: 'private', S3_ACCESS_KEY_ID: 'test', S3_SECRET_ACCESS_KEY: 'fixture-only' }
      const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]))
      Object.assign(process.env, settings)
      try {
        const url = endpoint.replace(taskId, otherId), id = randomUUID()
        assert.equal((await request(editor, 'POST', id, data, url)).status, 200)
        assert.equal(objects.size, 1)
        assert.deepEqual(new Uint8Array(await (await request(editor, 'GET', id, data, url)).arrayBuffer()), data)
        const { cleanupChatFiles } = await import('../lib/chat-attachments/store')
        const deniedId = randomUUID()
        await app.query(`ALTER TABLE task_attachments ADD CONSTRAINT synthetic_commit_error CHECK(id <> '${deniedId}'::uuid)`)
        assert.equal((await request(editor, 'POST', deniedId, data, url)).status, 500)
        assert.equal(objects.size, 2)
        assert.equal((await request(editor, 'GET', deniedId, data, url)).status, 404)
        const retirement = await app.query(`UPDATE chat_attachment_retirements SET "notBefore"=now() WHERE "storageKey" LIKE $1 RETURNING "storageKey"`, [`task-files/${otherId}/%`])
        assert.equal(retirement.rowCount, 1)
        await cleanupChatFiles()
        assert.equal(objects.size, 1)
        assert.equal((await request(editor, 'DELETE', id, data, url)).status, 204)
        await cleanupChatFiles()
        assert.equal(objects.size, 0)
      } finally {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
        await new Promise<void>((resolve, reject) => bucket.close(error => error ? reject(error) : resolve()))
      }
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
  })
  await scopeSubtest(t, 'save, legacy scope click, title/document writes and manual retry keep personal data out of Linear',async()=>{
    const created=await withAfter(()=>actAs(owner,()=>saveIssue({title:'Legacy UI task',content,status:'todo',priority:'normal'})))
    assert.ok('issue' in created && created.issue);const id=created.issue.id
    await workspace.query('insert into mikka_team_issues ("issueId","teamId","workspaceId","userId") values ($1,$2,$3,$4)',[id,teamId,workspaceId,owner])
    assert.deepEqual(await actAs(owner,()=>setIssueScope({id,revision:created.issue.revision,scope:'workspace'})),{error:'issueNotFound',params:undefined},'a stale Team link cannot override the persisted personal tenant')
    assert.equal((await app.query('select "workspaceId" from issues where id=$1',[id])).rows[0].workspaceId,personalWorkspaceId)
    await workspace.query('delete from mikka_team_issues where "issueId"=$1',[id])
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
  await scopeSubtest(t, 'personal tasks cannot move to a shared workspace; same-workspace team attachment preserves identity',async()=>{
    testGlobals.teamCreateTestUser=owner
    const personal=await withAfter(()=>saveIssue({workspaceId:personalWorkspaceId,title:'Keep personal tenant',content,status:'todo',priority:'normal'}))
    assert.ok('issue' in personal && personal.issue)
    const denied={requestId:randomUUID(),issueId:personal.issue.id,revision:personal.issue.revision,teamId,expectedTeamId:null}
    assert.deepEqual(await promoteIssueToTeam(denied),{error:'teamIssueAccessDenied',requestId:denied.requestId})
    assert.equal((await workspace.query('select count(*)::int n from mikka_team_issues where "issueId"=$1',[personal.issue.id])).rows[0].n,0)
    assert.equal((await app.query('select "workspaceId" from issues where id=$1',[personal.issue.id])).rows[0].workspaceId,personalWorkspaceId)
    const created=await withAfter(()=>saveIssue({workspaceId,title:'Attach existing shared task',content,status:'todo',priority:'normal'}))
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
  await scopeSubtest(t, 'team promotion completes while another admission holds the same membership SHARE lease',async()=>{
    testGlobals.teamCreateTestUser=owner
    const created=await withAfter(()=>saveIssue({workspaceId,title:'Promotion with a concurrent shared membership',content,status:'todo',priority:'normal'}))
    assert.ok('issue' in created && created.issue)
    const request={requestId:randomUUID(),issueId:created.issue.id,revision:created.issue.revision,teamId,expectedTeamId:null}
    const holder=await workspace.connect(),locks=observeWorkspaceLockWaits()
    try {
      await holder.query('begin')
      assert.equal((await holder.query('select id from mikka_workspaces where id=$1 for share',[workspaceId])).rowCount,1)
      assert.deepEqual((await holder.query('select status from mikka_workspace_members where "workspaceId"=$1 and "userId"=$2 for share',[workspaceId,owner])).rows,[{status:'active'}])
      const heldTransaction=(await holder.query('select txid_current()::text as id')).rows[0].id
      const result=await promoteIssueToTeam(request)
      t.diagnostic(`Concurrent membership SHARE: result=${'error' in result?result.error:'complete'}, lockTimeouts=${JSON.stringify(locks.observed.timeouts)}`)
      assert.deepEqual(locks.observed.timeouts,[],'promotion must remain compatible with an existing membership SHARE lease')
      assert.ok('issue' in result && result.issue)
      assert.ok(locks.observed.transactions>=2,'both real promotion phases must run while the shared lease is held')
      assert.equal((await holder.query('select txid_current()::text as id')).rows[0].id,heldTransaction)
      assert.equal(result.issue.id,request.issueId);assert.equal(result.issue.workspaceId,workspaceId);assert.equal(result.issue.revision,request.revision+1)
      assert.equal(result.issue.linearSyncBlocked,true);assert.deepEqual(result.linearSync,{enabled:false,reason:'no_explicit_target'})
      assert.deepEqual((await app.query('select status from team_issue_promotions where "requestId"=$1 and "issueId"=$2',[request.requestId,request.issueId])).rows,[{status:'complete'}])
      assert.equal((await workspace.query('select count(*)::int n from team_issue_promotion_receipts r join mikka_team_issues t on t."issueId"=r."issueId" where r."requestId"=$1 and r."issueId"=$2 and r."ownerId"=$3 and r."teamId"=$4 and r."workspaceId"=$5 and t."userId"=$3 and t."teamId"=$4 and t."workspaceId"=$5',[request.requestId,request.issueId,owner,teamId,workspaceId])).rows[0].n,1)
      assert.equal((await app.query('select count(*)::int n from linear_sync_outbox where "issueId"=$1',[request.issueId])).rows[0].n,0)
    } finally {
      locks.restore()
      try {await holder.query('rollback')} finally {holder.release()}
    }
  })
  await scopeSubtest(t, 'cross-workspace promotion refuses before locking the original workspace membership',async()=>{
    testGlobals.teamCreateTestUser=owner
    const created=await withAfter(()=>saveIssue({workspaceId,title:'Retain the original promotion workspace',content,status:'todo',priority:'normal'}))
    assert.ok('issue' in created && created.issue)
    const initial=await promoteIssueToTeam({requestId:randomUUID(),issueId:created.issue.id,revision:created.issue.revision,teamId,expectedTeamId:null})
    assert.ok('issue' in initial && initial.issue)
    const otherWorkspace=randomUUID(),otherTeam=randomUUID(),id=initial.issue.id
    await workspace.query('insert into mikka_workspaces (id,"userId",name) values ($1,$2,\'Other promotion workspace\')',[otherWorkspace,owner])
    await workspace.query('insert into mikka_workspace_members ("workspaceId","userId",name,email,role,status) values ($1,$2,\'Synthetic\',$3,\'member\',\'active\')',[otherWorkspace,owner,`${owner}@example.invalid`])
    await workspace.query('insert into mikka_teams (id,"workspaceId","userId",name,identifier) values ($1,$2,$3,\'Other promotion team\',\'OTHER\')',[otherTeam,otherWorkspace,owner])
    const before={
      task:(await app.query('select * from issues where id=$1',[id])).rows,
      requests:(await app.query('select * from team_issue_promotions where "issueId"=$1 order by "requestId"',[id])).rows,
      receipts:(await workspace.query('select * from team_issue_promotion_receipts where "issueId"=$1 order by "requestId"',[id])).rows,
      links:(await workspace.query('select * from mikka_team_issues where "issueId"=$1',[id])).rows,
    }
    const request={requestId:randomUUID(),issueId:id,revision:initial.issue.revision,teamId:otherTeam,expectedTeamId:teamId}
    const holder=await workspace.connect(),locks=observeWorkspaceLockWaits()
    try {
      await holder.query('begin')
      assert.equal((await holder.query('select id from mikka_workspaces where id=$1 for update',[workspaceId])).rowCount,1)
      assert.deepEqual((await holder.query('select status from mikka_workspace_members where "workspaceId"=$1 and "userId"=$2 for update',[workspaceId,owner])).rows,[{status:'active'}])
      const heldTransaction=(await holder.query('select txid_current()::text as id')).rows[0].id
      const result=await promoteIssueToTeam(request)
      t.diagnostic(`Cross-workspace original membership held: result=${'error' in result?result.error:'complete'}, lockTimeouts=${JSON.stringify(locks.observed.timeouts)}`)
      assert.deepEqual(locks.observed.timeouts,[],'a cross-workspace refusal must not wait on the original membership')
      assert.deepEqual(result,{error:'teamIssueChanged',requestId:request.requestId})
      assert.equal((await holder.query('select txid_current()::text as id')).rows[0].id,heldTransaction)
      assert.deepEqual((await app.query('select * from issues where id=$1',[id])).rows,before.task)
      assert.deepEqual((await app.query('select * from team_issue_promotions where "issueId"=$1 order by "requestId"',[id])).rows,before.requests)
      assert.deepEqual((await workspace.query('select * from team_issue_promotion_receipts where "issueId"=$1 order by "requestId"',[id])).rows,before.receipts)
      assert.deepEqual((await workspace.query('select * from mikka_team_issues where "issueId"=$1',[id])).rows,before.links)
      assert.equal((await app.query('select count(*)::int n from linear_sync_outbox where "issueId"=$1',[id])).rows[0].n,0)
    } finally {
      locks.restore()
      try {await holder.query('rollback')} finally {holder.release()}
    }
  })
  await scopeSubtest(t, 'existing task lost workspace commit response retains its shared tenant and resumes same receipt',async()=>{
    testGlobals.teamCreateTestUser=owner
    const created=await withAfter(()=>saveIssue({workspaceId,title:'Existing task lost response',content,status:'todo',priority:'normal'}))
    assert.ok('issue' in created && created.issue);const id=created.issue.id
    const request={requestId:randomUUID(),issueId:id,revision:created.issue.revision,teamId,expectedTeamId:null}
    let mode:'lost'|'unavailable'|'normal'='lost'
    const restore=injectWorkspaceCommit(request.requestId, {
      beforeReceiptRead:()=>{if(mode==='unavailable') throw new Error('synthetic unavailable')},
      afterCommit:()=>{if(mode==='lost'){mode='unavailable';throw new Error('synthetic lost response')}},
    })
    try {
      assert.deepEqual(await promoteIssueToTeam(request),{error:'teamIssueRetry',requestId:request.requestId})
      assert.deepEqual((await app.query('select scope,"linearSyncBlocked" from issues where id=$1',[id])).rows[0],{scope:'workspace',linearSyncBlocked:true})
      assert.ok(await issueForUser(owner,id));assert.ok(await issueForUser(racer,id))
      assert.deepEqual(await promoteIssueToTeam(request),{error:'teamIssueRetry',requestId:request.requestId})
      mode='normal';const result=await promoteIssueToTeam(request);assert.ok('issue' in result && result.issue);assert.equal(result.issue.id,id);assert.equal(result.issue.scope,'workspace')
      assert.equal((await workspace.query('select count(*)::int n from team_issue_promotion_receipts where "requestId"=$1',[request.requestId])).rows[0].n,1)
      assert.equal((await app.query('select count(*)::int n from linear_sync_outbox where "issueId"=$1',[id])).rows[0].n,0)
    } finally {restore()}
  })
  await scopeSubtest(t, 'lost app promotion response with unavailable reconciliation reports unknown and replays once',async()=>{
    testGlobals.teamCreateTestUser=owner
    const created=await withAfter(()=>saveIssue({workspaceId,title:'Existing task app commit response lost',content,status:'todo',priority:'normal'}))
    assert.ok('issue' in created && created.issue);const id=created.issue.id
    const request={requestId:randomUUID(),issueId:id,revision:created.issue.revision,teamId,expectedTeamId:null}
    const target=db as unknown as {transaction:(...args:unknown[])=>Promise<unknown>;select:(...args:unknown[])=>unknown}
    const originalTx=target.transaction,originalSelect=target.select;let calls=0
    target.transaction=async (...args:unknown[])=>{const result=await originalTx.apply(db,args);if(++calls===2){target.select=()=>{throw new Error('synthetic reconciliation unavailable')};throw new Error('synthetic lost app commit response')}return result}
    try {
      assert.deepEqual(await promoteIssueToTeam(request),{error:'teamIssueOutcomeUnknown',requestId:request.requestId})
      assert.equal((await app.query('select scope from issues where id=$1',[id])).rows[0].scope,'workspace')
    } finally {target.transaction=originalTx;target.select=originalSelect}
    const replay=await promoteIssueToTeam(request);assert.ok('issue' in replay && replay.issue);assert.equal(replay.issue.id,id)
    assert.equal((await workspace.query('select count(*)::int n from team_issue_promotion_receipts where "requestId"=$1',[request.requestId])).rows[0].n,1)
    assert.equal((await app.query('select count(*)::int n from linear_sync_outbox where "issueId"=$1',[id])).rows[0].n,0)
  })
  await scopeSubtest(t, 'revocation after existing-task relation commit prevents promotion',async()=>{
    const revoked=`promotion-owner-${randomUUID()}`
    await app.query('insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values ($1,\'Synthetic\',$2,true,now(),now())',[revoked,`${revoked}@example.invalid`])
    await workspace.query('insert into mikka_workspace_members ("workspaceId","userId",name,email,role,status) values ($1,$2,\'Synthetic\',$3,\'member\',\'active\')',[workspaceId,revoked,`${revoked}@example.invalid`])
    testGlobals.teamCreateTestUser=revoked
    const created=await withAfter(()=>saveIssue({workspaceId,title:'Existing revoked promotion',content,status:'todo',priority:'normal'}))
    assert.ok('issue' in created && created.issue);const id=created.issue.id
    const request={requestId:randomUUID(),issueId:id,revision:created.issue.revision,teamId,expectedTeamId:null}
    let first=true
    const restore=injectWorkspaceCommit(request.requestId, {afterCommit:async()=>{if(first){first=false;await workspace.query('update mikka_workspace_members set status=\'inactive\' where "workspaceId"=$1 and "userId"=$2',[workspaceId,revoked])}}})
    try {
      assert.deepEqual(await promoteIssueToTeam(request),{error:'teamIssueAccessDenied',requestId:request.requestId})
      assert.deepEqual((await app.query('select scope,"linearSyncBlocked" from issues where id=$1',[id])).rows[0],{scope:'workspace',linearSyncBlocked:true})
      assert.equal(await issueForUser(revoked,id),null);assert.ok(await issueForUser(racer,id))
      assert.equal((await app.query('select count(*)::int n from linear_sync_outbox where "issueId"=$1',[id])).rows[0].n,0)
    } finally {restore()}
  })
  await scopeSubtest(t, 'MCP creation requires a verified workspace and ignores spoofed scope or team context',async()=>{
    const {createIssue}=await import('../lib/mcp/actions')
    const input={title:'MCP scope spoof',body:'ambiguous work',scope:'workspace',teamId} as Parameters<typeof createIssue>[1]
    assert.deepEqual(await createIssue(owner,input,agentActor(randomUUID())),{error:'workspaceAccessDenied'})
    const created=await withAfter(()=>actAs({id:owner,[tokenWorkspace]:workspaceId},()=>createIssue(owner,input,agentActor(randomUUID()))))
    assert.ok('id' in created)
    const row=(await app.query('select scope,"workspaceId","ownershipState","linearSyncPolicy","linearSyncBlocked" from issues where id=$1',[created.id])).rows[0]
    assert.deepEqual(row,{scope:'workspace',workspaceId,ownershipState:'bound',linearSyncPolicy:'disabled',linearSyncBlocked:true})
    for(const table of ['linear_sync_outbox','linear_issue_publications','linear_issue_links']) assert.equal((await app.query(`select count(*)::int n from ${table} where "issueId"=$1`,[created.id])).rows[0].n,0)
    assert.equal(externalCalls,0)
  })
  await scopeSubtest(t, 'legacy scope UI/action cannot promote even when a team relation or active Linear team exists',async()=>{
    const id=randomUUID()
    await app.query('insert into issues (id,"userId",title,content,status,priority,scope) values ($1,$2,\'Legacy scope action\',$3,\'todo\',\'normal\',\'personal\')',[id,owner,JSON.stringify(content)])
    // An existing association is context, not proof that this call explicitly
    // selected and authorized a destination.
    await workspace.query('insert into mikka_team_issues ("issueId","teamId","workspaceId","userId") values ($1,$2,$3,$4)',[id,teamId,workspaceId,owner])
    assert.deepEqual(await actAs(owner,()=>setIssueScope({id,revision:1,scope:'workspace'})),{error:'issueNotFound',params:undefined})
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
  await scopeSubtest(t, 'an unlinked legacy workspace task never infers the owner active Linear team',async()=>{
    const id=randomUUID()
    await app.query('insert into issues (id,"userId",title,content,status,priority,scope) values ($1,$2,\'Unlinked legacy workspace\',$3,\'todo\',\'normal\',\'workspace\')',[id,owner,JSON.stringify(content)])
    await app.query('update issues set title=\'Unlinked legacy update\' where id=$1',[id])
    await app.query('insert into issue_documents ("issueId","userId",state) values ($1,$2,\'synthetic\')',[id,owner])
    await app.query('insert into linear_sync_outbox (id,"issueId","scopeVersion") values ($1,$2,1)',[randomUUID(),id])
    assert.equal((await app.query('select count(*)::int n from linear_sync_outbox where "issueId"=$1',[id])).rows[0].n,0)
    await assert.rejects(actAs(owner,()=>retryLinearIssue(id)),{message:'issueNotFound'})
    assert.equal(await syncAppIssueToLinear(id),null)
    assert.equal((await app.query('select count(*)::int n from linear_issue_publications where "issueId"=$1',[id])).rows[0].n,0)
    assert.equal((await app.query('select count(*)::int n from linear_issue_links where "issueId"=$1',[id])).rows[0].n,0)
    assert.equal(externalCalls,0)
    // A quarantined row cannot mint a publication or link using only owner
    // and provider metadata. Historical receipts are covered by migration tests.
    const team=(await app.query('select id from linear_team_syncs where "ownerId"=$1',[owner])).rows[0].id
    const publication=randomUUID(),remote=randomUUID()
    await assert.rejects(app.query('insert into linear_issue_publications (id,"issueId","ownerId","teamSyncId","scopeVersion","linearIssueId") values ($1,$2,$3,$4,1,$5)',[publication,id,owner,team,remote]),(error:unknown)=>(error as {code:string}).code==='23514')
    await assert.rejects(app.query('insert into linear_issue_links (id,"issueId","ownerId","teamSyncId","linearIssueId","linearIdentifier","externalTargetVerified") values ($1,$2,$3,$4,$5,\'EXT-2\',true)',[randomUUID(),id,owner,team,remote]),(error:unknown)=>(error as {code:string}).code==='23514')
    await assert.rejects(app.query('insert into linear_issue_links (id,"issueId","ownerId","teamSyncId","linearIssueId","linearIdentifier") values ($1,$2,$3,$4,$5,\'EXT-2\')',[randomUUID(),id,owner,team,remote]),(error:unknown)=>(error as {code:string}).code==='23514')
    assert.equal(await syncAppIssueToLinear(id),null)
    await app.query('update issues set title=\'Unverified linked update\' where id=$1',[id])
    assert.equal((await app.query('select count(*)::int n from linear_sync_outbox where "issueId"=$1',[id])).rows[0].n,0)
    assert.equal((await app.query('select count(*)::int n from linear_issue_publications where id=$1',[publication])).rows[0].n,0)
    assert.equal(externalCalls,0)
  })
  await scopeSubtest(t, 'unverified historical issue and comment removal webhooks cannot mutate retained links',async()=>{
    const id=randomUUID(),remoteId=randomUUID(),linkId=randomUUID(),commentId=randomUUID(),commentLinkId=randomUUID()
    const team=(await app.query('select id from linear_team_syncs where "ownerId"=$1',[owner])).rows[0].id
    await app.query('insert into linear_connections ("userId","linearUserId","organizationId","organizationName","accessToken","refreshToken","expiresAt") values ($1,\'synthetic\',\'synthetic-unknown\',\'Synthetic\',\'unused\',\'unused\',now()+interval \'1 hour\')',[owner])
    await app.query('insert into issues (id,"userId","workspaceId","ownershipState","linearSyncPolicy",title,content,status,priority,scope) values ($1,$2,$4,\'bound\',\'explicit\',\'Unverified inbound fixture\',$3,\'todo\',\'normal\',\'workspace\')',[id,owner,JSON.stringify(content),workspaceId])
    await app.query('insert into linear_issue_links (id,"issueId","ownerId","teamSyncId","linearIssueId","linearIdentifier") values ($1,$2,$3,$4,$5,\'EXT-unknown\')',[linkId,id,owner,team,remoteId])
    await app.query('insert into linear_comment_links (id,"issueLinkId","threadId","messageId","linearCommentId","bodyHash") values ($1,$2,\'thread\',\'message\',$3,\'synthetic\')',[commentLinkId,linkId,commentId])
    for (const event of [{type:'Issue',data:{id:remoteId}},{type:'Comment',data:{id:commentId,issueId:remoteId}}]) {
      const deliveryId=`unknown-remove-${randomUUID()}`
      await app.query('insert into linear_sync_inbox ("deliveryId","organizationId","eventType",payload) values ($1,\'synthetic-unknown\',$2,$3)',[deliveryId,event.type,JSON.stringify({...event,action:'remove',organizationId:'synthetic-unknown'})])
      await processLinearInboxDelivery(deliveryId)
    }
    assert.deepEqual((await app.query('select "externalTargetVerified","remoteRemovedAt","syncStatus" from linear_issue_links where id=$1',[linkId])).rows[0],{externalTargetVerified:false,remoteRemovedAt:null,syncStatus:'synced'})
    assert.equal((await app.query('select "syncStatus" from linear_comment_links where id=$1',[commentLinkId])).rows[0].syncStatus,'pending')
    assert.equal(externalCalls,0)
  })
  await scopeSubtest(t, 'an explicitly imported external task retains its verified link and can enqueue',async()=>{
    const remoteId=randomUUID()
    const {linearTeamSyncs}=await import('../lib/db/schema')
    const {eq}=await import('drizzle-orm')
    const [team]=await db.select().from(linearTeamSyncs).where(eq(linearTeamSyncs.ownerId,owner)).limit(1)
    const remote={id:remoteId,identifier:'EXT-1',title:'Existing imported workspace',description:'Synthetic',dueDate:null,priority:0,url:'https://example.invalid/synthetic',updatedAt:new Date().toISOString(),state:null,team:{id:team.linearTeamId,key:team.linearTeamKey,name:team.linearTeamName},assignee:null,labels:[]}
    const {createAppIssueFromLinear}=await import('../lib/linear-sync/issue-sync')
    const imported=await createAppIssueFromLinear(team,remote);assert.ok(imported)
    const id=imported.id
    assert.notEqual(id,remoteId);assert.equal(imported.workspaceId,workspaceId);assert.equal(imported.linearSyncPolicy,'explicit')
    assert.equal((await createAppIssueFromLinear(team,remote))?.id,id)
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
  await scopeSubtest(t, 'explicit authorized team succeeds once with durable provider gate and no outbox',async()=>{
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
    assert.deepEqual(await actAs({id:owner,[tokenWorkspace]:workspaceId},()=>retryLinearIssue(id)),{error:'linearIssueInvalid'})
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
  await scopeSubtest(t, 'concurrent replays create one issue and one team association',async()=>{
    const value=input(teamId)
    const results=await Promise.all([query(owner,value),query(owner,value),query(owner,value)])
    for(const result of results) assert.ok('issue' in result && result.issue)
    const ids=results.map(result=>'issue' in result && result.issue?.id)
    assert.equal(new Set(ids).size,1)
    assert.equal((await app.query('select count(*)::int n from team_issue_create_requests where "requestId"=$1',[value.requestId])).rows[0].n,1)
    assert.equal((await workspace.query('select count(*)::int n from team_issue_create_receipts where "requestId"=$1',[value.requestId])).rows[0].n,1)
  })
  await scopeSubtest(t, 'failed initial app transaction creates no partial issue or association',async()=>{
    const value={...input(teamId),title:`creation-failure-${randomUUID()}`}
    await app.query('insert into team184_app_controls (title,fail,"failCreate") values ($1,false,true)',[value.title])
    assert.deepEqual(await query(owner,value),{error:'teamIssueRetry',requestId:value.requestId})
    assert.equal((await app.query('select count(*)::int n from team_issue_create_requests where "requestId"=$1',[value.requestId])).rows[0].n,0)
    assert.equal((await app.query('select count(*)::int n from issues where title=$1',[value.title])).rows[0].n,0)
    assert.equal((await workspace.query('select count(*)::int n from team_issue_create_receipts where "requestId"=$1',[value.requestId])).rows[0].n,0)
    await app.query('update team184_app_controls set "failCreate"=false where title=$1',[value.title])
    const retried=await query(owner,value);assert.ok('issue' in retried && retried.issue);assert.equal(retried.issue.scope,'workspace')
  })
  await scopeSubtest(t, 'actual loopback HTTP invokes the public action and returns the blocked sync status',async()=>{
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
  await scopeSubtest(t, 'unauthorized team is rejected before an issue or request is created',async()=>{
    const value=input(teamId)
    assert.deepEqual(await query(stranger,value),{error:'teamIssueAccessDenied',requestId:value.requestId})
    assert.equal((await app.query('select count(*)::int n from team_issue_create_requests where "requestId"=$1',[value.requestId])).rows[0].n,0)
  })
  await scopeSubtest(t, 'failed workspace relation retains the task in its authorized shared workspace and retry completes without duplication',async()=>{
    await workspace.query('insert into team184_controls ("teamId",fail) values ($1,true)',[badTeam])
    const value=input(badTeam), failed=await query(owner,value)
    assert.deepEqual(failed,{error:'teamIssueRetry',requestId:value.requestId})
    const before=(await app.query('select i.id,i.scope,i."linearSyncBlocked" from issues i join team_issue_create_requests r on r."issueId"=i.id where r."requestId"=$1',[value.requestId])).rows[0]
    assert.equal(before.scope,'workspace');assert.equal(before.linearSyncBlocked,true)
    assert.equal((await workspace.query('select count(*)::int n from mikka_team_issues where "issueId"=$1',[before.id])).rows[0].n,0)
    await workspace.query('update team184_controls set fail=false where "teamId"=$1',[badTeam])
    const retried=await query(owner,value);assert.ok('issue' in retried && retried.issue);assert.equal(retried.issue.id,before.id);assert.equal(retried.issue.scope,'workspace')
    assert.equal((await app.query('select count(*)::int n from team_issue_create_requests where "requestId"=$1',[value.requestId])).rows[0].n,1)
  })
  await scopeSubtest(t, 'failed completion after association keeps the shared tenant and resumes the same request',async()=>{
    const value={...input(teamId),title:`promotion-failure-${randomUUID()}`}
    await app.query('insert into team184_app_controls (title,fail) values ($1,true)',[value.title])
    assert.deepEqual(await query(owner,value),{error:'teamIssueOutcomeUnknown',requestId:value.requestId})
    const row=(await app.query('select i.id,i.scope,i."linearSyncBlocked" from issues i join team_issue_create_requests r on r."issueId"=i.id where r."requestId"=$1',[value.requestId])).rows[0]
    assert.equal(row.scope,'workspace');assert.equal(row.linearSyncBlocked,true)
    assert.equal((await workspace.query('select count(*)::int n from mikka_team_issues where "issueId"=$1',[row.id])).rows[0].n,1)
    assert.equal((await app.query('select count(*)::int n from linear_sync_outbox where "issueId"=$1',[row.id])).rows[0].n,0)
    await app.query('update team184_app_controls set fail=false where title=$1',[value.title])
    const resumed=await query(owner,value);assert.ok('issue' in resumed && resumed.issue);assert.equal(resumed.issue.id,row.id);assert.equal(resumed.issue.scope,'workspace')
    await app.query('update issues set "linearSyncPolicy"=\'disabled\',revision=revision+1 where id=$1',[row.id])
    const replay=await query(owner,value);assert.ok('issue' in replay && replay.issue);assert.equal(replay.issue.scope,'workspace')
    assert.equal((await app.query('select count(*)::int n from linear_sync_outbox where "issueId"=$1',[row.id])).rows[0].n,0)
  })
  await scopeSubtest(t, 'a changed relation while pending is not restored by retry',async()=>{
    const value={...input(teamId),title:`changed-pending-${randomUUID()}`}
    await app.query('insert into team184_app_controls (title,fail) values ($1,true)',[value.title])
    assert.deepEqual(await query(owner,value),{error:'teamIssueOutcomeUnknown',requestId:value.requestId})
    const row=(await app.query('select i.id,i.scope from issues i join team_issue_create_requests r on r."issueId"=i.id where r."requestId"=$1',[value.requestId])).rows[0]
    await workspace.query('update mikka_team_issues set "teamId"=$2 where "issueId"=$1',[row.id,badTeam])
    await app.query('update team184_app_controls set fail=false where title=$1',[value.title])
    assert.deepEqual(await query(owner,value),{error:'teamIssueChanged',requestId:value.requestId})
    assert.equal((await workspace.query('select "teamId" from mikka_team_issues where "issueId"=$1',[row.id])).rows[0].teamId,badTeam)
    assert.equal((await app.query('select scope from issues where id=$1',[row.id])).rows[0].scope,'workspace')
  })
  await scopeSubtest(t, 'lost workspace commit response retries one request and preserves workspace visibility throughout completion',async()=>{
    const value=input(teamId)
    let mode:'lost'|'unavailable'|'normal'='lost'
    // Throw only after this request’s real association transaction has committed.
    // The next attempt simulates an unavailable workspace recheck without
    // changing or deleting a fixture; restoring normal commits permits recovery.
    const restore=injectWorkspaceCommit(value.requestId, {
      beforeReceiptRead:()=>{if(mode==='unavailable') throw new Error('synthetic workspace recheck unavailable')},
      afterCommit:()=>{if(mode==='lost') {mode='unavailable';throw new Error('synthetic lost commit response')}},
    })
    try {
      assert.deepEqual(await query(owner,value),{error:'teamIssueRetry',requestId:value.requestId})
      const row=(await app.query('select i.id,i.scope,i."linearSyncBlocked" from issues i join team_issue_create_requests r on r."issueId"=i.id where r."requestId"=$1',[value.requestId])).rows[0]
      assert.equal(row.scope,'workspace');assert.equal(row.linearSyncBlocked,true)
      assert.equal((await workspace.query('select count(*)::int n from team_issue_create_receipts where "requestId"=$1',[value.requestId])).rows[0].n,1)
      assert.equal((await workspace.query('select count(*)::int n from mikka_team_issues where "issueId"=$1',[row.id])).rows[0].n,1)
      assert.ok(await issueForUser(owner,row.id));assert.ok(await issueForUser(racer,row.id))
      assert.deepEqual(await query(owner,value),{error:'teamIssueRetry',requestId:value.requestId})
      assert.equal((await app.query('select scope from issues where id=$1',[row.id])).rows[0].scope,'workspace')
      assert.equal((await app.query('select count(*)::int n from linear_sync_outbox where "issueId"=$1',[row.id])).rows[0].n,0)
      mode='normal'
      const recovered=await query(owner,value);assert.ok('issue' in recovered && recovered.issue);assert.equal(recovered.issue.id,row.id);assert.equal(recovered.issue.scope,'workspace')
      assert.equal((await app.query('select count(*)::int n from team_issue_create_requests where "requestId"=$1',[value.requestId])).rows[0].n,1)
      assert.equal((await workspace.query('select count(*)::int n from team_issue_create_receipts where "requestId"=$1',[value.requestId])).rows[0].n,1)
    } finally {restore()}
  })
  await scopeSubtest(t, 'a durable receipt with an absent relation is not restored on retry',async()=>{
    // Construct the state after a later removal without deleting any fixture.
    const value=input(teamId), {requestId,teamId:selectedTeam,...fields}=value
    const fingerprint=createHash('sha256').update(JSON.stringify({teamId:selectedTeam,...fields})).digest('hex')
    const id=randomUUID()
    const {withTaskWorkspace}=await import('../lib/task-workspace')
    await withTaskWorkspace(owner,workspaceId,()=>db.transaction(async tx=>{
      assert.ok(await createIssueForUserInTransaction(tx,owner,fields,userActor(owner),{workspaceId,id,linearSyncBlocked:true}))
      await tx.insert(teamIssueCreateRequests).values({requestId,issueId:id,ownerId:owner,teamId:selectedTeam,fingerprint})
    }))
    await workspace.query('insert into team_issue_create_receipts ("requestId","issueId","ownerId","teamId","workspaceId") values ($1,$2,$3,$4,$5)',[requestId,id,owner,selectedTeam,workspaceId])
    assert.deepEqual(await query(owner,value),{error:'teamIssueChanged',requestId})
    assert.equal((await workspace.query('select count(*)::int n from mikka_team_issues where "issueId"=$1',[id])).rows[0].n,0)
    assert.equal((await app.query('select scope from issues where id=$1',[id])).rows[0].scope,'workspace')
    assert.ok(await issueForUser(owner,id));assert.ok(await issueForUser(racer,id))
  })
  await scopeSubtest(t, 'membership revoked after a lost association commit cannot promote on retry',async()=>{
    const lostOwner=`team-lost-owner-${randomUUID()}`,value=input(teamId)
    await app.query('insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values ($1,\'Synthetic\',$2,true,now(),now())',[lostOwner,`${lostOwner}@example.invalid`])
    await workspace.query('insert into mikka_workspace_members ("workspaceId","userId",name,email,role,status) values ($1,$2,\'Synthetic\',$3,\'member\',\'active\')',[workspaceId,lostOwner,`${lostOwner}@example.invalid`])
    let once=true
    const restore=injectWorkspaceCommit(value.requestId, {afterCommit:()=>{
      if(once) {once=false;throw new Error('synthetic lost commit response')}
    }})
    try {
      // A live notification may commit on this pool before the association does.
      const other = await workspacePool.connect()
      try {
        await other.query('BEGIN')
        await other.query('SELECT 1')
        await other.query('COMMIT')
      } finally { other.release() }
      assert.deepEqual(await query(lostOwner,value),{error:'teamIssueRetry',requestId:value.requestId})
      const row=(await app.query('select i.id,i.scope from issues i join team_issue_create_requests r on r."issueId"=i.id where r."requestId"=$1',[value.requestId])).rows[0]
      await workspace.query('update mikka_workspace_members set status=\'inactive\' where "workspaceId"=$1 and "userId"=$2',[workspaceId,lostOwner])
      assert.deepEqual(await query(lostOwner,value),{error:'teamIssueAccessDenied',requestId:value.requestId})
      assert.equal((await app.query('select scope from issues where id=$1',[row.id])).rows[0].scope,'workspace')
      assert.equal(await issueForUser(lostOwner,row.id),null);assert.ok(await issueForUser(racer,row.id))
      assert.equal((await app.query('select count(*)::int n from linear_sync_outbox where "issueId"=$1',[row.id])).rows[0].n,0)
    } finally {restore()}
  })
  await scopeSubtest(t, 'revocation between association and completion revokes creator access without moving the task',async()=>{
    const revoke=await workspace.connect(),value=input(raceTeam)
    let associationCommitted=false,issueId:string|undefined
    const restore=injectWorkspaceCommit(value.requestId, {afterCommit:async()=>{
      if(associationCommitted) return
      associationCommitted=true
      // The real association COMMIT has released its locks, but its promise
      // has not returned to start completion. Inspect it from independent
      // connections before revoking in the normal Workspace -> member order.
      const receipt=await revoke.query('select r."issueId",r."ownerId",r."teamId",r."workspaceId",t."userId" as "linkedOwner",t."teamId" as "linkedTeam",t."workspaceId" as "linkedWorkspace" from team_issue_create_receipts r join mikka_team_issues t on t."issueId"=r."issueId" where r."requestId"=$1',[value.requestId])
      assert.equal(receipt.rowCount,1,'the association receipt and relation must already be committed')
      issueId=receipt.rows[0].issueId
      assert.ok(issueId)
      assert.deepEqual(receipt.rows[0],{issueId,ownerId:racer,teamId:raceTeam,workspaceId,linkedOwner:racer,linkedTeam:raceTeam,linkedWorkspace:workspaceId})
      const preparing=await app.query('select i."workspaceId",i."ownershipState",i.scope,i."linearSyncBlocked",i.revision,r.status from issues i join team_issue_create_requests r on r."issueId"=i.id where r."requestId"=$1 and i.id=$2',[value.requestId,issueId])
      assert.equal(preparing.rowCount,1)
      assert.deepEqual(preparing.rows[0],{workspaceId,ownershipState:'bound',scope:'workspace',linearSyncBlocked:true,revision:1,status:'preparing'})
      await revoke.query('begin')
      assert.equal((await revoke.query('select id from mikka_workspaces where id=$1 for update',[workspaceId])).rowCount,1)
      assert.deepEqual((await revoke.query('select status from mikka_workspace_members where "workspaceId"=$1 and "userId"=$2 for update',[workspaceId,racer])).rows,[{status:'active'}])
      assert.equal((await revoke.query('update mikka_workspace_members set status=\'inactive\' where "workspaceId"=$1 and "userId"=$2',[workspaceId,racer])).rowCount,1)
      await revoke.query('commit')
    }})
    try {
      assert.deepEqual(await query(racer,value),{error:'teamIssueAccessDenied',requestId:value.requestId})
      assert.ok(associationCommitted);assert.ok(issueId)
      const row=(await app.query('select i.id,i."workspaceId",i."ownershipState",i.scope,i."linearSyncBlocked",i.revision,r.status from issues i join team_issue_create_requests r on r."issueId"=i.id where r."requestId"=$1',[value.requestId])).rows[0]
      assert.deepEqual(row,{id:issueId,workspaceId,ownershipState:'bound',scope:'workspace',linearSyncBlocked:true,revision:1,status:'preparing'})
      assert.equal(await issueForUser(racer,row.id),null);assert.ok(await issueForUser(owner,row.id))
      assert.equal((await workspace.query('select count(*)::int n from team_issue_create_receipts r join mikka_team_issues t on t."issueId"=r."issueId" where r."requestId"=$1 and r."issueId"=$2 and r."ownerId"=$3 and r."teamId"=$4 and r."workspaceId"=$5 and t."userId"=$3 and t."teamId"=$4 and t."workspaceId"=$5',[value.requestId,issueId,racer,raceTeam,workspaceId])).rows[0].n,1)
      assert.equal((await app.query('select count(*)::int n from linear_sync_outbox where "issueId"=$1',[row.id])).rows[0].n,0)
      assert.deepEqual(await query(racer,value),{error:'teamIssueAccessDenied',requestId:value.requestId})
    } finally {restore();await revoke.query('rollback');revoke.release()}
  })
  assert.equal(externalCalls,0)
  t.diagnostic(`Retained synthetic databases: ${appName}, ${workspaceName}; real provider calls: ${externalCalls}`)
})
