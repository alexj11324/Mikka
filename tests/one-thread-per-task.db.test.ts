// One task, one thread (decision 2026-11-01-1330-one-thread-per-task, R-81),
// against a real PostgreSQL: dispatching a task that has a thread never starts
// a second one. A working thread gets the note as a message; an ended one runs
// again in the same thread (same chain root); only the person's explicit
// request, as the Decision API judges it, starts a new thread.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mock, test } from 'node:test'
import { normalizeRepository } from '@mikka/protocol/repository'
import { dbUrl, seedIssue, seedUser, seedWorkspace } from './support/workspace-admin-db'
import { connectGitHub, githubAppStub } from './support/github-app-stub'

// The computer's Codex reported gpt-5, the model the person's ChatGPT account lists (decision 2026-11-02-1400).
const mac = [{ harness: 'codex', installed: true, subscriptionBroker: true, modelSlots: [{ slot: 'gpt-5', model: 'gpt-5', name: 'gpt-5' }] }]
// The Decision API's judgment of the person's message, scripted per case.
let judged: number | null = null
const judgments: string[] = []
mock.module(new URL('../lib/coordinator/decide.ts', import.meta.url).href, { namedExports: {
  invokeDecision: async (purpose: string, input: { text: string }) => {
    judgments.push(`${purpose}:${input.text.includes('<message>') ? 'quoted' : 'raw'}`)
    return judged === null ? null : { answers: new Map([['new_thread', { type: 'predicate', name: 'new_thread', probability: judged }]]), execution: {} }
  },
} })

