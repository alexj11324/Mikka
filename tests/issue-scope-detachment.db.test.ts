import { seedFixtureWorkspace } from './helpers/task-workspace'
import { registeredTask } from './helpers/registered-task'
import { tokenWorkspace } from '../lib/tokens/principal'
import { SCOPE_DATABASES } from '../scripts/scope-acceptance-policy.mjs'
import { scopeSubtest, scopeResumeBootstrap } from './support/scope-acceptance.mjs'
import './fixtures/scope-request-runtime.mjs'
import 'next/dist/server/node-environment-baseline'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { readIssueMetadata } from '../lib/issue-metadata'
import { DAEMON_PROTOCOL_VERSION } from '@mikka/protocol/daemon'
import { REPO_ORIGIN_HEADER, RUN_LEASE_MS } from '@mikka/protocol/device'
import { remoteKey } from '@mikka/protocol/repository'
import { assertE2eTarget, disposableDatabase } from './helpers/e2e-target.mjs'

// Only a disposable loopback *_e2e database (ISSUE184_LOCAL_TEST=1: the retained
// scope service). Never fall back to business credentials. Fixtures are intentionally retained.
const url = process.env.E2E_DATABASE_URL
if (url) {
  const target = assertE2eTarget(url)
  const cloud = target.port === '55484' && target.pathname === '/issue184_e2e'
  if (!disposableDatabase() || process.env.ISSUE184_LOCAL_TEST === '1' && !cloud) throw new Error('Scope tests require an isolated E2E target or the retained scope service')
  if (process.env.MIKKA_DATABASE_URL !== url || process.env.DATABASE_URL !== url) throw new Error('Scope tests must use the same isolated application/workspace target')
}
if (!url && process.env.REQUIRE_DB === '1') throw new Error('Scope DB tests cannot skip in required CI')

