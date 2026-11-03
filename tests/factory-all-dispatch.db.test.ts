// Every dispatch is a Factory task (docs/design/decisions/2026-11-03-0415-all-dispatch-through-factory.md),
// against a real PostgreSQL with synthetic Acme-like data: one Coordinator dispatch_run creates a Factory task
// and its execute attempt bound to the run it queued.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mock, test } from 'node:test'
import { normalizeRepository } from '@mikka/protocol/repository'
import { dbUrl, seedUser, seedWorkspace } from './support/workspace-admin-db'
import { githubAppStub } from './support/github-app-stub'

mock.module(new URL('../lib/coordinator/decide.ts', import.meta.url).href, { namedExports: { invokeDecision: async () => null } })

const REPO = 'acme-corp/storefront'
const codex = [{ harness: 'codex', installed: true, subscriptionBroker: true, modelSlots: [{ slot: 'gpt-5', model: 'gpt-5', name: 'gpt-5' }] }]

test('a Coordinator dispatch_run goes through the Factory', { skip: !dbUrl, timeout: 180_000 }, async t => {
  const prior = process.env.MIKKA_BYOS_ENABLED
  process.env.MIKKA_BYOS_ENABLED = '1'
  const { overrideDeploymentSwitch } = await import('../lib/deployment-switches')
  overrideDeploymentSwitch('factoryRouting', true)
  overrideDeploymentSwitch('factoryLifecycle', true)
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 3 })
  const steps = await import('../workflows/coordinator/steps')
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const { chatBotId } = await import('../lib/coordinator/coordinator-bot')
  const github = githubAppStub()
  github.install(REPO, { contents: 'write', pull_requests: 'write' })
  t.after(async () => {
    github.restore()
    overrideDeploymentSwitch('factoryRouting', undefined)
    overrideDeploymentSwitch('factoryLifecycle', undefined)
    if (prior === undefined) delete process.env.MIKKA_BYOS_ENABLED; else process.env.MIKKA_BYOS_ENABLED = prior
    await Promise.all([pool.end(), appPool.end(), workspacePool.end()])
  })

  // Acme's operations lead, their Acme workspace, a ChatGPT subscription listing gpt-5 (优先使用的模型),
  // Acme's always-on build server with Codex, and one storefront task.
  const userId = await seedUser(pool, 'acme-ops')
  const githubAccountId = String(9_700_000 + Math.floor(Math.random() * 100_000))
  await pool.query(`INSERT INTO account (id,"accountId","providerId","userId","createdAt","updatedAt") VALUES ($1,$2,'github',$3,now(),now())`, [randomUUID(), githubAccountId, userId])
  github.allowWriter(REPO, githubAccountId)
  await pool.query('INSERT INTO repository_settings ("userId","remoteKey",push) VALUES ($1,$2,$3)', [userId, normalizeRepository(REPO).key, JSON.stringify({ approved: true, remote: 'origin', approvedByUserId: userId, approvedAt: new Date().toISOString() })])
  const ws = await seedWorkspace(pool, userId, [{ userId, role: 'admin' }], 'Acme')
  const connection = randomUUID()
  await pool.query(`INSERT INTO byos_connections (id,"ownerId","workspaceId",provider,state,epoch,"secretName","secretDigest","providerSubject","modelCatalog",quota) VALUES ($1,$2,$3,'codex','connected',1,$4,$5,'acme-subject',$6,$7)`,
    [connection, userId, ws.id, `acme-${connection}`, 'a'.repeat(64), JSON.stringify({ revision: '1', models: ['gpt-5'] }), JSON.stringify({ vendor: 'codex', source: 'official', status: 'ok', plan: 'Pro', observedAt: new Date().toISOString(), windows: [{ kind: 'five_hour', used: .1, resetsAt: null }] })])
  await pool.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") VALUES ($1,$2,$3,'catalogue',$4,1,'codex_cpa','gpt-5')`, [randomUUID(), userId, ws.id, connection])
  const deviceId = randomUUID()
  await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,"deviceType",enabled,"lastSeenAt",harnesses) VALUES ($1,$2,'acme-build-01','local','server',true,now(),$3)`, [deviceId, userId, JSON.stringify(codex)])
  await pool.query(`INSERT INTO agents (id,"userId","deviceId",harness,name) VALUES ($1,$2,$3,'codex','Codex on acme-build-01')`, [randomUUID(), userId, deviceId])
  const issueId = randomUUID()
  await pool.query(`INSERT INTO issues (id,"userId",title,content,status,priority) VALUES ($1,$2,'Checkout rounds sales tax down on multi-item carts',$3,'todo','high')`,
    [issueId, userId, JSON.stringify({ type: 'doc', attrs: { mikka: { number: Math.floor(Math.random() * 1_000_000_000) } }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Acme storefront: a cart of 3 x $19.99 in CA shows $5.24 tax instead of $5.25.' }] }] })])
  const botId = await chatBotId(userId, null, ws.id)
  const sourceEventId = randomUUID()
  await pool.query(`INSERT INTO coordinator_events (id,"userId","botId",kind,"dedupeKey",payload) VALUES ($1,$2,$3,'user_message',$4,$5)`,
    [sourceEventId, userId, botId, `acme:${sourceEventId}`, JSON.stringify({ text: `Please fix the checkout tax rounding in ${REPO}.` })])

  const dispatched = await steps.dispatchRun(userId, { issueId, repo: REPO, requestKey: `acme:${randomUUID()}`, sourceEventId }, undefined, botId) as unknown as { runId?: string; error?: string }
  const counts = (await pool.query(`SELECT
      (SELECT count(*)::int FROM factory_tasks WHERE "userId"=$1) AS tasks,
      (SELECT count(*)::int FROM factory_attempts a JOIN factory_tasks t ON t.id=a."taskId" WHERE t."userId"=$1) AS attempts,
      (SELECT count(*)::int FROM agent_runs WHERE "userId"=$1) AS runs`, [userId])).rows[0]
  console.log(`factory-all-dispatch: dispatch=${JSON.stringify(dispatched)} factory_tasks=${counts.tasks} factory_attempts=${counts.attempts} agent_runs=${counts.runs}`)
  assert.ok(dispatched.runId, `dispatch_run queued a run: ${JSON.stringify(dispatched)}`)
  assert.equal(counts.tasks, 1, 'one Factory task for the dispatch')
  assert.equal(counts.attempts, 1, 'its execute attempt')
  const { rows: [bound] } = await pool.query(`SELECT t.stage,t.status,a."runId" FROM factory_tasks t JOIN factory_attempts a ON a.id=t."attemptId" WHERE t."userId"=$1`, [userId])
  assert.deepEqual({ stage: bound.stage, status: bound.status, runId: bound.runId }, { stage: 'execute', status: 'running', runId: dispatched.runId })
  const { factoryRuntimeForBot } = await import('../lib/factory/runtime')
  const runtime = factoryRuntimeForBot(botId)
  const taskId = (await pool.query('SELECT id FROM factory_tasks WHERE "userId"=$1', [userId])).rows[0].id
  const sha = 'a'.repeat(40), command = 'node --test'
  await pool.query('UPDATE device_repos SET "verifyCommand"=$2 WHERE id=(SELECT "deviceRepoId" FROM agent_runs WHERE id=$1)', [dispatched.runId, command])
  const complete = async (runId: string, check = false, noCommit = false, noCommand = false) => {
    await pool.query(`UPDATE agent_runs SET status='succeeded',"stopReason"='submitted',"sessionId"=$2,"startedAt"=now()-interval '1 minute',"finishedAt"=clock_timestamp(),report=$3 WHERE id=$1`, [runId, `session-${runId}`, JSON.stringify({
      summary: 'Synthetic checkout regression passed', filesChanged: [],
      publish: check || noCommit ? undefined : { commit: sha },
      observedHead: noCommit ? sha : undefined,
      check: check ? { sha, readOnly: true } : undefined,
      verify: noCommand ? {status:'not_run'} : { status: 'passed', command, exitCode: 0, signal: null, timedOut: false, output: 'ok' },
      criteria: [{ text: 'Tax rounds correctly', passed: true, ...(check && !noCommand ? {command} : {}), evidence: 'A 3 x $19.99 cart returns $5.25 in the regression command' }],
    })])
    if (check && !noCommand) {
      for (const [seq, chunk] of [
        [1, { type: 'tool-input-available', toolName: 'Bash', toolCallId: 'verify', input: { command } }],
        [2, { type: 'tool-output-available', toolCallId: 'verify', output: { exitCode: 0, output: 'ok' } }],
      ] as const) await pool.query(`INSERT INTO run_chunks (id,"runId",seq,chunk,"createdAt") VALUES ($1,$2,$3,$4,(SELECT "startedAt"+interval '1 second' FROM agent_runs WHERE id=$2))`, [randomUUID(), runId, seq, JSON.stringify(chunk)])
    }
    await runtime.reconcile.run(userId, runId)
    return runtime.store.read(userId, (await pool.query('SELECT "taskId" FROM factory_attempts WHERE "runId"=$1',[runId])).rows[0].taskId)
  }
  let snapshot = await complete(dispatched.runId!)
  assert.equal(snapshot.task.stage, 'review')
  assert.equal(snapshot.task.status, 'running', JSON.stringify(snapshot.task))
  const review = snapshot.attempts.find(a => a.id === snapshot.task.attemptId)!
  assert.ok(review.runId)
  snapshot = await complete(review.runId!, true)
  assert.equal(snapshot.task.stage, 'verify')
  assert.equal(snapshot.task.status, 'running', JSON.stringify(snapshot.task))
  const verify = snapshot.attempts.find(a => a.id === snapshot.task.attemptId)!
  assert.ok(verify.runId)
  snapshot = await complete(verify.runId!, true)
  assert.equal(snapshot.task.stage, 'approval')
  assert.equal(snapshot.task.status, 'pending')
  assert.deepEqual(snapshot.attempts.map(a => [a.stage, a.status]), [['execute','passed'], ['review','passed'], ['verify','passed'], ['approval','pending']])
  assert.equal(new Set(snapshot.attempts.filter(a => a.runId).map(a => a.runId)).size, 3)
  assert.equal(new Set(snapshot.attempts.filter(a => a.sessionId).map(a => a.sessionId)).size, 3)
  const { latestTaskRun } = await import('../lib/thread-dispatch')
  assert.equal((await latestTaskRun(pool,userId,issueId))?.id, dispatched.runId, 'checks do not become the task thread')
  const continued = await steps.dispatchRun(userId, { issueId, note: 'Also check the refund rounding', requestKey: `followup:${randomUUID()}`, sourceEventId }, undefined, botId) as { runId?: string }
  assert.ok(continued.runId)
  snapshot = await runtime.store.read(userId,taskId)
  assert.equal(snapshot.task.stage,'execute')
  assert.equal(snapshot.task.status,'running')
  assert.equal(snapshot.task.candidateId,null)
  assert.equal(snapshot.attempts.at(-1)?.runId,continued.runId)
  // A real browser-owned store must discover Bot-scoped candidates and accept
  // read-only reports without asking GitHub to merge anything.
  const { factoryStore, factoryApprovals, factoryMerges } = await import('../lib/factory/server')
  const found = await factoryStore.listForIssue(userId,issueId)
  assert.equal(found.tasks.length,1)
  assert.equal((await factoryStore.read(userId,taskId)).task.id,taskId)
  const reportIssue = randomUUID()
  await pool.query(`INSERT INTO issues (id,"userId",title,content,status,priority) VALUES ($1,$2,'Investigate rounding','{"type":"doc"}','todo','normal')`,[reportIssue,userId])
  const investigation = await steps.dispatchRun(userId,{issueId:reportIssue,repo:REPO,readOnly:true,sourceEventId,requestKey:randomUUID()},undefined,botId) as {runId:string}
  assert.ok(investigation.runId)
  await pool.query('UPDATE device_repos SET "verifyCommand"=NULL WHERE id=(SELECT "deviceRepoId" FROM agent_runs WHERE id=$1)',[investigation.runId])
  snapshot = await complete(investigation.runId,false,true,true)
  assert.equal(snapshot.task.stage,'review')
  assert.equal(snapshot.task.status,'running',JSON.stringify(snapshot.task))
  snapshot = await complete(snapshot.attempts.at(-1)!.runId!,true,false,true)
  assert.equal(snapshot.task.stage,'verify')
  assert.equal(snapshot.task.status,'running',JSON.stringify(snapshot.task))
  snapshot = await complete(snapshot.attempts.at(-1)!.runId!,true)
  assert.equal(snapshot.task.stage,'approval')
  const reportTask = snapshot.task
  assert.equal(snapshot.candidates.at(-1)?.kind,'report')
  const sessionId = randomUUID()
  await pool.query(`INSERT INTO "session" (id,"userId",token,"expiresAt","createdAt","updatedAt") VALUES ($1,$2,$3,now()+interval '1 hour',now(),now())`,[sessionId,userId,randomUUID()])
  const actor = {userId,sessionId}
  const ledger = await factoryApprovals.ledger(actor,reportTask.id)
  assert.equal(ledger.candidateKind,'report')
  assert.equal((await factoryApprovals.evidence(actor,reportTask.id)).manifest.candidate.kind,'report')
  const {factoryBinding} = await import('../lib/factory/dispatch')
  let githubReads = 0
  const accepted = await factoryMerges.accept(actor,{binding:factoryBinding(reportTask),eventId:randomUUID()},null,async()=>{githubReads++;return null})
  assert.equal(accepted.status,'accepted')
  assert.equal(githubReads,0)
  assert.equal((await factoryApprovals.ledger(actor,reportTask.id)).accepted,true)
  const nextRequest = await steps.dispatchRun(userId,{issueId:reportIssue,note:'Investigate refunds too',sourceEventId,requestKey:randomUUID()},undefined,botId) as {runId:string}
  assert.ok(nextRequest.runId)
  assert.equal((await runtime.store.listForIssue(userId,reportIssue)).tasks.length,2,'an accepted report opens a new task')
  // Only a verifier that cannot infer a command asks once. Its authenticated
  // answer is reused on the repository and starts a fresh independent check.
  const waitingIssue=randomUUID()
  await pool.query(`INSERT INTO issues (id,"userId",title,content,status,priority) VALUES ($1,$2,'Investigate discounts','{"type":"doc"}','todo','normal')`,[waitingIssue,userId])
  const waiting=await steps.dispatchRun(userId,{issueId:waitingIssue,repo:REPO,readOnly:true,sourceEventId,requestKey:randomUUID()},undefined,botId) as {runId:string}
  await pool.query('UPDATE device_repos SET "verifyCommand"=NULL WHERE id=(SELECT "deviceRepoId" FROM agent_runs WHERE id=$1)',[waiting.runId])
  snapshot=await complete(waiting.runId,false,true,true)
  snapshot=await complete(snapshot.attempts.at(-1)!.runId!,true,false,true)
  const unknownCommand=snapshot.attempts.at(-1)!.runId!
  await pool.query(`UPDATE agent_runs SET status='stopped',"stopReason"='blocked',"sessionId"=$2,"startedAt"=now()-interval '1 minute',"finishedAt"=clock_timestamp(),report=$3 WHERE id=$1`,[unknownCommand,`question-${unknownCommand}`,JSON.stringify({summary:'No repository verification entry could be found',filesChanged:[],verify:{status:'not_run'},blockedOn:'factoryCheckCommandRequired'})])
  await runtime.reconcile.run(userId,unknownCommand)
  const pendingQuestions=await runtime.questions.list(userId,snapshot.task.id)
  assert.equal(pendingQuestions.length,1)
  assert.equal(pendingQuestions[0].status,'waiting_user')
  const answer=await runtime.questions.answer({source:'human',...actor},{reference:pendingQuestions[0].reference,answerId:randomUUID(),text:command})
  assert.notEqual(answer.continuationRunId,unknownCommand)
  assert.equal((await pool.query('SELECT "verifyCommand" FROM device_repos WHERE id=(SELECT "deviceRepoId" FROM agent_runs WHERE id=$1)',[answer.continuationRunId])).rows[0].verifyCommand,command)
  snapshot=await complete(answer.continuationRunId,true)
  assert.equal(snapshot.task.stage,'approval')
  // A real failed independent check automatically dispatches bounded repair,
  // preserving the original findings instead of passing the candidate.
  const repairIssue=randomUUID()
  await pool.query(`INSERT INTO issues (id,"userId",title,content,status,priority) VALUES ($1,$2,'Repair a tax regression','{"type":"doc"}','todo','normal')`,[repairIssue,userId])
  await pool.query('UPDATE issues SET content=$2::jsonb WHERE id=$1',[repairIssue,JSON.stringify({type:'doc',attrs:{mikka:{number:Math.floor(Math.random()*1_000_000_000)}}})])
  const repairing=await steps.dispatchRun(userId,{issueId:repairIssue,repo:REPO,sourceEventId,requestKey:randomUUID()},undefined,botId) as {runId:string}
  assert.ok(repairing.runId,JSON.stringify(repairing))
  snapshot=await complete(repairing.runId)
  const failingReview=snapshot.attempts.at(-1)!.runId!
  await pool.query(`UPDATE agent_runs SET status='succeeded',"stopReason"='submitted',"sessionId"=$2,"startedAt"=now()-interval '1 minute',"finishedAt"=clock_timestamp(),report=$3 WHERE id=$1`,[failingReview,`failed-${failingReview}`,JSON.stringify({summary:'Tax case still fails',filesChanged:[],check:{sha,readOnly:true},verify:{status:'passed',command,exitCode:0,signal:null,timedOut:false},criteria:[{passed:false,evidence:'Refund rounds incorrectly'}]})])
  await runtime.reconcile.run(userId,failingReview)
  snapshot=await runtime.store.read(userId,snapshot.task.id)
  assert.deepEqual(snapshot.attempts.map(a=>[a.stage,a.status]),[['execute','passed'],['review','failed'],['execute','running']])
  assert.equal(snapshot.task.candidateId,null)
  assert.match((await pool.query('SELECT prompt FROM agent_runs WHERE id=$1',[snapshot.attempts.at(-1)!.runId])).rows[0].prompt,/Refund rounds incorrectly/)
  // Placement/admission failure while replacing a thread rolls back the
  // old task's stop/cancel along with the proposed new task and run.
  const moveSource=randomUUID()
  await pool.query(`INSERT INTO coordinator_events (id,"userId","botId",kind,"dedupeKey",payload) VALUES ($1::uuid,$2,$3,'user_message',$1::text,$4)`,[moveSource,userId,botId,JSON.stringify({text:'Start a new thread in acme-corp/unavailable-repository'})])
  const collisionIssue=randomUUID(),collisionRun=randomUUID()
  await pool.query(`INSERT INTO issues (id,"userId",title,content,status,priority) VALUES ($1,$2,'Branch collision fixture','{"type":"doc"}','todo','normal')`,[collisionIssue,userId])
  await pool.query(`INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId",status,prompt) SELECT $1,"userId",$2,"agentId","deviceId",'succeeded','Synthetic branch collision fixture' FROM agent_runs WHERE id=$3`,[collisionRun,collisionIssue,dispatched.runId])
  const blockedRepository=normalizeRepository('acme-corp/unavailable-repository')
  await pool.query(`INSERT INTO run_publications ("runId","userId","issueId","remoteUrl","remoteKey",identifier,branch) SELECT $1,"userId",$2,$3,$4,identifier,branch FROM run_publications WHERE "runId"=$5`,[collisionRun,collisionIssue,blockedRepository.remoteUrl,blockedRepository.key,dispatched.runId])
  const beforeMove=await runtime.store.read(userId,taskId)
  const refusedMove=await steps.dispatchRun(userId,{issueId,repo:'acme-corp/unavailable-repository',sourceEventId:moveSource,requestKey:randomUUID()},undefined,botId) as {error?:string}
  assert.ok(refusedMove.error,JSON.stringify(refusedMove))
  assert.deepEqual((await runtime.store.read(userId,taskId)).task,beforeMove.task)
  assert.equal((await pool.query('SELECT "stopRequestedAt" FROM agent_runs WHERE id=$1',[continued.runId])).rows[0].stopRequestedAt,null)
  overrideDeploymentSwitch('factoryLifecycle', false)
  assert.deepEqual(await steps.dispatchRun(userId, {issueId, repo: REPO}, undefined,botId), {error:'factoryLifecycleUnavailable'})
  const {dispatchRun:mcpDispatch}=await import('../lib/mcp/actions')
  const agentId=(await pool.query('SELECT "agentId" FROM agent_runs WHERE id=$1',[continued.runId])).rows[0].agentId
  assert.deepEqual(await mcpDispatch(userId,{issueId,repo:REPO,agentId}),{error:'factoryLifecycleUnavailable'})
  const {guardFactoryClaim}=await import('../lib/factory/runtime')
  const tx=await pool.connect()
  try {
    await tx.query('BEGIN')
    await assert.rejects(guardFactoryClaim(tx,userId,deviceId,continued.runId!,new Date(Date.now()+60_000).toISOString()),(error:unknown)=>error instanceof Error && 'code' in error && error.code==='factoryLifecycleUnavailable')
  } finally {await tx.query('ROLLBACK');tx.release()}


})