test('one task, one thread: dispatch continues the task\'s thread unless the person explicitly asks for a new one', { skip: !dbUrl }, async t => {
  const priorByos = process.env.MIKKA_BYOS_ENABLED
  process.env.MIKKA_BYOS_ENABLED = '1'
  t.after(() => { if (priorByos === undefined) delete process.env.MIKKA_BYOS_ENABLED; else process.env.MIKKA_BYOS_ENABLED = priorByos })
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 3 })
  const steps = await import('../workflows/coordinator/steps')
  const { readRunChain } = await import('../lib/run-chain')
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const { chatBotId } = await import('../lib/coordinator/coordinator-bot')
  const users: string[] = []
  // Push is what the person granted on GitHub: the synthetic App is installed on octo/repo with contents: write.
  const github = githubAppStub()
  github.install('octo/repo', { contents: 'write', pull_requests: 'write' })
  let githubAccount = 9_400_000
  t.after(async () => {
    github.restore()
    await pool.query('DELETE FROM run_messages WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM factory_tasks WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM coordinator_events WHERE "userId" = ANY($1)', [users])
    await pool.query('UPDATE agent_runs SET "continuesRunId"=NULL,"threadReplacedBy"=NULL WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM agent_runs WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM agents WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM model_order_entries WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM model_order_settings WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM byos_bindings WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM byos_connections WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM repository_settings WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM github_repository_installations WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM account WHERE "userId" = ANY($1)', [users])
    await Promise.all([pool.end(), appPool.end(), workspacePool.end()])
  })
  const person = async () => {
    const id = await seedUser(pool, 'one-thread')
    users.push(id)
    // Their own GitHub account, which may write to octo/repo.
    const githubAccountId = String(++githubAccount)
    await pool.query(`INSERT INTO account (id,"accountId","providerId","userId","createdAt","updatedAt") VALUES ($1,$2,'github',$3,now(),now())`, [randomUUID(), githubAccountId, id])
    github.allowWriter('octo/repo', githubAccountId)
    // Connected in 插件 › GitHub, with the App on the repositories these tasks name: dispatch checks the live list.
    await connectGitHub(github, id, githubAccountId, ['octo/repo', 'octo/web'])
    await pool.query('INSERT INTO repository_settings ("userId","remoteKey",push) VALUES ($1,$2,$3)', [id, normalizeRepository('octo/repo').key, JSON.stringify({ approved: true, remote: 'origin', approvedByUserId: id, approvedAt: new Date().toISOString() })])
    const ws = await seedWorkspace(pool, id, [{ userId: id, role: 'admin' }])
    // A connected ChatGPT subscription whose account lists gpt-5: 优先使用的模型 is that model by default, 运行位置 本地.
    const connection = randomUUID()
    await pool.query(`INSERT INTO byos_connections (id,"ownerId","workspaceId",provider,state,epoch,"secretName","secretDigest","providerSubject","modelCatalog",quota) VALUES ($1,$2,$3,'codex','connected',1,$4,$5,'synthetic-subject',$6,$7)`,
      [connection, id, ws.id, `synthetic-${connection}`, 'a'.repeat(64), JSON.stringify({ revision: '1', models: ['gpt-5'] }), JSON.stringify({ vendor: 'codex', source: 'official', status: 'ok', plan: 'Pro', observedAt: new Date().toISOString(), windows: [{ kind: 'five_hour', used: .2, resetsAt: null }] })])
    await pool.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") VALUES ($1,$2,$3,'catalogue',$4,1,'codex_cpa','gpt-5')`, [randomUUID(), id, ws.id, connection])
    const issueId = await seedIssue(pool, id, ws.id)
    // A numbered task gets a publication branch; each person's own number keeps the branches apart.
    await pool.query(`UPDATE issues SET content=$2::jsonb WHERE id=$1`, [issueId, JSON.stringify({ type: 'doc', attrs: { mikka: { number: 1000 + users.length } } })])
    const deviceId = await computer(id, 'MacBook')
    const botId = await chatBotId(id, null, ws.id)
    return { id, issueId, botId, deviceId, workspaceId: ws.id }
  }
  /** One of the person's computers; `takesPart: false` is 参与调度 off. */
  /** `old`: its Mikka cannot take a subscription run (no subscriptionBroker). */
  async function computer(userId: string, name: string, state: { online?: boolean; takesPart?: boolean; removed?: boolean; reports?: string; agent?: 'codex' | 'claude_code'; old?: boolean } = {}) {
    const deviceId = randomUUID()
    const agent = state.agent ?? 'codex'
    const harnesses = state.old ? [{ harness: agent, installed: true }] : state.reports || agent !== 'codex' ? [{ harness: agent, installed: true, subscriptionBroker: true, modelSlots: [{ slot: state.reports ?? 'gpt-5', model: state.reports ?? 'gpt-5', name: state.reports ?? 'gpt-5' }] }] : mac
    await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,"deviceType",enabled,"lastSeenAt",harnesses,"removedAt") VALUES ($1,$2,$3,'local','laptop',$4,$5,$6,$7)`,
      [deviceId, userId, name, state.takesPart ?? true, state.online === false ? new Date(Date.now() - 3_600_000) : new Date(), JSON.stringify(harnesses), state.removed ? new Date() : null])
    await pool.query(`INSERT INTO agents (id,"userId","deviceId",harness,name) VALUES ($1,$2,$3,$4,$5)`, [randomUUID(), userId, deviceId, agent, `${agent}-${deviceId.slice(0, 8)}`])
    return deviceId
  }
  type Dispatched = { runId: string; thread: string; threadId: string; status?: string; continuesRunId?: string; replacedThreadId?: string; error?: string; placement?: unknown; card?: { title: string; description?: string } }
  const dispatch = async (who: { id: string; issueId: string; botId: string }, extra: { note?: string; readOnly?: boolean; newThread?: boolean; sourceEventId?: string; target?: 'cloud' | { deviceId: string }; model?: { harness: 'claude_code' | 'codex'; model: string } } = {}) =>
    await steps.dispatchRun(who.id, { issueId: who.issueId, repo: 'octo/repo', requestKey: `dispatch:${randomUUID()}`, ...extra }, undefined, who.botId) as unknown as Dispatched
  const runs = async (userId: string) => (await pool.query('SELECT id,status,"continuesRunId","threadReplacedBy" FROM agent_runs WHERE "userId"=$1 ORDER BY "createdAt"', [userId])).rows
  const said = async (who: { id: string; botId: string }, text: string) => {
    const id = randomUUID()
    await pool.query(`INSERT INTO coordinator_events (id,"userId","botId",kind,"dedupeKey",payload) VALUES ($1,$2,$3,'user_message',$5,$4)`, [id, who.id, who.botId, JSON.stringify({ text }), `test:${id}`])
    return id
  }

  await t.test('dispatching twice leaves one thread; the second note reaches it as a message', async () => {
    const a = await person()
    const first = await dispatch(a)
    assert.equal(first.thread, 'new', JSON.stringify(first))
    const second = await dispatch(a, { note: 'Also cover the empty input.' })
    assert.deepEqual([second.thread, second.runId, second.threadId, second.status], ['message', first.runId, first.runId, 'messageSent'])
    assert.equal((await runs(a.id)).length, 1, 'still one run, one thread')
    const messages = (await pool.query('SELECT text FROM run_messages WHERE "runId"=$1', [first.runId])).rows
    assert.equal(messages.length, 1)
    assert.match(messages[0].text, /Also cover the empty input\./)
    const again = await dispatch(a)
    assert.deepEqual([again.thread, again.runId, again.threadId, again.status], ['message', first.runId, first.runId, 'alreadyWorking'])
    assert.deepEqual(again.placement, first.placement, 'it says where the thread runs')
    // Two dispatches at once still find one thread.
    const b = await person()
    const both = await Promise.all([dispatch(b, { note: 'one' }), dispatch(b, { note: 'two' })])
    assert.equal((await runs(b.id)).length, 1)
    assert.deepEqual(both.map(r => r.thread).sort(), ['message', 'new'])
  })

  await t.test('after the thread fails, dispatching again is the same thread\'s next run', async () => {
    const a = await person()
    const first = await dispatch(a)
    await pool.query(`UPDATE agent_runs SET status='failed',"stopReason"='error',error='tests failed',"finishedAt"=now() WHERE id=$1`, [first.runId])
    const again = await dispatch(a, { note: 'Fix the failing tests.' })
    assert.equal(again.thread, 'continued')
    assert.notEqual(again.runId, first.runId)
    assert.equal(again.threadId, first.runId, 'the thread id does not change')
    assert.equal(again.continuesRunId, first.runId)
    const [, next] = await runs(a.id)
    assert.equal(next.continuesRunId, first.runId)
    const chain = await readRunChain(appPool, a.id, again.runId)
    assert.deepEqual([chain?.rootRunId, chain?.latestRunId, chain?.attempts.length], [first.runId, again.runId, 2])
    const prompt = (await pool.query('SELECT prompt FROM agent_runs WHERE id=$1', [again.runId])).rows[0].prompt as string
    assert.match(prompt, /## More work in this thread/)
    assert.match(prompt, /Fix the failing tests\./)
    assert.match(prompt, /Status: failed \(error\)/)
    // A stopped thread continues the same way.
    await pool.query(`UPDATE agent_runs SET status='stopped',"finishedAt"=now() WHERE id=$1`, [again.runId])
    const third = await dispatch(a)
    assert.deepEqual([third.thread, third.threadId, third.continuesRunId], ['continued', first.runId, again.runId])

    // A read-only request that continues a writable thread runs read-only.
    await pool.query(`UPDATE agent_runs SET status='failed',"finishedAt"=now() WHERE id=$1`, [third.runId])
    const look = await dispatch(a, { readOnly: true, note: 'Only look.' })
    assert.deepEqual([look.thread, look.threadId], ['continued', first.runId])
    const definition = (await pool.query('SELECT "agentDefinition" FROM agent_runs WHERE id=$1', [look.runId])).rows[0].agentDefinition
    assert.equal(definition.readOnly, true)
    // A read-only thread stays read-only when it continues, even when the request does not say so.
    const b = await person()
    const looking = await dispatch(b, { readOnly: true })
    assert.equal(looking.thread, 'new')
    await pool.query(`UPDATE agent_runs SET status='failed',"finishedAt"=now() WHERE id=$1`, [looking.runId])
    const more = await dispatch(b, { note: 'Look further.' })
    assert.deepEqual([more.thread, more.threadId], ['continued', looking.runId])
    assert.equal((await pool.query('SELECT "agentDefinition" FROM agent_runs WHERE id=$1', [more.runId])).rows[0].agentDefinition.readOnly, true)
  })

  await t.test('a new thread only when the person explicitly asked for one; the old one is marked replaced', async () => {
    const a = await person()
    const first = await dispatch(a)
    // The model asks for a new thread, but the person only added information: the thread is kept.
    judged = 0.1
    const moreDetail = await said(a, '再补充一点：还要支持空输入')
    const kept = await dispatch(a, { note: 'More detail', newThread: true, sourceEventId: moreDetail })
    assert.deepEqual([kept.thread, kept.runId], ['message', first.runId])
    const continued = await runs(a.id)
    assert.equal(continued.length, 2, 'the fenced unclaimed run ends and the current epoch gets one executor')
    assert.equal(continued[0].status, 'stopped', 'an unclaimed run needs no daemon stop acknowledgement')
    assert.equal(continued[1].continuesRunId, first.runId, 'the new request keeps the same thread')
    assert.equal(continued[1].status, 'queued')
    const { continueActiveFactoryRequest } = await import('../lib/factory/request-epoch')
    await Promise.all([
      continueActiveFactoryRequest(appPool, a.id, first.runId, 'More detail', moreDetail),
      continueActiveFactoryRequest(appPool, a.id, first.runId, 'More detail', moreDetail),
    ])
    assert.deepEqual(await runs(a.id), continued, 'late/repeated cleanup of an old epoch never stops its new child')
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM factory_tasks WHERE "userId"=$1', [a.id])).rows[0].n, 1)
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM factory_events e JOIN factory_tasks t ON t.id=e."taskId" WHERE t."userId"=$1 AND e.request->>'kind'='request_epoch'`, [a.id])).rows[0].n, 1, 'source replay never creates another epoch')
    // No message of the person's to judge: kept as well, without asking the Decision API.
    const before = judgments.length
    assert.equal((await dispatch(a, { newThread: true })).thread, 'message')
    assert.equal(judgments.length, before)
    // The person explicitly asked to start over in a new session.
    judged = 0.97
    const fresh = await dispatch(a, { newThread: true, sourceEventId: await said(a, '换一个 session 重新开始做这个任务') })
    assert.equal(fresh.thread, 'new')
    assert.notEqual(fresh.runId, first.runId)
    assert.equal(fresh.replacedThreadId, first.runId)
    const all = await runs(a.id)
    assert.equal(all.length, 3)
    assert.equal(all[0].threadReplacedBy, fresh.runId)
    assert.equal(all[1].continuesRunId, first.runId, 'the owner follow-up was a continuation of the original thread')
    assert.equal(all[2].continuesRunId, null, 'only the explicit new thread is its own chain')
    assert.ok((await pool.query('SELECT "stopRequestedAt" FROM agent_runs WHERE id=$1', [first.runId])).rows[0].stopRequestedAt || all[0].status === 'stopped', 'the replaced thread is stopped')
    assert.ok(judgments.every(entry => entry === 'thread-switch:quoted'))
    judged = null
  })

  await t.test('an old run ending before the epoch lock still admits the new target with an empty fenced set', async () => {
    const a = await person()
    const first = await dispatch(a)
    // The HTTP caller already observed this active run. Its ordinary completion
    // and the completion hook both finish before the owner message gets the lock.
    await pool.query(`UPDATE agent_runs SET status='stopped',"finishedAt"=now() WHERE id=$1`, [first.runId])
    const { afterRunEnded } = await import('../lib/run-completion-effects')
    await afterRunEnded(a.id, first.runId)
    assert.equal((await pool.query('SELECT status FROM factory_tasks WHERE "userId"=$1', [a.id])).rows[0].status, 'blocked')
    const source = await said(a, 'Continue with the new target after the old executor ended')
    const { continueActiveFactoryRequest } = await import('../lib/factory/request-epoch')
    await continueActiveFactoryRequest(appPool, a.id, first.runId, 'Continue with the new target', source)
    const current = await runs(a.id)
    assert.deepEqual(current.map(run => run.status), ['stopped', 'queued'])
    assert.equal(current[1].continuesRunId, first.runId)
    const events = (await pool.query(`SELECT e.request FROM factory_events e JOIN factory_tasks t ON t.id=e."taskId"
      WHERE t."userId"=$1 AND e.request->>'kind'='request_epoch'`, [a.id])).rows
    assert.equal(events.length, 1)
    assert.deepEqual(events[0].request.supersededRunIds, [], 'there was no active executor left to acknowledge a stop')
    await continueActiveFactoryRequest(appPool, a.id, first.runId, 'Continue with the new target', source)
    assert.deepEqual(await runs(a.id), current, 'replaying the empty-set hook never admits another executor')
  })

  await t.test('an owner turn captured before a concurrent continuation fences that queued child and replays safely', async () => {
    const a = await person()
    const first = await dispatch(a)
    const capturedRunId = first.runId
    await dispatch(a, { note: 'Target A', sourceEventId: await said(a, 'Target A') })
    const afterA = await runs(a.id)
    assert.equal(afterA.length, 2)
    assert.equal(afterA[1].status, 'queued')
    // Another request had already read the original thread run before A's
    // post-commit completion hook queued its child. B must fence that child too.
    const sourceB = await said(a, 'Target B')
    const { continueActiveFactoryRequest } = await import('../lib/factory/request-epoch')
    await continueActiveFactoryRequest(appPool, a.id, capturedRunId, 'Target B', sourceB)
    const afterB = await runs(a.id)
    assert.deepEqual(afterB.map(run => run.status), ['stopped', 'stopped', 'queued'])
    assert.equal(afterB[2].continuesRunId, afterA[1].id, 'B continues the same thread after A is fenced')
    await continueActiveFactoryRequest(appPool, a.id, capturedRunId, 'Target B', sourceB)
    assert.deepEqual(await runs(a.id), afterB, 'late B cleanup cannot stop its own new executor')
    const tasks = (await pool.query(`SELECT t.id,t."sourceEventId",a.output,e.payload FROM factory_tasks t
      JOIN factory_attempts a ON a.id=t."attemptId" JOIN coordinator_events e ON e.id=t."sourceEventId" WHERE t."userId"=$1`, [a.id])).rows
    assert.equal(tasks.length, 1, 'all owner epochs belong to the same Factory Task')
    assert.equal(tasks[0].payload.text, 'Target B')
    assert.equal(tasks[0].output.requestEpoch, tasks[0].sourceEventId)
  })

  await t.test('a named computer: the run is pinned there and the result says so; offline, not theirs or removed is refused', async () => {
    const a = await person()
    // Two computers can run the allowed model and dispatch would pick either; the person named this one.
    const studio = await computer(a.id, 'Mac Studio')
    const pinned = await dispatch(a, { target: { deviceId: studio } })
    assert.equal(pinned.thread, 'new')
    assert.deepEqual(pinned.placement, { kind: 'device', deviceId: studio, name: 'Mac Studio' })
    assert.equal((await pool.query('SELECT "deviceId","agentDefinition"->>\'pinnedDeviceId\' AS pinned FROM agent_runs WHERE id=$1', [pinned.runId])).rows[0].pinned, studio)
    // The named computer and the thread's own Codex model: Codex runs it there, on that model.
    const c = await person()
    const box = await computer(c.id, 'Codex box')
    const codex = await dispatch(c, { target: { deviceId: box }, model: { harness: 'codex', model: 'gpt-5' } })
    const frozen = (await pool.query(`SELECT r."deviceId",r."agentDefinition"->>'harness' AS harness,r."agentDefinition"->>'model' AS model FROM agent_runs r WHERE r.id=$1`, [codex.runId])).rows[0]
    assert.deepEqual(frozen, { deviceId: box, harness: 'codex', model: 'gpt-5' })
    // Offline: the card at once, nothing queued, no other computer used.
    const b = await person()
    const asleep = await computer(b.id, 'Old Mac', { online: false })
    const offline = await dispatch(b, { target: { deviceId: asleep } })
    assert.equal(offline.error, 'machineUnavailable')
    assert.ok(offline.card?.title)
    assert.equal((await runs(b.id)).length, 0)
    // A named computer fixes where, not which model: asked for Codex, a Claude Code-only computer says it lacks Codex and runs nothing.
    const claudeBox = await computer(b.id, 'Claude box', { agent: 'claude_code' })
    const lacking = await dispatch(b, { target: { deviceId: claudeBox }, model: { harness: 'codex', model: 'gpt-5' } })
    assert.deepEqual([lacking.error, lacking.card?.description], ['machineUnavailable', '这台电脑没装 Codex'])
    // Its Mikka cannot take a subscription run: it says so, and nothing else is used in its place.
    const stale = await dispatch(b, { target: { deviceId: await computer(b.id, 'Stale', { old: true }) } })
    assert.deepEqual([stale.error, stale.card?.description], ['machineUnavailable', '这台电脑的 Mikka 需要更新'])
    assert.equal((await runs(b.id)).length, 0)
    // No computer named, a model that is not in 优先使用的模型 on that Agent: refused with the list, not run on the list's model.
    const unoffered = await dispatch(b, { model: { harness: 'claude_code', model: 'gpt-5' } }) as unknown as { error: string; allowed: { harness: string; model: string }[] }
    assert.equal(unoffered.error, 'modelNotAllowed')
    assert.ok(!unoffered.allowed.some(item => item.harness === 'claude_code' && item.model === 'gpt-5'))
    assert.equal((await runs(b.id)).length, 0)
    // 参与调度 off: Mikka never sends it a run, even when named (decision 2026-11-02-1400).
    const kept = await dispatch(b, { target: { deviceId: await computer(b.id, 'Kept out', { takesPart: false }) } })
    assert.equal(kept.error, 'machineUnavailable')
    assert.equal((await runs(b.id)).length, 0)
    // Someone else's computer, or a removed one: refused.
    assert.equal((await dispatch(b, { target: { deviceId: a.deviceId } })).error, 'deviceNotFound')
    assert.equal((await dispatch(b, { target: { deviceId: await computer(b.id, 'Gone', { removed: true }) } })).error, 'deviceNotFound')
    assert.equal((await runs(b.id)).length, 0)
    // No target: 优先使用的模型 picks (here the MacBook, the one computer that takes part and runs gpt-5), and the result names it.
    const ruled = await dispatch(b)
    assert.deepEqual(ruled.placement, { kind: 'device', deviceId: b.deviceId, name: 'MacBook' })
  })

  await t.test('naming another computer for a task that has a thread is a move, granted only by the person\'s explicit request', async () => {
    const a = await person()
    const first = await dispatch(a)
    await pool.query(`UPDATE agent_runs SET status='failed',"finishedAt"=now() WHERE id=$1`, [first.runId])
    const studio = await computer(a.id, 'Mac Studio')
    judged = 0.2
    const kept = await dispatch(a, { target: { deviceId: studio }, sourceEventId: await said(a, '再试一次') })
    assert.deepEqual([kept.thread, kept.threadId], ['continued', first.runId])
    assert.deepEqual(kept.placement, { kind: 'device', deviceId: a.deviceId, name: 'MacBook' }, 'the thread stays where it ran')
    await pool.query(`UPDATE agent_runs SET status='failed',"finishedAt"=now() WHERE id=$1`, [kept.runId])
    judged = 0.95
    const moved = await dispatch(a, { target: { deviceId: studio }, sourceEventId: await said(a, '换到我的 Mac Studio 上跑') })
    assert.equal(moved.thread, 'new')
    assert.deepEqual(moved.placement, { kind: 'device', deviceId: studio, name: 'Mac Studio' })
    judged = null
  })
  await t.test('「It\'s in the mikka-web repo」: a repository the person names that is not the thread\'s starts a new thread there; the old one stops', async () => {
    // Production (Acme): the thread worked in alexj11324/Mikka; the person said the work is in mikka-web, and the
    // Coordinator continued the old thread because a task with a thread kept its repository.
    const a = await person()
    const first = await dispatch(a)
    assert.equal(first.thread, 'new')
    judged = 0.05
    // The model passes another repository the person never named: the thread keeps its own.
    const kept = await steps.dispatchRun(a.id, { issueId: a.issueId, repo: 'octo/web', note: 'Look again.', readOnly: true, requestKey: `dispatch:${randomUUID()}`, sourceEventId: await said(a, 'Look again please') }, undefined, a.botId) as unknown as Dispatched
    assert.deepEqual([kept.thread, kept.runId], ['message', first.runId], JSON.stringify(kept))
    const moved = await steps.dispatchRun(a.id, { issueId: a.issueId, repo: 'octo/web', readOnly: true, requestKey: `dispatch:${randomUUID()}`, sourceEventId: await said(a, "It's in the octo/web repo") }, undefined, a.botId) as unknown as Dispatched
    assert.equal(moved.thread, 'new', JSON.stringify(moved))
    assert.equal(moved.replacedThreadId, first.runId)
    const rows = (await pool.query('SELECT r.id,r."stopRequestedAt",r."threadReplacedBy",d."remoteUrl" FROM agent_runs r JOIN device_repos d ON d.id=r."deviceRepoId" WHERE r."userId"=$1 ORDER BY r."createdAt"', [a.id])).rows
    assert.equal(rows.length, 3, 'one request-epoch continuation plus one explicitly requested new thread')
    assert.ok(rows[0].stopRequestedAt, 'the old thread is asked to stop')
    assert.equal(rows[0].threadReplacedBy, moved.runId)
    assert.match(rows[1].remoteUrl, /octo\/repo/, 'the earlier owner follow-up kept its original repository')
    assert.match(rows[2].remoteUrl, /octo\/web/, 'the new thread works in the named repository')
    judged = null
  })
  await t.test('newThread with a repository the person named: a new thread there even when the Decision API cannot judge', async () => {
    // Production (2026-11-03): the person asked for a new thread in another repository by name; the model passed
    // newThread and repo, the Decision API gave no judgment, and the old thread was continued instead.
    const a = await person()
    const first = await dispatch(a)
    await pool.query(`UPDATE agent_runs SET status='failed',"finishedAt"=now() WHERE id=$1`, [first.runId])
    judged = null
    const moved = await steps.dispatchRun(a.id, { issueId: a.issueId, repo: 'octo/web', newThread: true, readOnly: true, requestKey: `dispatch:${randomUUID()}`, sourceEventId: await said(a, 'Start a new thread in octo/web: fix the layout and open a PR.') }, undefined, a.botId) as unknown as Dispatched
    assert.equal(moved.thread, 'new', JSON.stringify(moved))
    assert.equal(moved.replacedThreadId, first.runId)
    const rows = (await pool.query('SELECT r.id,r."continuesRunId",r."threadReplacedBy",d."remoteUrl" FROM agent_runs r JOIN device_repos d ON d.id=r."deviceRepoId" WHERE r."userId"=$1 ORDER BY r."createdAt"', [a.id])).rows
    assert.equal(rows[0].threadReplacedBy, moved.runId, 'the old thread is marked replaced')
    assert.equal(rows[1].continuesRunId, null, 'the new thread does not continue the old one')
    assert.match(rows[1].remoteUrl, /octo\/web/)
  })
  await t.test('a thread\'s next run never changes its repository, even when it cannot run where the thread ran', async () => {
    // Production (2026-11-03): the thread's own place could not take its next run, the fallback placed it by the
    // rules with the repository the model passed, and the thread silently moved to another repository.
    const a = await person()
    const first = await dispatch(a)
    await pool.query(`UPDATE agent_runs SET status='failed',"finishedAt"=now() WHERE id=$1`, [first.runId])
    // The thread's computer no longer takes part in scheduling; another one can take the next run.
    await pool.query('UPDATE devices SET enabled=false WHERE id=$1', [a.deviceId])
    const studio = await computer(a.id, 'Mac Studio')
    judged = 0.05
    const next = await steps.dispatchRun(a.id, { issueId: a.issueId, repo: 'octo/web', readOnly: true, note: 'Look again.', requestKey: `dispatch:${randomUUID()}`, sourceEventId: await said(a, 'Look again please') }, undefined, a.botId) as unknown as Dispatched
    judged = null
    const rows = (await pool.query('SELECT r.id,r."continuesRunId",d."remoteUrl" FROM agent_runs r LEFT JOIN device_repos d ON d.id=r."deviceRepoId" WHERE r."userId"=$1 ORDER BY r."createdAt"', [a.id])).rows
    assert.equal(next.thread, 'continued', JSON.stringify(next))
    assert.deepEqual(next.placement, { kind: 'device', deviceId: studio, name: 'Mac Studio' })
    assert.equal(rows[1].continuesRunId, first.runId)
    assert.match(rows[1].remoteUrl, /octo\/repo/, 'the thread keeps its repository')
  })
  await t.test('a new thread asked for without a repository runs in the repository of the thread it replaces', async () => {
    const a = await person()
    const first = await dispatch(a)
    await pool.query(`UPDATE agent_runs SET status='failed',"finishedAt"=now() WHERE id=$1`, [first.runId])
    judged = 0.95
    const fresh = await steps.dispatchRun(a.id, { issueId: a.issueId, newThread: true, requestKey: `dispatch:${randomUUID()}`, sourceEventId: await said(a, '另开一个线程，从头重新做') }, undefined, a.botId) as unknown as Dispatched
    judged = null
    assert.equal(fresh.thread, 'new', JSON.stringify(fresh))
    assert.equal(fresh.replacedThreadId, first.runId)
    const rows = (await pool.query('SELECT r.id,r."continuesRunId",r."threadReplacedBy",d."remoteUrl" FROM agent_runs r JOIN device_repos d ON d.id=r."deviceRepoId" WHERE r."userId"=$1 ORDER BY r."createdAt"', [a.id])).rows
    assert.equal(rows.length, 2)
    assert.equal(rows[0].threadReplacedBy, fresh.runId, 'the old thread is marked replaced')
    assert.equal(rows[1].continuesRunId, null)
    assert.match(rows[1].remoteUrl, /octo\/repo/, 'the new thread keeps the old thread\'s repository')
  })
  await t.test('a thread\'s next run that cannot run where the thread ran keeps the place the person named', async () => {
    // The person named the cloud; the thread's own computer cannot take its next run. The fallback stays in the
    // cloud (refused here, where no cloud is set up) and never quietly goes to another computer.
    const a = await person()
    const first = await dispatch(a)
    await pool.query(`UPDATE agent_runs SET status='failed',"finishedAt"=now() WHERE id=$1`, [first.runId])
    await pool.query('UPDATE devices SET enabled=false WHERE id=$1', [a.deviceId])
    await computer(a.id, 'Mac Studio')
    judged = 0.05
    const before = (await runs(a.id)).length
    const next = await dispatch(a, { note: 'Run it in the cloud.', target: 'cloud', sourceEventId: await said(a, '放到云端再跑一次') })
    judged = null
    assert.equal(next.error, 'machineUnavailable', JSON.stringify(next))
    assert.equal((await runs(a.id)).length, before, 'nothing ran on another computer')
  })
  await t.test('no authorized list, no dispatch: not connected, authorization expired, GitHub down (after one retry)', async () => {
    type Refused = { error?: string; runId?: string; repository?: string }
    const attempt = async (who: { id: string; issueId: string; botId: string }) => await steps.dispatchRun(who.id, { issueId: who.issueId, repo: 'octo/repo', requestKey: `dispatch:${randomUUID()}` }, undefined, who.botId) as unknown as Refused
    const token = (userId: string) => `synthetic-user-token-${userId}`
    const runCount = async (userId: string) => (await runs(userId)).length

    const notConnected = await person()
    await pool.query('DELETE FROM github_connections WHERE "userId"=$1', [notConnected.id])
    await pool.query(`DELETE FROM account WHERE "userId"=$1 AND "providerId"='github'`, [notConnected.id])
    assert.deepEqual([(await attempt(notConnected)).error, await runCount(notConnected.id)], ['githubNotConnected', 0])

    const revoked = await person()
    github.fail(token(revoked.id), 401)
    assert.deepEqual([(await attempt(revoked)).error, await runCount(revoked.id)], ['githubReconnectRequired', 0])

    const down = await person()
    const before = github.calls.filter(call => call === 'GET /user').length
    github.fail(token(down.id), 502)
    const refused = await attempt(down)
    assert.deepEqual([refused.error, refused.repository, await runCount(down.id)], ['githubUnavailable', 'octo/repo', 0])
    assert.equal(github.calls.filter(call => call === 'GET /user').length - before, 2, 'asked once more, then told')

    // A rate limit that clears on the retry dispatches as usual.
    const limited = await person()
    github.fail(token(limited.id), 403, 1)
    const queued = await attempt(limited)
    assert.equal(queued.error, undefined, JSON.stringify(queued))
    assert.equal(await runCount(limited.id), 1)

    // An authorized list without the repository: refused, nothing queued.
    const elsewhere = await person()
    const notListed = await steps.dispatchRun(elsewhere.id, { issueId: elsewhere.issueId, repo: 'someone/private-app', requestKey: `dispatch:${randomUUID()}` }, undefined, elsewhere.botId) as unknown as Refused
    assert.deepEqual([notListed.error, await runCount(elsewhere.id)], ['repositoryNotFound', 0])
  })

  await t.test('a local run is frozen with its model: none fails at once, a thread keeps its own, an MCP client\'s new run takes 优先使用的模型', async () => {
    const a = await person()
    const agentId = (await pool.query('SELECT id FROM agents WHERE "deviceId"=$1', [a.deviceId])).rows[0].id as string
    const before = (await runs(a.id)).length
    const { queueRun } = await import('../lib/agent-runs')
    for (const model of ['', 'auto', undefined]) await assert.rejects(queueRun(a.id, { issueId: a.issueId, agentId, repo: 'octo/repo', model: model as string }, a.botId), { code: 'runModelMissing' })
    assert.equal((await runs(a.id)).length, before, 'nothing is written for a run without its model')
    const model = async (runId: string) => (await pool.query('SELECT "agentDefinition" FROM agent_runs WHERE id=$1', [runId])).rows[0].agentDefinition
    const first = await dispatch(a)
    assert.deepEqual([(await model(first.runId)).model, (await model(first.runId)).cliModelSelection], ['gpt-5', 'explicit'])
    await pool.query(`UPDATE agent_runs SET status='failed',"finishedAt"=now() WHERE id=$1`, [first.runId])
    const next = await dispatch(a, { note: 'Again.' })
    assert.equal(next.thread, 'continued')
    assert.deepEqual([(await model(next.runId)).model, (await model(next.runId)).cliModelSelection], ['gpt-5', 'explicit'], 'the computer thread keeps its model')
    // A thread whose runs were all frozen without one: told, never left to the CLI.
    await pool.query(`UPDATE agent_runs SET status='failed',"finishedAt"=now(),"agentDefinition"="agentDefinition"-'model' WHERE "userId"=$1`, [a.id])
    const count = (await runs(a.id)).length
    const refused = await dispatch(a, { note: 'Again.' })
    assert.equal(refused.error, 'threadModelUnavailable', JSON.stringify(refused))
    assert.equal((await runs(a.id)).length, count)
    // An MCP client names only the Agent: the run takes the first model 优先使用的模型 allows on that computer.
    const b = await person()
    const bAgent = (await pool.query('SELECT id FROM agents WHERE "deviceId"=$1', [b.deviceId])).rows[0].id as string
    const { dispatchRun: mcpDispatch } = await import('../lib/mcp/actions')
    const { actAs } = await import('../lib/acting-user')
    const { tokenWorkspace } = await import('../lib/tokens/principal')
    const request = { issueId: b.issueId, agentId: bAgent, repo: 'octo/repo' }
    assert.deepEqual(await mcpDispatch(b.id, request), { error: 'issueNotFound' }, 'an MCP request without an authenticated workspace cannot dispatch')
    const viaMcp = await actAs({ id: b.id, [tokenWorkspace]: b.workspaceId }, () => mcpDispatch(b.id, request)) as { runId?: string; error?: string }
    assert.ok(viaMcp.runId, JSON.stringify(viaMcp))
    assert.deepEqual([(await model(viaMcp.runId!)).model, (await model(viaMcp.runId!)).cliModelSelection], ['gpt-5', 'explicit'])
  })
})