test('provider policy preserves task tenancy and independent membership gates on real PostgreSQL and HTTP', { skip: !url }, async t => {
  const { Pool } = await import('pg')
  // CI's shared E2E setup creates columns, not the production triggers/FKs.
  // Bootstrap a fresh retained database from the real tracked migrations instead
  // of relying on the state left by earlier suites or changing their fixtures.
  const database = process.env.ISSUE184_LOCAL_TEST === '1'
    ? SCOPE_DATABASES.scope
    : `scope184_${randomUUID().replaceAll('-', '')}_e2e`
  const resumed=await scopeResumeBootstrap(database)
  if(!resumed){
    const admin = new Pool({ connectionString: url, max: 1 })
    try {
      assert.equal(String((await admin.query('show server_version_num')).rows[0].server_version_num).slice(0,2),'17')
      await admin.query(`create database "${database}"`)
    } finally { await admin.end() }
  }
  const target = new URL(url!)
  target.pathname = `/${database}`
  const connection = target.toString()
  const originalApplication = process.env.MIKKA_DATABASE_URL!
  const originalWorkspace = process.env.DATABASE_URL!
  process.env.MIKKA_DATABASE_URL = connection
  process.env.DATABASE_URL = connection
  t.after(() => { process.env.MIKKA_DATABASE_URL = originalApplication; process.env.DATABASE_URL = originalWorkspace })
  if(!resumed){
  const migrated = await promisify(execFile)(process.execPath, ['scripts/migrate.mjs'], {
    env: { ...process.env, MIGRATE: '1', VERCEL_ENV: '' }, maxBuffer: 4 << 20,
  })
  assert.match(migrated.stdout, /applied 20261029043637_personal_scope_detachment.sql/)
  }
  const pool = new Pool({ connectionString: connection, max: 5 })
  const { changeIssueScopeLocally } = await import('../lib/issue-scope-store')
  const { promoteExistingIssueForUser } = await import('../lib/team-issue-promotion')
  const { actAs } = await import('../lib/acting-user')
  const issueScopeActions = await import('../app/actions/issues')
  const { saveIssue, previewIssuePersonalScope } = issueScopeActions
  const { collectIssueEffects } = await import('../lib/issue-effects')
  // This suite isolates tenant, provider-generation and claim fences. The archive worker and
  // real HTTP readback are exercised by linear-archive.db.test.ts instead.
  const setIssueScope = (input: Parameters<typeof issueScopeActions.setIssueScope>[0]) => collectIssueEffects([], () => issueScopeActions.setIssueScope(input))
  const confirmIssuePersonalScope = (input: Parameters<typeof issueScopeActions.confirmIssuePersonalScope>[0]) => collectIssueEffects([], () => issueScopeActions.confirmIssuePersonalScope(input))
  const { retryLinearIssue } = await import('../app/actions/linear-sync')
  const { linearRequestTimeout } = await import('../lib/linear-sync/graphql')
  // The two tests below hold an old provider request until it times out. The
  // timeout is real (AbortSignal), only shorter than production's 12 s.
  assert.equal(linearRequestTimeout.ms, 12_000)
  const withShortLinearTimeout = async (callback: () => Promise<void>) => {
    linearRequestTimeout.ms = 2_000
    try { await callback() } finally { linearRequestTimeout.ms = 12_000 }
  }
  const { AfterContext } = await import('next/dist/server/after/after-context')
  const { workAsyncStorage } = await import('next/dist/server/app-render/work-async-storage.external')
  const { workUnitAsyncStorage } = await import('next/dist/server/app-render/work-unit-async-storage.external')
  const { createRequestStoreForAPI } = await import('next/dist/server/async-storage/request-store')
  const { NextRequest } = await import('next/server')
  // Native HTTP has no Next request context. Run the same after callbacks that
  // Next runs when a request closes, and fail if an asynchronous effect fails.
  async function withRequestContext<T>(fn: () => Promise<T>, beforeClose?: () => Promise<void>) {
    const waits: Promise<unknown>[] = [], errors: unknown[] = []
    const closes: Array<() => void> = []
    const afterContext = new AfterContext({ waitUntil: promise => { waits.push(promise) }, onClose: callback => { closes.push(callback) }, onTaskError: error => { errors.push(error) } })
    const request = new NextRequest('http://127.0.0.1/mikka')
    // Next 16.4 adds an optional HMR hash to the API request-store factory;
    // supplying it also works with the local 16.1 acceptance dependencies.
    const requestStore: ReturnType<typeof createRequestStoreForAPI> = Reflect.apply(createRequestStoreForAPI, undefined, [request, new URL(request.url), { tags: [], expirationsByCacheKind: new Map() }, undefined, undefined, undefined])
    return workAsyncStorage.run({ afterContext } as NonNullable<ReturnType<typeof workAsyncStorage.getStore>>, () => workUnitAsyncStorage.run(requestStore, async () => {
      try { const result = await fn(); await beforeClose?.(); return result }
      finally { for (const close of closes) close(); await Promise.all(waits); assert.deepEqual(errors, []) }
    }))
  }
  const inWorkspace = <T>(userId: string, fn: () => Promise<T>, workspaceId: string = workspace) => actAs({ id: userId, [tokenWorkspace]: workspaceId }, fn)
  const action = <T>(fn: () => Promise<T>, beforeClose?: () => Promise<void>) => withRequestContext(() => inWorkspace(owner, fn), beforeClose)
  const { issueForUser } = await import('../lib/issue-access')
  const { readRun, queueRun, visibleRuns } = await import('../lib/agent-runs')
  const { issueRunToken, verifyRunToken } = await import('../lib/mcp/worker')
  const { renewRunLeases } = await import('../lib/run-leases')
  const { completeRunForDevice, dispatchCompletedIssue } = await import('../lib/run-completion')
  const { persistRunCompletion, prepareRunPublication, publishRunResult } = await import('../lib/run-publications')
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
  const originalFlagKey = process.env.NEXT_PUBLIC_POSTHOG_KEY
  const flagKey = `synthetic-scope-flag-${randomUUID()}`
  process.env.NEXT_PUBLIC_POSTHOG_KEY = flagKey
  t.after(() => { if(originalFlagKey===undefined) delete process.env.NEXT_PUBLIC_POSTHOG_KEY;else process.env.NEXT_PUBLIC_POSTHOG_KEY=originalFlagKey })
  let rejectedExternalRequests = 0
  let linearLoopbackOrigin: string | undefined
  globalThis.fetch = (async (input, init) => {
    const target = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    // Keep the real feature gate and its parsing/cache. Only the external
    // provider response is synthetic, so scope checks actually run when on.
    if (target.href === 'https://us.i.posthog.com/flags?v=2') {
      assert.equal(JSON.parse(String(init?.body)).api_key,flagKey)
      return Response.json({errorsWhileComputingFlags:false,flags:{'mikka-linear-sync':{enabled:true}}})
    }
    if (target.origin === 'https://api.linear.app' && target.pathname === '/graphql' && linearLoopbackOrigin) return noExternalFetch(new URL('/graphql', linearLoopbackOrigin), init)
    if (target.hostname !== '127.0.0.1') { rejectedExternalRequests++; throw new Error('External network prohibited in scope acceptance') }
    return noExternalFetch(input, init)
  }) as typeof fetch
  t.after(async () => { globalThis.fetch = noExternalFetch; await pool.end() })
  const doc = JSON.stringify({ type: 'doc', attrs: { mikka: {} }, content: [] })
  const mainDoc = JSON.stringify({ type: 'doc', attrs: { mikka: { number: 12 } }, content: [] })
  for (const id of [owner, member]) await pool.query('insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values ($1,$2,$3,true,now(),now())', [id,'Alex',`${id}@example.invalid`])
  await pool.query('insert into issue_prefixes ("userId",prefix) values ($1,\'ALEX\')', [owner])
  const ownerPersonal = await seedFixtureWorkspace(pool, owner)
  await seedFixtureWorkspace(pool, member)
  await pool.query('insert into mikka_workspaces (id,"userId",name,kind) values ($1,$2,\'scope synthetic acceptance\',\'team\')', [workspace,owner])
  for (const id of [owner,member]) await pool.query('insert into mikka_workspace_members ("workspaceId","userId",name,email,role,status) values ($1,$2,\'Synthetic\',$3,\'member\',\'active\')', [workspace,id,`${id}@example.invalid`])
  await pool.query('insert into mikka_teams (id,"workspaceId","userId",name,identifier) values ($1,$2,$3,\'Scope\',\'MIK\')', [team,workspace,owner])
  await pool.query('insert into linear_team_syncs (id,"ownerId","linearTeamId","linearTeamKey","linearTeamName","workspaceId") values ($1,$2,$3,\'MIK\',\'Synthetic\',$4)', [sync,owner,team,workspace])
  const legacyFailed=randomUUID(), legacyImported=randomUUID(), legacyLink=randomUUID()
  const policyFunctions = ['prevent_blocked_linear_publish','enqueue_linear_issue_sync','detach_personal_issue','protect_verified_linear_target','require_explicit_workspace_scope','preserve_linear_block','preserve_linear_archive_request']
  const policyTriggers = ['prevent_blocked_linear_outbox','prevent_blocked_linear_link','preserve_linear_block','protect_verified_linear_target','preserve_linear_archive_request']
  const readPolicyFunctions = () => pool.query<{ name: string; definition: string }>(`SELECT p.proname AS name,pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=ANY($1::text[]) ORDER BY p.proname`,[policyFunctions]).then(result=>result.rows)
  const currentFunctions = await readPolicyFunctions()
  const currentTriggers = (await pool.query<{ table: string; name: string; definition: string }>(`SELECT c.relname AS table,t.tgname AS name,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal AND t.tgname=ANY($1::text[]) ORDER BY t.tgname`,[policyTriggers])).rows
  const currentOutboxIndex = (await pool.query<{ definition: string }>(`SELECT pg_get_indexdef('linear_sync_outbox_open_issue_key'::regclass) AS definition`)).rows[0].definition
  try {
    // Recreate the pre-verification migration state in this fresh synthetic DB
    // so an unlinked terminal job can exist exactly as it could before 2242.
    // Only this fresh fixture database receives the historical DDL. Its current
    // function/trigger definitions are restored exactly before application reads.
    // Restore the old index contract too: 2241's ON CONFLICT predicate predates
    // the archive operation column. This is the newly created fixture DB only.
    await pool.query(`drop index linear_sync_outbox_open_issue_key;
    create unique index linear_sync_outbox_open_issue_key on linear_sync_outbox("issueId") where status in ('queued','processing')`)
    await pool.query(await readFile(new URL('../drizzle/20261029043641_team_issue_creation_gate.sql',import.meta.url),'utf8'))
    await registeredTask(pool, owner, workspace, legacyFailed, client => client.query('insert into issues (id,"userId",title,content,status,priority,scope,"workspaceId","ownershipState","linearSyncPolicy") values ($1,$2,\'Legacy failed-only task\',$3,\'todo\',\'normal\',\'workspace\',$4,\'bound\',\'explicit\')',[legacyFailed,owner,doc,workspace]))
    await pool.query('update linear_sync_outbox set status=\'failed\',attempts=8 where "issueId"=$1',[legacyFailed])
    assert.equal((await pool.query('select count(*)::int n from linear_sync_outbox where "issueId"=$1 and status=\'failed\'',[legacyFailed])).rows[0].n,1)
    fixtureIds.push(legacyFailed)
    // A synthetic legacy Linear-origin task imported before verified-target
    // migration, now on generation 2. The trusted migration derives the flag
    // from its immutable revision-1 Linear history; no fixture sets it directly.
    await registeredTask(pool, owner, workspace, legacyImported, client => client.query('insert into issues (id,"userId",title,content,status,priority,scope,"scopeVersion",revision,"workspaceId","ownershipState","linearSyncPolicy") values ($1,$2,\'Legacy imported task\',$3,\'todo\',\'normal\',\'workspace\',2,1,$4,\'bound\',\'explicit\')',[legacyImported,owner,doc,workspace]))
    await pool.query('insert into issue_versions (id,"issueId","userId",revision,title,content,status,priority,actor_type,actor_id) values ($1,$2,$3,1,\'Legacy imported task\',$4,\'todo\',\'normal\',\'system\',\'linear\')',[randomUUID(),legacyImported,owner,doc])
    await pool.query('insert into linear_issue_links (id,"issueId","ownerId","teamSyncId","linearIssueId","linearIdentifier") values ($1,$2,$3,$4,$2::uuid::text,\'MIK-legacy\')',[legacyLink,legacyImported,owner,sync])
    await pool.query('update linear_sync_outbox set status=\'done\' where "issueId"=$1',[legacyImported])
    assert.equal((await pool.query('select "externalTargetVerified" from linear_issue_links where id=$1',[legacyLink])).rows[0].externalTargetVerified,false)
    // Replay the tracked migration's legacy backfill while the isolated DB has
    // only this synthetic legacy fixture. It includes its normal trigger DDL.
    await pool.query(await readFile(new URL('../drizzle/20261029043643_require_verified_team_promotion.sql',import.meta.url),'utf8'))
    // Restore the subsequent tracked scope gate; the older migration replaces
    // its function body. The finally block then restores the current P0 policy.
    await pool.query(await readFile(new URL('../drizzle/20261029043644_team_issue_promotions.sql',import.meta.url),'utf8'))
    await pool.query(await readFile(new URL('../drizzle/20261031050735_archive_linear_on_personal_scope.sql',import.meta.url),'utf8'))
    assert.equal((await pool.query('select "externalTargetVerified" from linear_issue_links where id=$1',[legacyLink])).rows[0].externalTargetVerified,true)
    fixtureIds.push(legacyImported)
  } finally {
    for (const saved of currentFunctions) await pool.query(saved.definition)
    for (const saved of currentTriggers) {
      await pool.query(`DROP TRIGGER "${saved.name}" ON "${saved.table}"`)
      await pool.query(saved.definition)
    }
    await pool.query('DROP INDEX linear_sync_outbox_open_issue_key')
    await pool.query(currentOutboxIndex)
  }
  assert.deepEqual(await readPolicyFunctions(),currentFunctions,'historical backfill must not replace the current tenant/provider policy')
  const claimHarnesses = JSON.stringify([{harness:'codex',installed:true,toolApproval:true}])
  const memberRemote = `https://github.com/mikka-ci/scope-member-${device}.git`
  const ownerRemote = `https://github.com/mikka-ci/scope-owner-${ownerDevice}.git`
  await pool.query('insert into devices (id,"ownerId",name,"protocolVersion",harnesses) values ($1,$2,\'Synthetic\',$3,$4)', [device,member,DAEMON_PROTOCOL_VERSION,claimHarnesses])
  await pool.query('insert into agents (id,"userId",harness,name,"deviceId") values ($1,$2,\'codex\',\'Synthetic\',$3)', [agent,member,device])
  await pool.query('insert into device_repos (id,"deviceId","userId","repoPath","remoteUrl","baseBranch") values ($1,$2,$3,$4,$5,\'main\')', [repo,device,member,remoteKey(memberRemote),memberRemote])
  await pool.query('insert into devices (id,"ownerId",name,"protocolVersion",harnesses) values ($1,$2,\'Synthetic owner\',$3,$4)', [ownerDevice,owner,DAEMON_PROTOCOL_VERSION,claimHarnesses])
  await pool.query('insert into agents (id,"userId",harness,name,"deviceId") values ($1,$2,\'codex\',\'Synthetic owner\',$3)', [ownerAgent,owner,ownerDevice])
  await pool.query('insert into device_repos (id,"deviceId","userId","repoPath","remoteUrl") values ($1,$2,$3,$4,$5)', [ownerRepo,ownerDevice,owner,remoteKey(ownerRemote),ownerRemote])
  const deviceToken = `synthetic-${randomUUID()}`
  await pool.query('insert into device_tokens (id,"userId","tokenHash") values ($1,$2,$3)', [randomUUID(),member,hashDeviceToken(deviceToken)])
  const [teamSync] = await db.select().from(linearTeamSyncs).where(eq(linearTeamSyncs.id,sync))
  const remote = (id: string) => ({ id, identifier:'MIK-184', title:'Stale external title', description:'Old workspace description', dueDate:null, priority:0, url:'https://example.invalid/synthetic',updatedAt:new Date(Date.now()+60000).toISOString(),state:null,team:{id:team,key:'MIK',name:'Synthetic'},assignee:null,labels:[] })
  const { loadIssueDocument, encodedIssueDocument } = await import('../lib/linear-sync/document')
  async function seed(id: string, remoteId = id, linked = true) {
    if (!fixtureIds.includes(id)) fixtureIds.push(id)
    const content = id === issue ? mainDoc : doc
    await registeredTask(pool, owner, workspace, id, async tx => {
      // These are explicit synthetic provider-origin rows. Keep every current
      // tenant/target trigger enabled; real new imports are exercised below.
      await tx.query("select set_config('mikka.linear_sync_source','linear',true)")
      await tx.query(`insert into issues (id,"userId",title,content,status,priority,scope,"workspaceId","ownershipState","linearSyncPolicy","scopeSetBy") values ($1,$2,'Synthetic scope task',$3,'todo','normal','workspace',$4,'bound','explicit','user')`,[id,owner,content,workspace])
      await tx.query(`insert into issue_versions (id,"issueId","userId",revision,title,content,status,priority,actor_type,actor_id) select $2,id,"userId",1,title,content,status,priority,'system','linear' from issues where id=$1`,[id,randomUUID()])
      const document=loadIssueDocument(null,JSON.parse(content))
      try { await tx.query('insert into issue_documents ("issueId","userId",state) values ($1,$2,$3)',[id,owner,encodedIssueDocument(document)]) }
      finally { document.destroy() }
      if(linked) await tx.query(`insert into linear_issue_links (id,"issueId","ownerId","teamSyncId","linearIssueId","linearIdentifier","externalTargetVerified","linearUpdatedAt") values ($1,$2,$3,$4,$5,'MIK-184',true,'2020-01-01T00:00:00Z')`,[randomUUID(),id,owner,sync,remoteId])
      await tx.query('insert into mikka_team_issues ("issueId","teamId","workspaceId","userId") values ($1,$2,$3,$4)',[id,team,workspace,owner])
    })
    if(linked) await pool.query('insert into linear_sync_outbox (id,"issueId","scopeVersion") values ($1,$2,1)',[randomUUID(),id])
  }
  const localFlip = async (id: string, revision = 1) => {
    const before=(await pool.query('select "workspaceId",scope,number from issues where id=$1',[id])).rows[0]
    const result=await changeIssueScopeLocally(owner,{id,revision,scope:'personal'},{allowLinkedPersonal:true})
    if('issue' in result && result.issue) {
      assert.equal(result.issue.workspaceId,before.workspaceId,'provider settings cannot transfer a task')
      assert.equal(result.issue.scope,before.scope,'the compatibility scope label is unchanged')
      assert.equal(readIssueMetadata(result.issue.content).number,Number(before.number),'provider settings retain the task number')
    }
    return result
  }
  const setMembership = (userId: string,status: 'active' | 'suspended',workspaceId: string=workspace) => pool.query('update mikka_workspace_members set status=$3 where "workspaceId"=$1 and "userId"=$2',[workspaceId,userId,status])
  await seed(issue)
  const [originalLink] = await db.select().from(linearIssueLinks).where(eq(linearIssueLinks.issueId, issue))
  for (const [id,user] of [[memberRun,member],[ownerRun,owner]]) await pool.query('insert into agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId",status,"leaseExpiresAt") values ($1,$2,$3,$4,$5,$6,\'queued\',now()+interval \'1 minute\')', [id,user,issue,user===owner?ownerAgent:agent,user===owner?ownerDevice:device,user===owner?ownerRepo:repo])
  await pool.query('update agent_runs set status=\'running\' where id=$1',[ownerRun])
  const memberToken = (await issueRunToken({id:memberRun,userId:member})).token
  const ownerToken = (await issueRunToken({id:ownerRun,userId:owner})).token
  async function withClaimServer(check: (origin: string)=>Promise<void>, runId = memberRun) {
    const server = createServer(async (incoming,outgoing) => {
      const request = new Request(`http://127.0.0.1${incoming.url}`,{method:'POST',headers:{'x-mikka-client-version':incoming.headers['x-mikka-client-version']?.toString()??'',authorization:incoming.headers.authorization??'',[REPO_ORIGIN_HEADER]:incoming.headers[REPO_ORIGIN_HEADER]?.toString()??''}})
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
    await registeredTask(pool, owner, workspace, id, client => client.query('insert into issues (id,"userId",title,content,status,priority,scope,"workspaceId","ownershipState") values ($1,$2,\'Ship team work urgently\',$3,\'todo\',\'normal\',\'personal\',$4,\'bound\')',[id,owner,doc,workspace]))
    await pool.query('insert into mikka_team_issues ("issueId","teamId","workspaceId","userId") values ($1,$2,$3,$4)',[id,team,workspace,owner])
    const { judgeIssueScope }=await import('../lib/issue-scope-judge')
    for (const context of ['Telegram','the Mikka app','ambiguous team conversation']) await judgeIssueScope(id,context)
    await assert.rejects(pool.query('update issues set scope=\'workspace\',"scopeConfidence"=0.99 where id=$1 and "scopeSetBy"=\'agent\'',[id]),(error:unknown)=>(error as {code:string}).code==='23514')
    assert.deepEqual((await pool.query('select scope,"scopeSetBy" from issues where id=$1',[id])).rows[0],{scope:'personal',scopeSetBy:'agent'})
    assert.equal((await pool.query('select count(*)::int n from linear_sync_outbox where "issueId"=$1',[id])).rows[0].n,0)
    assert.equal((await pool.query('select count(*)::int n from linear_issue_publications where "issueId"=$1',[id])).rows[0].n,0)
    assert.ok('issue' in await promoteExistingIssueForUser(owner,{requestId:randomUUID(),issueId:id,revision:1,teamId:team,expectedTeamId:team}))
    assert.deepEqual((await pool.query('select scope,"scopeSetBy" from issues where id=$1',[id])).rows[0],{scope:'personal',scopeSetBy:'user'})
  })
  await scopeSubtest(t, 'owner preview rejects stale external state and confirmation retires linked tasks',async()=>{
    const id=randomUUID();await seed(id,id,false)
    const first=await inWorkspace(owner,()=>previewIssuePersonalScope(id))
    assert.ok('preview' in first && first.preview);assert.equal(first.preview.externalCopyPossible,false)
    assert.deepEqual(await inWorkspace(member,()=>previewIssuePersonalScope(id)),{error:'issueScopeOwnerOnly'})
    await pool.query('insert into linear_issue_publications (id,"issueId","ownerId","teamSyncId","scopeVersion","linearIssueId") values ($1,$2,$3,$4,1,$5)',[randomUUID(),id,owner,sync,randomUUID()])
    assert.deepEqual(await inWorkspace(owner,()=>confirmIssuePersonalScope({id,revision:first.preview.revision,confirmation:first.preview.confirmation})),{error:'issueStale'})
    const next=await inWorkspace(owner,()=>previewIssuePersonalScope(id))
    assert.ok('preview' in next && next.preview);assert.equal(next.preview.externalCopyPossible,true);assert.equal(next.preview.hasLinearLink,false)
    assert.ok('issue' in await inWorkspace(owner,()=>confirmIssuePersonalScope({id,revision:next.preview.revision,confirmation:next.preview.confirmation})))
    assert.deepEqual((await pool.query('select scope,"workspaceId","linearSyncPolicy" from issues where id=$1',[id])).rows[0],{scope:'workspace',workspaceId:workspace,linearSyncPolicy:'disabled'})
    assert.equal((await pool.query('select count(*)::int n from linear_sync_outbox where "issueId"=$1 and operation=\'archive\'',[id])).rows[0].n,1)
    const linkedId=randomUUID();await seed(linkedId)
    const linked=await inWorkspace(owner,()=>previewIssuePersonalScope(linkedId))
    assert.ok('preview' in linked && linked.preview);assert.equal(linked.preview.hasLinearLink,true);assert.equal(linked.preview.externalCopyPossible,true)
    assert.ok('issue' in await inWorkspace(owner,()=>confirmIssuePersonalScope({id:linkedId,revision:linked.preview.revision,confirmation:linked.preview.confirmation})))
    const safe=randomUUID();await seed(safe,safe,false)
    const safePreview=await inWorkspace(owner,()=>previewIssuePersonalScope(safe))
    assert.ok('preview' in safePreview && safePreview.preview);assert.equal(safePreview.preview.externalCopyPossible,false)
    const accepted=await inWorkspace(owner,()=>confirmIssuePersonalScope({id:safe,revision:safePreview.preview.revision,confirmation:safePreview.preview.confirmation}))
    assert.ok('issue' in accepted && accepted.issue);assert.equal(accepted.issue.scope,'workspace');assert.equal(accepted.issue.workspaceId,workspace);assert.equal(accepted.issue.linearSyncPolicy,'disabled')
  })
  await scopeSubtest(t, 'restricted internal callers, owner checks and stale revisions leave no partial state', async () => {
    assert.ok(await issueForUser(member,issue))
    assert.ok(await readRun(member,memberRun))
    assert.ok(await verifyRunToken(new Request('http://127.0.0.1/'),memberToken))
    assert.deepEqual(await inWorkspace(member,()=>setIssueScope({id:issue,revision:1,scope:'personal'})),{error:'issueScopeOwnerOnly'})
    assert.deepEqual(await changeIssueScopeLocally(owner,{id:issue,revision:1,scope:'personal'},{allowLinkedPersonal:false}),{error:'issueScopeInLinear'})
    assert.deepEqual(await changeIssueScopeLocally(member,{id:issue,revision:1,scope:'personal'},{allowLinkedPersonal:true}),{error:'issueScopeOwnerOnly'})
    assert.deepEqual(await localFlip(issue,99),{error:'issueStale'})
    assert.equal((await pool.query('select count(*)::int n from linear_issue_detachments where "issueId"=$1',[issue])).rows[0].n,0)
  })
  await scopeSubtest(t, 'the same native claim route succeeds while workspace access is still active', async () => {
    await withClaimServer(async origin=>{
      const response=await fetch(`${origin}/claim`,{method:'POST',headers:{'x-mikka-client-version':'0.0.456',authorization:`Bearer ${deviceToken}`,[REPO_ORIGIN_HEADER]:'1'}})
      assert.equal(response.status,200,await response.clone().text())
      const claimed=await response.json()
      assert.equal(claimed.runId,memberRun)
      assert.ok(await verifyRunToken(new Request(`${origin}/`),claimed.mcp.token))
    })
  })
  await scopeSubtest(t, 'disabling provider synchronization preserves an admitted claim and its tenant', async () => {
    const id=randomUUID(),run=randomUUID(),barrier=18430127
    await seed(id,id,false)
    await pool.query('insert into agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId",status,prompt) values ($1,$2,$3,$4,$5,$6,\'queued\',\'private claim race instructions\')',[run,member,id,agent,device,repo])
    // This fixture-specific trigger pauses an admitted token write. Provider
    // policy changes must remain independent of its held membership lease.
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
          responsePromise=fetch(`${origin}/claim`,{method:'POST',headers:{'x-mikka-client-version':'0.0.456',authorization:`Bearer ${deviceToken}`,[REPO_ORIGIN_HEADER]:'1'}})
          await waitFor(async()=>Boolean((await pool.query("select 1 from pg_stat_activity a where a.wait_event_type='Lock' and $1=any(pg_blocking_pids(a.pid))",[pid])).rowCount),'claim did not pause before token issuance')
          assert.equal((await pool.query('select status from agent_runs where id=$1',[run])).rows[0].status,'preparing')
          const preview=await inWorkspace(owner,()=>previewIssuePersonalScope(id))
          assert.ok('preview' in preview && preview.preview)
          const changed=await inWorkspace(owner,()=>confirmIssuePersonalScope({id,revision:1,confirmation:preview.preview.confirmation}))
          assert.ok('issue' in changed)
          await blocker.query('select pg_advisory_unlock($1)',[barrier]);held=false
          const response=await responsePromise
          assert.equal(response.status,200,await response.clone().text())
          const claimed=await response.json()
          assert.equal(claimed.runId,run)
          assert.match(JSON.stringify(claimed),/private claim race instructions/)
          assert.ok(await verifyRunToken(new Request(`${origin}/`),claimed.mcp.token))
          assert.deepEqual((await pool.query('select status,"workspaceId" from agent_runs where id=$1',[run])).rows[0],{status:'preparing',workspaceId:workspace})
          assert.equal((await pool.query('select count(*)::int n from run_tokens where "runId"=$1 and "revokedAt" is null',[run])).rows[0].n,1)
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
    const original=await inWorkspace(owner,()=>issueScopeActions.getIssue(issue))
    assert.ok('issue' in original && original.issue)
    const results = await Promise.all([localFlip(issue),localFlip(issue)])
    assert.equal(results.filter(result=>'issue' in result).length,1)
    assert.equal(results.filter(result=>'error' in result && result.error==='issueStale').length,1)
    const saved = results.find(result=>'issue' in result)!
    assert.ok(saved.issue)
    assert.equal(saved.issue.identifier,original.issue.identifier,'provider policy must retain the existing task identifier')
    assert.equal(readIssueMetadata(saved.issue.content).number,12)
    const row = (await pool.query('select scope,"workspaceId","linearSyncPolicy","scopeSetBy","scopeConfidence",revision from issues where id=$1',[issue])).rows[0]
    assert.deepEqual(row,{scope:'workspace',workspaceId:workspace,linearSyncPolicy:'disabled',scopeSetBy:'user',scopeConfidence:null,revision:2})
    assert.equal((await pool.query('select count(*)::int n from issue_versions where "issueId"=$1',[issue])).rows[0].n,2)
    assert.equal((await pool.query('select count(*)::int n from linear_issue_detachments where "issueId"=$1',[issue])).rows[0].n,1)
    assert.equal((await pool.query('select count(*)::int n from linear_issue_links where "issueId"=$1',[issue])).rows[0].n,0)
    assert.equal((await pool.query('select count(*)::int n from linear_sync_outbox where "issueId"=$1 and operation=\'sync\' and status<>\'done\'',[issue])).rows[0].n,0)
  })
  await scopeSubtest(t, 'provider policy retains task/run access; membership suspension revokes execution independently', async () => {
    assert.ok(await issueForUser(member,issue))
    assert.ok(await readRun(member,memberRun))
    assert.ok((await visibleRuns(member,{issueId:issue})).some(run=>run.id===memberRun))
    assert.ok(await verifyRunToken(new Request('http://127.0.0.1/'),memberToken))
    assert.ok((await renewRunLeases(device,[memberRun])).leases[memberRun])
    const generation=(await pool.query('select "scopeVersion" from issues where id=$1',[issue])).rows[0].scopeVersion
    await setMembership(member,'suspended')
    try {
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
      const row = (await pool.query('select status,"leaseExpiresAt","stopRequestedAt","workspaceId" from agent_runs where id=$1',[memberRun])).rows[0]
      assert.equal(row.status,'preparing'); assert.ok(row.stopRequestedAt);assert.equal(row.workspaceId,workspace)
      assert.ok(new Date(row.leaseExpiresAt).getTime()<=Date.now())
      const runCount=(await pool.query('select count(*)::int n from agent_runs where "issueId"=$1',[issue])).rows[0].n
      await assert.rejects(queueRun(member,{issueId:issue,agentId:agent,repo:'https://github.com/mikka-ci/scope-fixture.git',model:'fixture-model'}),/issueNotFound/)
      await assert.rejects(issueRunToken({id:memberRun,userId:member}))
      assert.equal((await pool.query('select count(*)::int n from agent_runs where "issueId"=$1',[issue])).rows[0].n,runCount)
      assert.equal((await pool.query('select "scopeVersion" from issues where id=$1',[issue])).rows[0].scopeVersion,generation,'membership revocation is independent of provider generation')
    } finally { await setMembership(member,'active') }
  })
  await scopeSubtest(t, 'native claim route rejects a suspended member over real loopback HTTP', async () => {
    await setMembership(member,'suspended')
    try {
      await withClaimServer(async origin=>{
        assert.equal((await fetch(`${origin}/claim`,{method:'POST'})).status,401)
        const response=await fetch(`${origin}/claim`,{method:'POST',headers:{'x-mikka-client-version':'0.0.456',authorization:`Bearer ${deviceToken}`}})
        assert.equal(response.status,409)
        assert.equal((await response.text()).includes('prompt'),false)
      })
    } finally { await setMembership(member,'active') }
  })
  await scopeSubtest(t, 'the creator has no membership bypass for task, run or execution token', async () => {
    await setMembership(owner,'suspended')
    try {
      assert.equal(await issueForUser(owner,issue),null)
      assert.equal(await readRun(owner,ownerRun),null)
      assert.equal(Boolean(await verifyRunToken(new Request('http://127.0.0.1/'),ownerToken)),false)
      assert.deepEqual((await renewRunLeases(ownerDevice,[ownerRun])).revoked,[ownerRun])
      await assert.rejects(issueRunToken({id:ownerRun,userId:owner}))
      assert.ok(await issueForUser(member,issue),'another active member keeps the shared task')
    } finally { await setMembership(owner,'active') }
  })
  await scopeSubtest(t, 'replayed imports, forced snapshots and outbox retries cannot re-enable disabled synchronization', async () => {
    for (let index=0;index<2;index++) assert.equal(await createAppIssueFromLinear(teamSync,remote(issue)),null)
    assert.equal(await applyLinearIssueToApp(teamSync,remote(issue),true),null)
    await pool.query('insert into linear_sync_outbox (id,"issueId") values ($1,$2)',[randomUUID(),issue])
    await processLinearIssueOutbox(issue)
    await syncAppIssueToLinear(issue)
    assert.deepEqual((await pool.query('select scope,"workspaceId","linearSyncPolicy" from issues where id=$1',[issue])).rows[0],{scope:'workspace',workspaceId:workspace,linearSyncPolicy:'disabled'})
    assert.equal((await pool.query('select count(*)::int n from linear_sync_outbox where "issueId"=$1 and operation=\'sync\' and status<>\'done\'',[issue])).rows[0].n,0)
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
  await scopeSubtest(t, 'version write failure rolls back provider policy, tombstone, link and outbox together', async () => {
    const id=randomUUID();await seed(id)
    const constraint=`scope_rollback_${id.replaceAll('-','')}`
    // Additive, fixture-specific failure injection; no existing row is changed.
    await pool.query(`alter table issue_versions add constraint ${constraint} check ("issueId" <> '${id}'::uuid) not valid`)
    await assert.rejects(localFlip(id))
    assert.deepEqual((await pool.query('select scope,"workspaceId","linearSyncPolicy" from issues where id=$1',[id])).rows[0],{scope:'workspace',workspaceId:workspace,linearSyncPolicy:'explicit'})
    assert.equal((await pool.query('select count(*)::int n from linear_issue_links where "issueId"=$1',[id])).rows[0].n,1)
    assert.equal((await pool.query('select count(*)::int n from linear_issue_detachments where "issueId"=$1',[id])).rows[0].n,0)
    assert.equal((await pool.query('select status from linear_sync_outbox where "issueId"=$1',[id])).rows[0].status,'queued')
  })
  await scopeSubtest(t, 'queue racing provider disable retains the same authorized task tenant', async () => {
    const id=randomUUID();await seed(id)
    const lock=await pool.connect()
    try {
      await lock.query('begin');await lock.query('select id from issues where id=$1 for update',[id])
      const run=randomUUID()
      const raced=pool.query('insert into agent_runs (id,"userId","issueId","agentId",status) values ($1,$2,$3,$4,\'queued\')',[run,member,id,agent]).then(()=>({error:null}),error=>({error}))
      // A separate connection is actually waiting for our row lock, not a timer.
      for (let n=0;n<100;n++) {
        await lock.query('select pg_stat_clear_snapshot()')
        const waiting=await lock.query("select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like 'insert into agent_runs%'")
        if (waiting.rows[0].n) break
        if(n===99) assert.fail('queue did not reach the scope lock')
      }
      await lock.query("update issues set \"linearSyncPolicy\"='disabled',\"linearSyncBlocked\"=true where id=$1",[id]);await lock.query('commit');assert.equal((await raced).error,null)
      assert.deepEqual((await pool.query('select status,"workspaceId" from agent_runs where id=$1',[run])).rows[0],{status:'queued',workspaceId:workspace})
    } finally { await lock.query('rollback');lock.release() }
  })
  await scopeSubtest(t, 'provider policy does not wait for an unrelated heartbeat row or cancel its run', async () => {
    const id=randomUUID(),run=randomUUID();await seed(id)
    await pool.query(`insert into agent_runs (id,"userId","issueId","agentId",status) values ($1,$2,$3,$4,'running')`,[run,member,id,agent])
    const writer=await pool.connect()
    let transition: ReturnType<typeof localFlip> | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await writer.query('begin')
      await writer.query('select id from agent_runs where id=$1 for update',[run])
      transition=localFlip(id)
      const result=await Promise.race([transition,new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new Error('provider policy waited on an unrelated run')),3_000)})])
      assert.ok('issue' in result && result.issue)
      assert.equal(result.issue.revision,2)
      assert.equal((await writer.query('select status from agent_runs where id=$1',[run])).rows[0].status,'running')
      await writer.query('update agent_runs set "updatedAt"=now() where id=$1',[run])
      await writer.query('commit')
      assert.equal((await pool.query('select count(*)::int n from issue_versions where "issueId"=$1',[id])).rows[0].n,2)
    } finally {if(timeout)clearTimeout(timeout);await writer.query('rollback');writer.release();if(transition) await Promise.allSettled([transition])}
  })
  await scopeSubtest(t, 'HTTP completion delayed before persistence cannot write or dispatch after independent membership revocation', async () => {
    const localOwner=`complete-owner-${randomUUID()}`,id=randomUUID(),run=randomUUID()
    fixtureIds.push(id)
    await pool.query('insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values ($1,\'Complete owner\',$2,true,now(),now())',[localOwner,`${localOwner}@example.invalid`])
    await pool.query('insert into mikka_workspace_members ("workspaceId","userId",name,email,role,status) values ($1,$2,\'Complete owner\',$3,\'member\',\'active\')',[workspace,localOwner,`${localOwner}@example.invalid`])
    await registeredTask(pool, localOwner, workspace, id, client => client.query('insert into issues (id,"userId",title,content,status,priority,scope,"workspaceId","ownershipState","linearSyncPolicy") values ($1,$2,\'Unlinked completion fixture\',$3,\'todo\',\'normal\',\'workspace\',$4,\'bound\',\'explicit\')',[id,localOwner,doc,workspace]))
    await pool.query('insert into mikka_team_issues ("issueId","teamId","workspaceId","userId") values ($1,$2,$3,$4)',[id,team,workspace,localOwner])
    await pool.query('insert into agent_runs (id,"userId","issueId","agentId","deviceId",status) values ($1,$2,$3,$4,$5,\'running\')',[run,member,id,agent,device])
    const prepared=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
    const handlerErrors:unknown[]=[]
    const server=createServer(async(incoming,outgoing)=>{
      const chunks:Buffer[]=[];for await(const chunk of incoming) chunks.push(Buffer.from(chunk))
      const body=Buffer.concat(chunks).toString()
      const request=new Request(`http://127.0.0.1${incoming.url}`,{method:'POST',headers:{'x-mikka-client-version':incoming.headers['x-mikka-client-version']?.toString()??'',authorization:incoming.headers.authorization??''},body})
      request.json=async()=>{prepared.resolve();await release.promise;return JSON.parse(body)}
      try {const response=await withRequestContext(()=>complete.POST(request,{params:Promise.resolve({runId:run})}));outgoing.writeHead(response.status);outgoing.end(await response.text())}
      catch(error) {handlerErrors.push(error);outgoing.writeHead(500);outgoing.end('Completion failed')}
    })
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
    let responsePromise:Promise<Response>|undefined
    try {
      const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`
      const report={summary:'Synthetic verified completion',filesChanged:[],verify:{status:'passed'},openQuestions:[],nextStep:null}
      responsePromise=fetch(`${origin}/complete`,{method:'POST',headers:{'x-mikka-client-version':'0.0.456',authorization:`Bearer ${deviceToken}`,'content-type':'application/json'},body:JSON.stringify({stopReason:'submitted',report})})
      await prepared.promise
      const changed=await inWorkspace(localOwner,()=>setIssueScope({id,revision:1,scope:'personal'}))
      assert.ok('issue' in changed)
      assert.deepEqual(await inWorkspace(localOwner,()=>setIssueScope({id,revision:1,scope:'personal'})),{error:'issueStale'})
      assert.equal((await pool.query('select status from agent_runs where id=$1',[run])).rows[0].status,'running','provider policy alone does not stop execution')
      await setMembership(member,'suspended')
      release.resolve()
      const response=await responsePromise
      assert.deepEqual(handlerErrors,[],'the real completion handler and its after callbacks must succeed')
      assert.equal(response.status,404,'the post-body run read must hide a task whose membership was revoked')
      const row=(await pool.query('select status,scope,"workspaceId","linearSyncPolicy" from issues where id=$1',[id])).rows[0]
      assert.deepEqual(row,{status:'todo',scope:'workspace',workspaceId:workspace,linearSyncPolicy:'disabled'})
      assert.equal((await pool.query('select status from agent_runs where id=$1',[run])).rows[0].status,'running')
      assert.equal((await pool.query('select count(*)::int n from linear_sync_outbox where "issueId"=$1',[id])).rows[0].n,0)
      assert.equal((await pool.query('select count(*)::int n from coordinator_events where "runId"=$1',[run])).rows[0].n,0)
    } finally {release.resolve();if(responsePromise) await Promise.allSettled([responsePromise]);await setMembership(member,'active');await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}
  })
  await scopeSubtest(t, 'Factory authority follows immutable tenancy and current membership across provider policy changes', async () => {
    const { factoryStore } = await import('../lib/factory/server')
    const { FactoryError } = await import('../lib/factory/contract')
    const id = randomUUID()
    await seed(id,id,false)
    const original = await inWorkspace(owner,()=>issueScopeActions.getIssue(id))
    assert.ok('issue' in original && original.issue)
    const generation = original.issue.scopeVersion
    async function source(userId: string) {
      const sourceEventId = randomUUID()
      await pool.query('insert into coordinator_events (id,"userId","issueId",kind,payload,"dedupeKey") values ($1,$2,$3,\'user_message\',$4,$5)', [sourceEventId,userId,id,JSON.stringify({text:'Synthetic authorized Factory request'}),`factory-scope:${sourceEventId}`])
      return { issueId:id,eventId:randomUUID(),sourceEventId,rationale:'Synthetic authorized Factory request' }
    }
    const memberRoute = await source(member), ownerRoute = await source(owner)
    const memberTask = (await factoryStore.route(member,memberRoute)).task
    const ownerTask = (await factoryStore.route(owner,ownerRoute)).task
    const binding = (task: typeof memberTask) => ({ taskId:task.id,issueId:task.issueId,attemptId:task.attemptId,candidateId:task.candidateId,revision:task.revision })
    assert.equal(memberTask.scopeVersion,generation)
    assert.equal(ownerTask.scopeVersion,generation)
    assert.equal((await factoryStore.read(member,memberTask.id)).task.id,memberTask.id)
    assert.deepEqual((await factoryStore.listForIssue(member,id)).tasks.map(task=>task.id),[memberTask.id])
    const denied = (error: unknown) => error instanceof FactoryError && error.code === 'factoryNotFound'
    const counts = async () => (await pool.query(`select
      (select count(*)::int from factory_tasks where "issueId"=$1) tasks,
      (select count(*)::int from factory_attempts a join factory_tasks t on t.id=a."taskId" where t."issueId"=$1) attempts,
      (select count(*)::int from factory_events e join factory_tasks t on t.id=e."taskId" where t."issueId"=$1) events,
      (select count(*)::int from agent_runs where "issueId"=$1) runs`,[id])).rows[0]
    const retired = await changeIssueScopeLocally(owner, {id,revision:original.issue.revision,scope:'personal'}, {allowLinkedPersonal:false})
    assert.ok('issue' in retired && retired.issue)
    assert.equal((await factoryStore.read(member,memberTask.id)).task.id,memberTask.id)
    assert.equal((await factoryStore.read(owner,ownerTask.id)).task.id,ownerTask.id)
    const restored = await promoteExistingIssueForUser(owner, {requestId:randomUUID(),issueId:id,revision:retired.issue.revision,teamId:team,expectedTeamId:team})
    assert.ok('issue' in restored && restored.issue)
    assert.equal(restored.issue.scopeVersion,generation+1,'disable changes provider generation once; regrouping does not change it again')
    assert.equal((await factoryStore.read(member,memberTask.id)).task.scopeVersion,generation,'the old provider generation is not the tenant grant')
    assert.equal(restored.issue.workspaceId,workspace)
    assert.equal((await factoryStore.route(member,memberRoute)).task.id,memberTask.id)
    const before = await counts()
    await setMembership(member,'suspended')
    try {
      await assert.rejects(factoryStore.read(member,memberTask.id),denied)
      await assert.rejects(factoryStore.route(member,memberRoute),denied)
      await assert.rejects(factoryStore.apply(member,binding(memberTask),randomUUID(),{action:'cancel',reason:'Suspended member request'}),denied)
      const tx = await pool.connect()
      try {
        await tx.query('begin')
        await assert.rejects(factoryStore.lockForDispatch(member,binding(memberTask),randomUUID(),tx),denied)
      } finally { await tx.query('rollback');tx.release() }
      await assert.rejects(factoryStore.listForIssue(member,id),denied)
      assert.deepEqual(await counts(),before)
      assert.equal((await factoryStore.route(owner,ownerRoute)).task.id,ownerTask.id)
    } finally { await setMembership(member,'active') }
    assert.equal((await factoryStore.read(member,memberTask.id)).task.id,memberTask.id)
    assert.deepEqual((await factoryStore.listForIssue(member,id)).tasks.map(task=>task.id),[memberTask.id])
    // Historical provider generations are optional once both rows have the
    // same bound tenant; they never override current member or task ownership.
    await pool.query('update factory_tasks set "scopeVersion"=null where id=any($1::uuid[])',[[memberTask.id,ownerTask.id]])
    assert.equal((await factoryStore.read(member,memberTask.id)).task.scopeVersion,null)
    assert.equal((await factoryStore.route(member,memberRoute)).task.id,memberTask.id)
    await assert.rejects(factoryStore.read(owner,memberTask.id),denied)
    assert.deepEqual(await counts(),before)
    const stopped = await factoryStore.apply(owner,binding(ownerTask),randomUUID(),{action:'cancel',reason:'Active owner retains cancellation authority'})
    assert.equal(stopped.task.status,'cancelled')
    assert.equal(stopped.task.scopeVersion,null)
    assert.equal((await pool.query('select "scopeVersion" from factory_tasks where id=$1',[memberTask.id])).rows[0].scopeVersion,null)
  })
  const passedReport={summary:'Synthetic completion',filesChanged:[],verify:{status:'passed' as const},openQuestions:[],nextStep:null}
  async function completionFixture(issueOwner: string, actor: string, scope='workspace', kind='implement', withIssue=true, withTeam=true) {
    const id=randomUUID(),run=randomUUID()
    const fixtureWorkspace=scope==='workspace'?workspace:await seedFixtureWorkspace(pool,issueOwner)
    if(withIssue) {
      fixtureIds.push(id)
      await registeredTask(pool, issueOwner, fixtureWorkspace, id, client => client.query(`insert into issues (id,"userId",title,content,status,priority,scope,"workspaceId","ownershipState","linearSyncPolicy") values ($1,$2,'Completion fixture',$3,'todo','normal',$4,$5,'bound',$6)`,[id,issueOwner,doc,scope,fixtureWorkspace,scope==='workspace'?'explicit':'disabled']))
      if(withTeam && scope==='workspace') await pool.query('insert into mikka_team_issues ("issueId","teamId","workspaceId","userId") values ($1,$2,$3,$4)',[id,team,workspace,issueOwner])
    }
    await pool.query(`insert into agent_runs (id,"userId","issueId","workspaceId","agentId","deviceId",status,kind,"leaseExpiresAt") values ($1,$2,$3,$4,$5,$6,'running',$7,$8)`,[run,actor,withIssue?id:null,fixtureWorkspace,actor===owner?ownerAgent:agent,actor===owner?ownerDevice:device,kind,new Date(Date.now()+RUN_LEASE_MS)])
    return {id,run,issueId:withIssue?id:null}
  }
  await scopeSubtest(t, 'publication-aware completion preserves retirement and later-generation dispatch fences', async()=>{
    const fixture=await completionFixture(member,owner)
    const completed=await persistRunCompletion(owner,fixture.run,{stopReason:'submitted',report:passedReport},ownerDevice)
    assert.ok(completed?.review)
    const saved=(await pool.query('select revision from issues where id=$1',[fixture.id])).rows[0]
    assert.ok('issue' in await changeIssueScopeLocally(member,{id:fixture.id,revision:saved.revision,scope:'personal'},{allowLinkedPersonal:true}))
    const before=(await pool.query('select status,revision,content from issues where id=$1',[fixture.id])).rows[0]
    let dispatched=0
    assert.equal(await dispatchCompletedIssue(completed,()=>{dispatched++}),false)
    const replay=await persistRunCompletion(owner,fixture.run,{stopReason:'error'},ownerDevice)
    assert.ok(replay && !replay.publicationPending && !replay.review)
    assert.deepEqual((await pool.query('select status,revision,content from issues where id=$1',[fixture.id])).rows[0],before)
    assert.ok('issue' in await promoteExistingIssueForUser(member,{requestId:randomUUID(),issueId:fixture.id,revision:before.revision,teamId:team,expectedTeamId:team}))
    assert.equal(await dispatchCompletedIssue(completed,()=>{dispatched++}),false)
    assert.equal(dispatched,0)
    assert.equal((await pool.query('select count(*)::int n from coordinator_events where "runId"=$1',[fixture.run])).rows[0].n,1)
  })
  async function publicationFixture(actor = member) {
    const fixture = await completionFixture(owner, actor)
    await pool.query('insert into linear_issue_links (id,"issueId","ownerId","teamSyncId","linearIssueId","linearIdentifier") values ($1,$2,$3,$4,$5,\'MIK-184\')', [randomUUID(), fixture.id, owner, sync, randomUUID()])
    const remote = `https://github.com/mikka-ci/publication-${randomUUID()}.git`
    const { remoteKey } = await import('@mikka/protocol/repository')
    // Admission writes the task's receipt and publication; this fixture does the same.
    const reserved = await prepareRunPublication({ id: fixture.run, userId: actor, issueId: fixture.id, baseBranch: null }, remote)
    assert.ok(reserved.pushBranch)
    const { rows: [run] } = await pool.query('select "deviceId","agentId" from agent_runs where id=$1', [fixture.run])
    const now = new Date().toISOString()
    await pool.query('update agent_runs set "agentDefinition"=$2 where id=$1', [fixture.run, JSON.stringify({ repositoryAdmission: { userId: actor, issueId: fixture.id, deviceId: run.deviceId, agentId: run.agentId, remoteKey: remoteKey(remote), remoteUrl: remote, permission: 'push_to_origin', targetBranch: reserved.pushBranch, authority: 'owner_credential', acceptedAt: now } })])
    const assignment = await prepareRunPublication({ id: fixture.run, userId: actor, issueId: fixture.id, baseBranch: null, deviceId: run.deviceId, agentId: run.agentId, botId: null, agentDefinition: (await pool.query('select "agentDefinition" from agent_runs where id=$1', [fixture.run])).rows[0].agentDefinition }, remote)
    assert.equal(assignment.policy.permissions.git_push, 'allow')
    assert.ok(assignment.pushBranch)
    return { ...fixture, report: { ...passedReport, publish: { branch: assignment.pushBranch, remote: 'origin' as const, pushed: true, commit: 'b'.repeat(40) } } }
  }
  async function pendingPublicationFixture() {
    const fixture = await publicationFixture()
    assert.equal((await persistRunCompletion(member, fixture.run, { stopReason: 'submitted', report: fixture.report }, device))?.publicationPending, true)
    return fixture
  }
  async function retirePublicationFixture(fixture: { id: string }, repromote: boolean) {
    const current = (await pool.query('select revision from issues where id=$1', [fixture.id])).rows[0]
    const retired = await changeIssueScopeLocally(owner, { id: fixture.id, revision: current.revision, scope: 'personal' }, { allowLinkedPersonal: true })
    assert.ok('issue' in retired && retired.issue)
    await pool.query('update issues set title=\'Private later title\' where id=$1', [fixture.id])
    if (repromote) assert.ok('issue' in await promoteExistingIssueForUser(owner, { requestId: randomUUID(), issueId: fixture.id, revision: retired.issue.revision, teamId: team, expectedTeamId: team }))
  }
  await scopeSubtest(t, 'the owner can finish after retirement using frozen inputs without mutating the new scope', async () => {
    const fixture = await publicationFixture(owner)
    assert.deepEqual((await pool.query('select "scopeVersion","issueTitle" from run_publications where "runId"=$1', [fixture.run])).rows[0], { scopeVersion: 1, issueTitle: 'Completion fixture' })
    await retirePublicationFixture(fixture, false)
    const before = (await pool.query('select * from issues where id=$1', [fixture.id])).rows[0]
    assert.equal((await persistRunCompletion(owner, fixture.run, { stopReason: 'submitted', report: fixture.report }, ownerDevice))?.publicationPending, true, 'the owner retains authority over their own run')
    let writes = 0
    const pr = { url: 'https://github.com/mikka-ci/fixture/pull/3', state: 'open' as const }
    assert.deepEqual(await publishRunResult(fixture.run, async input => {
      assert.equal(input.title, 'Completion fixture', 'later private title never becomes old publication input')
      assert.ok(input.withWrite)
      return input.withWrite(async () => { writes++; return pr })
    }), { done: true })
    assert.equal(writes, 1)
    assert.deepEqual((await pool.query('select status,"pullRequest","errorCode" from run_publications where "runId"=$1', [fixture.run])).rows[0], { status: 'published', pullRequest: pr, errorCode: 'issue_unavailable' })
    assert.deepEqual((await pool.query('select * from issues where id=$1', [fixture.id])).rows[0], before, 'late receipt cannot modify later-generation task history/status')
    assert.deepEqual((await pool.query('select payload from coordinator_events where "runId"=$1 and kind=\'run_finished\'', [fixture.run])).rows[0].payload.publication.pullRequest, pr)
    await persistRunCompletion(owner, fixture.run, { stopReason: 'submitted', report: { ...fixture.report, summary: 'Altered replay' } }, ownerDevice)
    assert.deepEqual((await pool.query('select * from issues where id=$1', [fixture.id])).rows[0], before)
  })
  await scopeSubtest(t, 'old teammate publication cannot revive after scope retirement and re-promotion', async () => {
    const fixture = await pendingPublicationFixture()
    await retirePublicationFixture(fixture, true)
    const before = (await pool.query('select title,status,revision,content,"scopeVersion" from issues where id=$1', [fixture.id])).rows[0]
    let calls = 0
    assert.deepEqual(await publishRunResult(fixture.run, async () => { calls++; throw new Error('Retired generation must not reach GitHub') }), { done: true })
    assert.equal(calls, 0)
    assert.equal((await pool.query('select "errorCode" from run_publications where "runId"=$1', [fixture.run])).rows[0].errorCode, 'issue_unavailable')
    assert.deepEqual((await pool.query('select title,status,revision,content,"scopeVersion" from issues where id=$1', [fixture.id])).rows[0], before)
  })
  await scopeSubtest(t, 'retirement during GitHub lookups fences the final write and freezes the original title', async () => {
    const fixture = await pendingPublicationFixture()
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    let writes = 0
    const publishing = publishRunResult(fixture.run, async input => {
      assert.equal(input.title, 'Completion fixture')
      assert.ok(input.withWrite)
      entered.resolve(); await release.promise
      return input.withWrite(async () => { writes++; return { url: 'https://github.com/mikka-ci/fixture/pull/1', state: 'open' as const } })
    })
    try {
      await Promise.race([entered.promise, publishing.then(() => { throw new Error('Publication ended before provider lookup') })])
      await retirePublicationFixture(fixture, false)
      const before = (await pool.query('select title,status,revision,content from issues where id=$1', [fixture.id])).rows[0]
      release.resolve()
      assert.deepEqual(await publishing, { done: true })
      assert.equal(writes, 0)
      assert.deepEqual((await pool.query('select title,status,revision,content from issues where id=$1', [fixture.id])).rows[0], before)
    } finally { release.resolve(); await publishing.catch(() => {}) }
  })
  await scopeSubtest(t, 'a started provider write fences retirement but its late receipt cannot modify re-promoted scope', async () => {
    const fixture = await pendingPublicationFixture()
    const entered = Promise.withResolvers<void>(), releaseWrite = Promise.withResolvers<void>(), wrote = Promise.withResolvers<void>(), releaseResult = Promise.withResolvers<void>()
    const pr = { url: 'https://github.com/mikka-ci/fixture/pull/2', state: 'open' as const }
    const publishing = publishRunResult(fixture.run, async input => {
      assert.ok(input.withWrite)
      const result = await input.withWrite(async () => { entered.resolve(); await releaseWrite.promise; return pr })
      wrote.resolve(); await releaseResult.promise
      return result
    })
    let retired = false
    let retiring: Promise<void> | undefined
    try {
      await Promise.race([entered.promise, publishing.then(() => { throw new Error('Publication ended before its fenced write') })])
      const holder = (await pool.query("select pid from pg_stat_activity where datname=current_database() and state='idle in transaction' and query like '%run_publications%for update%'")).rows
      assert.equal(holder.length, 1, 'one publication transaction stays open through provider IO')
      retiring = retirePublicationFixture(fixture, true).then(() => { retired = true })
      let waiting = false
      for (let n = 0; n < 100 && !waiting; n++) {
        waiting = (await pool.query('select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) waiting', [holder[0].pid])).rows[0].waiting
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10))
      }
      assert.equal(waiting, true, 'retirement really contends on the publication transaction')
      assert.equal(retired, false, 'scope retirement waits until the bounded external write returns')
      releaseWrite.resolve(); await wrote.promise; await retiring
      const before = (await pool.query('select title,status,revision,content,"scopeVersion" from issues where id=$1', [fixture.id])).rows[0]
      releaseResult.resolve()
      assert.deepEqual(await publishing, { done: true })
      const receipt = (await pool.query('select status,"pullRequest","errorCode" from run_publications where "runId"=$1', [fixture.run])).rows[0]
      assert.deepEqual(receipt, { status: 'published', pullRequest: pr, errorCode: 'issue_unavailable' })
      assert.deepEqual((await pool.query('select title,status,revision,content,"scopeVersion" from issues where id=$1', [fixture.id])).rows[0], before)
    } finally { releaseWrite.resolve(); releaseResult.resolve(); await Promise.allSettled([publishing, ...(retiring ? [retiring] : [])]) }
  })
  await scopeSubtest(t, 'creator suspension before a provider write leaves the task and history unchanged',async()=>{
    const fixture=await publicationFixture(owner)
    assert.equal((await persistRunCompletion(owner,fixture.run,{stopReason:'submitted',report:fixture.report},ownerDevice))?.publicationPending,true)
    const before=(await pool.query('select * from issues where id=$1',[fixture.id])).rows[0]
    const events=(await pool.query('select count(*)::int n from coordinator_events where "runId"=$1',[fixture.run])).rows[0].n
    await setMembership(owner,'suspended')
    try {
      let writes=0
      assert.deepEqual(await publishRunResult(fixture.run,async()=>{writes++;throw new Error('Suspended creator cannot reach GitHub')}),{done:true})
      assert.equal(writes,0)
      assert.deepEqual((await pool.query('select * from issues where id=$1',[fixture.id])).rows[0],before)
      assert.equal((await pool.query('select count(*)::int n from coordinator_events where "runId"=$1',[fixture.run])).rows[0].n,events)
      assert.deepEqual((await pool.query('select status,"pullRequest","errorCode" from run_publications where "runId"=$1',[fixture.run])).rows[0],{status:'blocked',pullRequest:null,errorCode:'issue_unavailable'})
    } finally {await setMembership(owner,'active')}
  })
  await scopeSubtest(t, 'membership suspension waits for an admitted provider write and its late result only records a receipt',async()=>{
    const fixture=await pendingPublicationFixture()
    const entered=Promise.withResolvers<void>(),releaseWrite=Promise.withResolvers<void>(),wrote=Promise.withResolvers<void>(),releaseResult=Promise.withResolvers<void>()
    const pr={url:'https://github.com/mikka-ci/fixture/pull/4',state:'open' as const}
    const before=(await pool.query('select * from issues where id=$1',[fixture.id])).rows[0]
    const events=(await pool.query('select count(*)::int n from coordinator_events where "runId"=$1',[fixture.run])).rows[0].n
    const publishing=publishRunResult(fixture.run,async input=>{
      assert.ok(input.withWrite)
      const receipt=await input.withWrite(async()=>{entered.resolve();await releaseWrite.promise;return pr})
      wrote.resolve();await releaseResult.promise;return receipt
    })
    let suspending:ReturnType<typeof setMembership>|undefined,suspended=false
    try {
      await Promise.race([entered.promise,publishing.then(()=>{throw new Error('Provider write was not reached')})])
      suspending=setMembership(member,'suspended').then(value=>{suspended=true;return value})
      await waitFor(async()=>Boolean((await pool.query("select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like 'update mikka_workspace_members set status=%'")).rowCount),'suspension did not wait for the admitted provider write')
      assert.equal(suspended,false)
      releaseWrite.resolve();await wrote.promise;await suspending
      releaseResult.resolve();assert.deepEqual(await publishing,{done:true})
      assert.deepEqual((await pool.query('select * from issues where id=$1',[fixture.id])).rows[0],before)
      assert.equal((await pool.query('select count(*)::int n from coordinator_events where "runId"=$1',[fixture.run])).rows[0].n,events)
      assert.deepEqual((await pool.query('select status,"pullRequest","errorCode" from run_publications where "runId"=$1',[fixture.run])).rows[0],{status:'published',pullRequest:pr,errorCode:'issue_unavailable'})
    } finally {releaseWrite.resolve();releaseResult.resolve();await Promise.allSettled([publishing,...(suspending?[suspending]:[])]);await setMembership(member,'active')}
  })
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
      assert.deepEqual((await pool.query('select status,scope from issues where id=$1',[fixture.id])).rows[0],{status:'review',scope:'workspace'})
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
      if(control.actor===member) assert.equal((await complete.POST(new Request('http://127.0.0.1/complete',{method:'POST',headers:{'x-mikka-client-version':'0.0.456',authorization:`Bearer ${deviceToken}`},body:'invalid-json'}),{params:Promise.resolve({runId:fixture.run})})).status,204)
    }
    const orphan=await completionFixture(owner,owner,'personal','implement',false)
    const completed=await completeRunForDevice(owner,{id:orphan.run,issueId:null},{stopReason:'error'})
    assert.ok(completed);assert.equal(completed.review,null)
    assert.equal((await pool.query('select status from agent_runs where id=$1',[orphan.run])).rows[0].status,'failed')
  })
  await scopeSubtest(t, 'shared completion requires current membership without requiring a Team relation or provider synchronization',async()=>{
    const fixture=await completionFixture(owner,member,'workspace','implement',true,false)
    await localFlip(fixture.id)
    assert.equal((await pool.query('select count(*)::int n from mikka_team_issues where "issueId"=$1',[fixture.id])).rows[0].n,0)
    const completed=await completeRunForDevice(member,{id:fixture.run,issueId:fixture.id},{stopReason:'submitted',report:passedReport})
    assert.ok(completed?.review)
    assert.equal((await pool.query('select status,"workspaceId" from agent_runs where id=$1',[fixture.run])).rows[0].workspaceId,workspace)
    assert.equal((await pool.query('select count(*)::int n from coordinator_events where "runId"=$1',[fixture.run])).rows[0].n,1)
    let dispatched=0
    assert.equal(await dispatchCompletedIssue(completed,()=>{dispatched++}),false)
    assert.equal(dispatched,0,'completion access does not restore disabled provider work')
    const creator=await completionFixture(owner,owner,'workspace','implement',true,false)
    const before=(await pool.query('select * from agent_runs where id=$1',[creator.run])).rows[0]
    await setMembership(owner,'suspended')
    try {
      assert.equal(await completeRunForDevice(owner,{id:creator.run,issueId:creator.id},{stopReason:'submitted',report:passedReport}),null)
      assert.equal(await persistRunCompletion(owner,creator.run,{stopReason:'submitted',report:passedReport},ownerDevice),null)
      assert.deepEqual((await pool.query('select * from agent_runs where id=$1',[creator.run])).rows[0],before)
      assert.equal((await pool.query('select count(*)::int n from coordinator_events where "runId"=$1',[creator.run])).rows[0].n,0)
    } finally {await setMembership(owner,'active')}
  })
  await scopeSubtest(t, 'completion retries a real heartbeat lock-order deadlock and commits one event',async()=>{
    const fixture=await completionFixture(owner,member),writer=await pool.connect()
    let finishing:Promise<{result:Awaited<ReturnType<typeof persistRunCompletion>>;error:unknown}>|undefined
    try {
      await writer.query('begin');await writer.query("set local deadlock_timeout='5s'")
      await writer.query('select id from agent_runs where id=$1 for update',[fixture.run])
      const pid=(await writer.query('select pg_backend_pid() pid')).rows[0].pid
      finishing=persistRunCompletion(member,fixture.run,{stopReason:'submitted',report:passedReport},device).then(result=>({result,error:null}),error=>({result:null,error}))
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
    // Poll on a clock, not a spin: 300 back-to-back queries can finish in ~200ms on a fast runner.
    for(let n=0;n<300;n++) {if(await check()) return;await new Promise(resolve=>setTimeout(resolve,20))}
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
    const privateContent={type:'doc',attrs:{mikka:{}},content:[{type:'paragraph',content:[{type:'text',text:'privatebodysecret'}]}]}
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
  await scopeSubtest(t, 'public app and MCP creation use the explicit tenant without inferring Linear consent',async()=>{
    const calls=provider.requests.length
    const {createIssue}=await import('../lib/mcp/actions')
    for(const selectedWorkspace of [ownerPersonal,workspace]) {
      const app=await withRequestContext(()=>inWorkspace(owner,()=>saveIssue({title:'Team context alone',content:JSON.parse(doc),status:'todo',priority:'normal'}),selectedWorkspace))
      assert.ok('issue' in app && app.issue);fixtureIds.push(app.issue.id)
      const bot=await withRequestContext(()=>inWorkspace(owner,()=>createIssue(owner,{title:'Ambiguous work task',body:'Perhaps for the team'}),selectedWorkspace))
      assert.ok('id' in bot);fixtureIds.push(bot.id)
      for(const id of [app.issue.id,bot.id]) {
        assert.deepEqual((await pool.query('select "workspaceId","ownershipState","linearSyncPolicy" from issues where id=$1',[id])).rows[0],{workspaceId:selectedWorkspace,ownershipState:'bound',linearSyncPolicy:'disabled'})
        assert.equal((await pool.query('select count(*)::int n from linear_sync_outbox where "issueId"=$1',[id])).rows[0].n,0)
        assert.equal((await pool.query('select count(*)::int n from linear_issue_publications where "issueId"=$1',[id])).rows[0].n,0)
      }
      const before=(await pool.query('select * from issues where id=$1',[app.issue.id])).rows[0]
      await assert.rejects(pool.query('update issues set "workspaceId"=$2 where id=$1',[app.issue.id,selectedWorkspace===workspace?ownerPersonal:workspace]),(error:unknown)=>(error as {code:string}).code==='23514')
      assert.deepEqual((await pool.query('select * from issues where id=$1',[app.issue.id])).rows[0],before)
      if(selectedWorkspace===ownerPersonal) {
        const promotion=await promoteExistingIssueForUser(owner,{requestId:randomUUID(),issueId:app.issue.id,revision:1,teamId:team,expectedTeamId:null})
        assert.ok('error' in promotion);assert.equal(promotion.error,'teamIssueAccessDenied')
        assert.deepEqual((await pool.query('select * from issues where id=$1',[app.issue.id])).rows[0],before)
        assert.equal((await pool.query('select count(*)::int n from mikka_team_issues where "issueId"=$1',[app.issue.id])).rows[0].n,0)
      }
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
      await locker.query('update issues set "linearSyncPolicy"=\'disabled\',"linearSyncBlocked"=true,revision=revision+1 where id=$1',[id])
      await locker.query('commit')
      const snapshot=(await pool.query('select title,status,scope,revision,"updatedAt" from issues where id=$1',[id])).rows[0]
      await delivery
      assert.deepEqual((await pool.query('select title,status,scope,revision,"updatedAt" from issues where id=$1',[id])).rows[0],snapshot)
      assert.equal((await pool.query('select count(*)::int n from linear_issue_links where "issueId"=$1',[id])).rows[0].n,0)
      assert.equal(provider.requests.length,beforeCalls)
    } finally {await locker.query('rollback');locker.release();if(delivery) await Promise.allSettled([delivery])}
  })
  await scopeSubtest(t, 'external UUID collision with personal task cannot clear diagnostics or change personal data',async()=>{
    const result=await withRequestContext(()=>inWorkspace(owner,()=>saveIssue({title:'Personal external collision',content:JSON.parse(doc),status:'todo',priority:'normal'}),ownerPersonal))
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
  await scopeSubtest(t, 'retired reservations cannot trigger incoming lookups or clear later diagnostics',async()=>{
    const id=randomUUID();await seed(id,id,false)
    const remoteId=randomUUID(),reservation=randomUUID()
    await pool.query('insert into linear_issue_publications (id,"issueId","ownerId","teamSyncId","scopeVersion","linearIssueId") values ($1,$2,$3,$4,1,$5)',[reservation,id,owner,sync,remoteId])
    await privatize(id);const promoted=await republish(id)
    await assert.rejects(pool.query('insert into linear_issue_publications (id,"issueId","ownerId","teamSyncId","scopeVersion","linearIssueId") values ($1,$2,$3,$4,$5,$6)',[randomUUID(),id,owner,sync,promoted.scopeVersion,randomUUID()]),(error:unknown)=>(error as {code:string}).code==='23514')
    assert.equal((await pool.query('select "retiredAt" is not null retired from linear_issue_publications where id=$1',[reservation])).rows[0].retired,true)
    assert.equal((await pool.query('select count(*)::int n from linear_issue_publications where "issueId"=$1',[id])).rows[0].n,1)
    provider.issues.set(remoteId,remote(remoteId))
    await pool.query('update linear_team_syncs set "lastError"=\'preserved-blocked-diagnostic\' where id=$1',[sync])
    const snapshot=(await pool.query('select title,status,scope,revision,"updatedAt" from issues where id=$1',[id])).rows[0]
    const calls=provider.requests.length
    await inbound('Issue','update',{id:remoteId,teamId:team})
    assert.deepEqual((await pool.query('select title,status,scope,revision,"updatedAt" from issues where id=$1',[id])).rows[0],snapshot)
    assert.equal((await pool.query('select "lastError" from linear_team_syncs where id=$1',[sync])).rows[0].lastError,'preserved-blocked-diagnostic')
    assert.equal((await pool.query('select count(*)::int n from linear_issue_links where "issueId"=$1',[id])).rows[0].n,0)
    assert.equal(provider.requests.length,calls,'the retained retired identity is rejected before any provider lookup')
  })
  await scopeSubtest(t, 'a genuinely new remote task still imports through the authorized team and clears its diagnostic',async()=>{
    const id=randomUUID();provider.issues.set(id,remote(id))
    await pool.query('update linear_team_syncs set "lastError"=\'new-remote-control\' where id=$1',[sync])
    const calls=provider.requests.length
    await inbound('Issue','update',{id,teamId:team})
    const current=(await pool.query('select i.id,i.scope,i."workspaceId",i."ownershipState",i."linearSyncPolicy",i."linearSyncBlocked",l."externalTargetVerified" from issues i join linear_issue_links l on l."issueId"=i.id where l."linearIssueId"=$1',[id])).rows[0]
    assert.ok(current);assert.notEqual(current.id,id);fixtureIds.push(current.id)
    assert.deepEqual(current,{id:current.id,scope:'workspace',workspaceId:workspace,ownershipState:'bound',linearSyncPolicy:'explicit',linearSyncBlocked:false,externalTargetVerified:true})
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
      assert.deepEqual(snapshot,{scope:'workspace',title:'personal-only-draft'})
      const before=provider.requests.length
      hold.release();await request
      assert.deepEqual((await pool.query('select scope,title from issues where id=$1',[id])).rows[0],snapshot)
      assert.equal((await pool.query('select count(*)::int n from linear_issue_links where "issueId"=$1',[id])).rows[0].n,0)
      assert.equal((await pool.query('select count(*)::int n from linear_sync_outbox where "issueId"=$1 and operation=\'sync\' and status<>\'done\'',[id])).rows[0].n,0)
      await syncAppIssueToLinear(id);await processLinearIssueOutbox(id)
      assert.ok(provider.requests.slice(before).every(call=>['MikkaLinearArchiveState','MikkaLinearArchiveIssue'].includes(call.operation)), 'only the explicit old-target archive may run after retirement')
      assert.equal(JSON.stringify(provider.requests.filter(record=>record.variables.id===id||record.variables.input?.id===id)).includes('personal-only-draft'),false)
      assert.equal(JSON.stringify(provider.requests.filter(record=>record.variables.id===id||record.variables.input?.id===id)).includes('privatebodysecret'),false)
      assert.equal([...provider.comments.values()].some(comment=>comment.issue.id===id),false)
    } finally {hold.release();await request}
  })
  await scopeSubtest(t, 'old in-flight update cannot attach, publish edits or upload comments after explicit Mikka promotion',()=>withShortLinearTimeout(async()=>{
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
      await pool.query('update linear_sync_outbox set status=\'queued\',"claimToken"=$2 where "issueId"=$1 and operation=\'sync\' and "scopeVersion"=1',[id,randomUUID()])
      assert.deepEqual((await pool.query('select status,"claimToken","scopeVersion" from linear_sync_outbox where "issueId"=$1 and operation=\'sync\' and "scopeVersion"=1',[id])).rows[0],{status:'failed',claimToken:null,scopeVersion:1})
      await pool.query('update issues set title=\'post-promotion-edit\' where id=$1',[id])
      await setDiscussion(id,'post-promotion-comment')
      assert.deepEqual(await action(()=>retryLinearIssue(id)),{error:'linearIssueInvalid'})
      await syncAppIssueToLinear(id);await processLinearIssueOutbox(id)
      assert.ok(provider.requests.slice(before).every(call=>['MikkaLinearArchiveState','MikkaLinearArchiveIssue'].includes(call.operation)), 'a new Mikka generation cannot authorize old sync writes')
      assert.equal((await pool.query('select count(*)::int n from linear_issue_links where "issueId"=$1',[id])).rows[0].n,0)
      assert.equal((await pool.query('select count(*)::int n from linear_issue_publications where "issueId"=$1',[id])).rows[0].n,1)
      assert.equal((await pool.query('select "retiredAt" is not null retired from linear_issue_publications where id=$1',[oldPublication.id])).rows[0].retired,true)
      assert.equal(JSON.stringify(provider.requests).includes('privatebodysecret'),false)
      assert.equal(JSON.stringify(provider.requests).includes('post-promotion-edit'),false)
      assert.equal([...provider.comments.values()].some(comment=>comment.issue.id===id),false)
    } finally {hold.release();await old}
  }))
  await scopeSubtest(t, 'late retired provider failure cannot attach a link or change later diagnostics',()=>withShortLinearTimeout(async()=>{
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
  }))
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
    await registeredTask(pool, owner, workspace, id, client => client.query('insert into issues (id,"userId",title,content,status,priority,scope,"workspaceId","ownershipState") values ($1,$2,\'Explicit team control\',$3,\'todo\',\'normal\',\'personal\',$4,\'bound\')',[id,owner,doc,workspace]))
    const before=provider.requests.length
    assert.deepEqual(await action(()=>setIssueScope({id,revision:1,scope:'workspace'})),{error:'issueScopeTeamRequired'})
    const result=await promoteExistingIssueForUser(owner,{requestId:randomUUID(),issueId:id,revision:1,teamId:team,expectedTeamId:null})
    assert.ok('issue' in result && result.issue);assert.equal(result.issue.linearSyncBlocked,true)
    assert.equal((await pool.query('select "scopeVersion" from issues where id=$1',[id])).rows[0].scopeVersion,1,'grouping alone cannot grant a new provider generation')
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
      await lock.query('update issues set "linearSyncPolicy"=\'disabled\',"linearSyncBlocked"=true,revision=revision+1 where id=$1',[id])
      const calls=provider.requests.length;await lock.query('commit')
      assert.deepEqual(await retry,{error:'linearIssueInvalid'});assert.equal(provider.requests.length,calls)
      assert.equal((await pool.query('select count(*)::int n from linear_sync_outbox where "issueId"=$1 and operation=\'sync\' and status<>\'done\'',[id])).rows[0].n,0)
    } finally {await lock.query('rollback');lock.release();if(retry) await retry}
  })
  await scopeSubtest(t, 'retiring an uncertain publication retains archive work without guessing an external target',async()=>{
    const id=randomUUID();await seed(id,id,false)
    const publication=randomUUID()
    await pool.query('insert into linear_issue_publications (id,"issueId","ownerId","teamSyncId","scopeVersion","linearIssueId") values ($1,$2,$3,$4,1,$5)',[publication,id,owner,sync,randomUUID()])
    const calls=provider.requests.length
    assert.ok('issue' in await inWorkspace(owner,()=>setIssueScope({id,revision:1,scope:'personal'})))
    assert.equal((await pool.query('select count(*)::int n from linear_issue_publications where id=$1',[publication])).rows[0].n,1)
    assert.deepEqual((await pool.query('select scope,revision from issues where id=$1',[id])).rows[0],{scope:'workspace',revision:2})
    assert.equal((await pool.query('select "archiveTarget" from linear_sync_outbox where "issueId"=$1 and operation=\'archive\'',[id])).rows[0].archiveTarget.targetVerified,false)
    assert.equal(provider.requests.length,calls)
  })
  await scopeSubtest(t, 'retained failed sync retires locally while keeping unresolved archive work',async()=>{
    assert.equal((await pool.query('select count(*)::int n from linear_issue_links where "issueId"=$1',[legacyFailed])).rows[0].n,0)
    assert.equal((await pool.query('select count(*)::int n from linear_issue_publications where "issueId"=$1',[legacyFailed])).rows[0].n,0)
    assert.equal((await pool.query('select count(*)::int n from linear_sync_outbox where "issueId"=$1 and status=\'failed\'',[legacyFailed])).rows[0].n,1)
    assert.ok('issue' in await inWorkspace(owner,()=>setIssueScope({id:legacyFailed,revision:1,scope:'personal'})))
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
  const privacyEvidence: { caller: string; denied: boolean; safePublicDuplicate: boolean }[] = []
  await scopeSubtest(t, 'in-flight actions cannot mix content across a provider-generation change', async () => {
    const issueActions = await import('../app/actions/issues')
    const metadataActions = await import('../app/actions/issue-metadata')
    const operations = await import('../app/actions/issue-operations')
    const collaboration = await import('../app/actions/collaboration')
    const { withDatabaseTransaction } = await import('../lib/db')
    const { sql } = await import('drizzle-orm')
    const Y = await import('yjs')
    for (const caller of ['document', 'preference', 'save', 'metadata', 'relation-target', 'duplicate-source', 'duplicate-descendant', 'history', 'members', 'options', 'get', 'legacy-get', 'republished-document'] as const) {
      const target = randomUUID(); await seed(target, target, false)
      // The database never lets a task lose its number; the read must leave it exactly as it was.
      const numberBefore = Number((await pool.query('select number from issues where id=$1',[target])).rows[0].number)
      let source = target
      if (caller === 'relation-target' || caller === 'duplicate-descendant') { source = randomUUID(); await seed(source, source, false) }
      for (const id of new Set([source, target])) await pool.query('insert into issue_members ("issueId","userId","memberId") values ($1,$2,$3)', [id,owner,member])
      if (caller === 'duplicate-descendant') await pool.query('update issues set content=jsonb_set(content,\'{attrs,mikka,parentId}\',to_jsonb($2::text),true) where id=$1', [target,source])
      const privateText = `synthetic-private-fence-${randomUUID()}`
      const privateDoc = new Y.Doc(), paragraph = new Y.XmlElement('paragraph'), text = new Y.XmlText()
      text.insert(0, privateText); paragraph.insert(0, [text]); privateDoc.getXmlFragment('default').insert(0, [paragraph])
      const privateState = Buffer.from(Y.encodeStateAsUpdate(privateDoc)).toString('base64'); privateDoc.destroy()
      const beforeMemberIssues = Number((await pool.query('select count(*) from issues where "userId"=$1',[member])).rows[0].count)
      const invoke = async (): Promise<unknown> => {
        switch (caller) {
          case 'document': case 'republished-document': return collaboration.exchangeDocument({id:target})
          case 'preference': return operations.toggleIssuePreference({id:target,kind:'favorite'})
          // Deliberately predict the future revision: optimistic concurrency
          // is not a replacement for the captured generation and current member checks.
          case 'save': return issueActions.saveIssue({id:target,revision:3,title:'Late teammate edit',content:JSON.parse(doc),status:'todo',priority:'normal'})
          case 'metadata': return metadataActions.updateIssueMetadata({id:target,revision:3,patch:{estimate:5}})
          case 'relation-target': return operations.updateIssueRelation({id:source,revision:1,targetId:target,kind:'related'})
          case 'duplicate-source': return operations.createLinkedIssue({id:target,revision:3,kind:'duplicate'})
          case 'duplicate-descendant': return operations.createLinkedIssue({id:source,revision:1,kind:'duplicate',includeSubissues:true})
          case 'history': return issueActions.listIssueVersions(target)
          case 'members': return collaboration.listMembers(target)
          case 'options': return metadataActions.getIssuePropertyOptions(target)
          case 'get': case 'legacy-get': return issueActions.getIssue(target)
        }
      }
      let response: Promise<{value?:unknown;error?:unknown}> | undefined
      try {
        await db.transaction(async tx => {
          await tx.execute(sql`select id from issues where id=${target} for update`)
          const pid = Number((await tx.execute(sql`select pg_backend_pid() pid`)).rows[0].pid)
          // The owner transaction is not installed in the caller's ALS. This
          // is a separate real application connection that saw the previous generation.
          response = action(() => inWorkspace(member, invoke)).then(value => ({value}), error => ({error}))
          await waitFor(async () => Boolean((await pool.query("select 1 from pg_stat_activity a where datname=current_database() and wait_event_type='Lock' and $1=any(pg_blocking_pids(a.pid))",[pid])).rowCount), `${caller} did not reach the held task lock`)
          await withDatabaseTransaction(tx, () => inWorkspace(owner, async () => {
            const preview = await issueActions.previewIssuePersonalScope(target)
            assert.ok('preview' in preview && preview.preview)
            const retired = await collectIssueEffects([], () => issueActions.confirmIssuePersonalScope({id:target,revision:1,confirmation:preview.preview.confirmation}))
            assert.ok('issue' in retired && retired.issue)
            await collaboration.exchangeDocument({id:target,update:privateState})
            const saved = await issueActions.saveIssue({id:target,revision:2,title:privateText,content:JSON.parse(doc),status:'todo',priority:'normal'})
            assert.ok('issue' in saved && saved.issue); assert.equal(saved.issue.revision,3)
            if (caller === 'republished-document') {
              const promoted = await promoteExistingIssueForUser(owner,{requestId:randomUUID(),issueId:target,revision:3,teamId:team,expectedTeamId:team})
              assert.ok('issue' in promoted && promoted.issue)
              assert.equal(promoted.issue.scopeVersion,2)
            }
          }))
        })
        const answer = await response!
        const result = answer.value as {error?:string;issue?:{id:string}} | undefined
        const safePublicDuplicate = caller === 'duplicate-descendant'
        if (safePublicDuplicate) assert.ok(result?.issue)
        else assert.equal((answer.error as {code?:string} | undefined)?.code ?? result?.error, 'issueNotFound', caller)
        assert.equal(JSON.stringify(answer).includes(privateText),false)
        const row = (await pool.query('select title,content,scope,revision from issues where id=$1',[target])).rows[0]
        assert.ok(row.title===privateText && JSON.stringify(row.content).includes(privateText))
        assert.equal(row.scope,'workspace')
        assert.equal(row.revision,caller==='republished-document'?4:3)
        assert.equal(readIssueMetadata(row.content).number, numberBefore, 'an obsolete generation read must not change the existing task number')
        assert.equal(Number((await pool.query('select count(*) from issues where "userId"=$1',[member])).rows[0].count),beforeMemberIssues+(safePublicDuplicate?1:0))
        assert.equal((await pool.query('select count(*)::int n from issues where "userId"=$1 and content::text like $2',[member,`%${privateText}%`])).rows[0].n,0)
        assert.equal(JSON.stringify(provider.requests).includes(privateText),false)
        privacyEvidence.push({caller,denied:!safePublicDuplicate,safePublicDuplicate})
      } finally { if(response) await Promise.allSettled([response]) }
    }
    t.diagnostic(JSON.stringify({privacyFenceCallers:privacyEvidence.length,denied:privacyEvidence.filter(x=>x.denied).length,safePublicDuplicate:privacyEvidence.filter(x=>x.safePublicDuplicate).length,realProviderCalls:0}))
  })
  await scopeSubtest(t, 'member reads blocked on the task lock reject a later suspension without a provider-generation change',async()=>{
    const collaboration=await import('../app/actions/collaboration')
    const {withIssueMetadata}=await import('../lib/issue-metadata')
    for(const caller of ['get','poll','document'] as const) {
      const id=randomUUID();await seed(id,id,false)
      const known=await withRequestContext(()=>inWorkspace(member,()=>collaboration.exchangeDocument({id})))
      const original=(await pool.query('select "workspaceId","scopeVersion","linearSyncPolicy",number from issues where id=$1',[id])).rows[0]
      const privateText=`synthetic-revoked-member-${randomUUID()}`
      const content=withIssueMetadata({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:privateText}]}]},{...readIssueMetadata(JSON.parse(doc)),number:Number(original.number)})
      const document=loadIssueDocument(null,content)
      const state=encodedIssueDocument(document);document.destroy()
      const invoke=async():Promise<unknown>=>caller==='get'?issueScopeActions.getIssue(id):caller==='poll'?issueScopeActions.pollIssue(id):collaboration.exchangeDocument({id})
      const writer=await pool.connect()
      let reading:Promise<{value?:unknown;error?:unknown}>|undefined
      try {
        await writer.query('begin')
        await writer.query('select id from issues where id=$1 for update',[id])
        const pid=Number((await writer.query('select pg_backend_pid() pid')).rows[0].pid)
        reading=withRequestContext(()=>inWorkspace(member,invoke)).then(value=>({value}),error=>({error}))
        await waitFor(async()=>Boolean((await pool.query("select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and $1=any(pg_blocking_pids(pid))",[pid])).rowCount),`${caller} did not pass entry authorization and wait on the task`)
        await setMembership(member,'suspended')
        await writer.query('update issues set title=$2,content=$3,revision=revision+1 where id=$1',[id,privateText,JSON.stringify(content)])
        await writer.query('update issue_documents set state=$2 where "issueId"=$1',[id,state])
        await writer.query('commit')
        const answer=await reading
        assert.equal((answer.error as {code?:string}|undefined)?.code??(answer.value as {error?:string}|undefined)?.error,'issueNotFound',caller)
        assert.equal(JSON.stringify(answer).includes(privateText),false)
        const fresh=await withRequestContext(()=>inWorkspace(member,invoke)).then(value=>({value}),error=>({error}))
        assert.equal(('error' in fresh?fresh.error as {code?:string}:undefined)?.code??('value' in fresh?(fresh.value as {error?:string})?.error:undefined),'issueNotFound')
        await assert.rejects(withRequestContext(()=>inWorkspace(member,()=>collaboration.exchangeDocument({id,known:known.version}))),error=>(error as {code?:string}).code==='issueNotFound')
        assert.deepEqual((await pool.query('select "workspaceId","scopeVersion","linearSyncPolicy",number from issues where id=$1',[id])).rows[0],original)
        const ownerRead=await withRequestContext(()=>inWorkspace(owner,()=>issueScopeActions.getIssue(id)))
        assert.ok('issue' in ownerRead && ownerRead.issue);assert.equal(ownerRead.issue.title,privateText)
        assert.equal(JSON.stringify(provider.requests).includes(privateText),false)
      } finally {await writer.query('rollback');writer.release();if(reading)await Promise.allSettled([reading]);await setMembership(member,'active')}
    }
  })
  await scopeSubtest(t, 'an admitted member write commits before suspension and subsequent writes have no side effects',async()=>{
    const id=randomUUID();await seed(id,id,false)
    const writer=await pool.connect()
    let saving:ReturnType<typeof saveIssue>|undefined,suspending:ReturnType<typeof setMembership>|undefined,suspended=false
    try {
      await writer.query('begin');await writer.query('select id from issues where id=$1 for update',[id])
      const pid=Number((await writer.query('select pg_backend_pid() pid')).rows[0].pid)
      saving=withRequestContext(()=>inWorkspace(member,()=>saveIssue({id,revision:1,title:'Admitted before suspension',content:JSON.parse(doc),status:'todo',priority:'normal'})))
      await waitFor(async()=>Boolean((await pool.query("select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and $1=any(pg_blocking_pids(pid))",[pid])).rowCount),'member write did not wait on the held task')
      suspending=setMembership(member,'suspended').then(value=>{suspended=true;return value})
      await waitFor(async()=>Boolean((await pool.query("select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like 'update mikka_workspace_members set status=%'")).rowCount),'membership suspension did not serialize with the admitted write')
      assert.equal(suspended,false)
      await writer.query('commit')
      const result=await saving;assert.ok('issue' in result && result.issue)
      assert.equal(result.issue.title,'Admitted before suspension')
      await suspending
      const before=(await pool.query('select * from issues where id=$1',[id])).rows[0]
      const versions=(await pool.query('select count(*)::int n from issue_versions where "issueId"=$1',[id])).rows[0].n
      assert.deepEqual(await withRequestContext(()=>inWorkspace(member,()=>saveIssue({id,revision:2,title:'Denied after suspension',content:JSON.parse(doc),status:'todo',priority:'normal'}))),{error:'issueNotFound',params:undefined})
      assert.deepEqual((await pool.query('select * from issues where id=$1',[id])).rows[0],before)
      assert.equal((await pool.query('select count(*)::int n from issue_versions where "issueId"=$1',[id])).rows[0].n,versions)
      assert.equal(before.workspaceId,workspace);assert.equal(before.scopeVersion,1)
    } finally {await writer.query('rollback');writer.release();await Promise.allSettled([saving,suspending].filter(Boolean));await setMembership(member,'active')}
  })
  await pool.query('create table scope184_provider_evidence (payload jsonb not null)')
  await pool.query('insert into scope184_provider_evidence values ($1)',[JSON.stringify({requests:provider.requests,issues:[...provider.issues.values()],comments:[...provider.comments.values()],privacyEvidence})])
  t.diagnostic(`Synthetic provider boundary: ${provider.requests.length} GraphQL calls redirected to loopback HTTP; retained in scope184_provider_evidence; no real Linear acceptance`)
  assert.equal(rejectedExternalRequests,0,'no real provider request is permitted or required')
  assert.deepEqual((await pool.query('select scope,"workspaceId","linearSyncPolicy" from issues where id=$1',[issue])).rows[0],{scope:'workspace',workspaceId:workspace,linearSyncPolicy:'disabled'})
  assert.equal((await pool.query('select count(*)::int n from linear_issue_detachments where "issueId"=$1',[issue])).rows[0].n,1)
  t.diagnostic(`Synthetic fixtures retained: ${JSON.stringify({database,owner,member,workspace,team,fixtureIds,memberRun,ownerRun})}`)
})
