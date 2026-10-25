import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { fork, spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile, readdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerHooks } from 'node:module'
import { createServer } from 'node:http'
import test from 'node:test'
import { Pool } from 'pg'
import { orderMigrations } from '../../scripts/migration-order.mjs'
import { createActionIntents } from './action-intents'
import { createFactoryStore } from '../factory/store'
import { createFactoryDispatch } from '../factory/dispatch'
import { factoryDispatchDatabase } from '../factory/transaction'
import { insertRunOnce } from '../run-dispatch'
import { runAssignmentSchema } from '../../packages/protocol/src/device'
import { RunJournal } from '../../packages/daemon/src/runs/journal'

const input = { summary: 'Synthetic only', start: '2027-01-02T10:00:00Z', end: '2027-01-02T10:30:00Z', notify_attendees: false }
const call = (id: string, payload = input) => ({ type: 'tool-call' as const, toolCallId: id, toolName: 'create_calendar_event', input: payload })
test('trusted submission -> durable batch -> new workflow -> run retry -> daemon read-only recovery', { skip: process.env.OPERATION_DB_TESTS !== '1', timeout: 90000 }, async t => {
  assert.ok(!process.env.COMPOSIO_API_KEY && !process.env.AI_GATEWAY_API_KEY && !process.env.VERCEL)
  const url = new URL(process.env.OPERATION_TEST_DATABASE_URL!)
  assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.pathname, '/mikka_208_test')
  const schema = `intent_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url.toString() }); await admin.query(`CREATE SCHEMA ${schema}`)
  url.searchParams.set('options', `-c search_path=${schema}`)
  const pool = new Pool({ connectionString: url.toString() })
  for (const name of orderMigrations((await readdir(new URL('../../drizzle/', import.meta.url))).filter(n => n.endsWith('.sql')))) await pool.query(await readFile(new URL(`../../drizzle/${name}`, import.meta.url), 'utf8'))
  process.env.MIKKA_DATABASE_URL = url.toString(); process.env.CI = 'true'; process.env.BETTER_AUTH_URL = 'http://127.0.0.1:3000'; process.env.BETTER_AUTH_SECRET = randomUUID() + randomUUID()
  const hooks = registerHooks({ resolve(specifier, context, next) { return specifier === 'server-only' ? { url: 'data:text/javascript,export{}', shortCircuit: true } : next(specifier, context) } })
  const database = await import('../db/request-scope'), scope = database.createRequestDatabaseScope(url.toString())
  const { recordUserSubmission } = await import('../coordinator-event-store')
  const store = await import('../coordinator/store')
  const runtime = await import('./action-intent-runtime'), calendar = await import('./calendar-runtime')
  const worker = await import('../mcp/worker'), route = await import('../../app/api/worker/account-actions/route')
  const { reclaimLostRuns } = await import('../run-leases')
  const provider = { name: 'synthetic', prepare: async () => ({ accountId: 'fixture', version: 'v1' }), execute: async (): Promise<never> => { throw new Error('writes prohibited in propagation test') }, lookup: async () => null }
  const run = <T>(fn: () => T) => scope.run(() => calendar.withCalendarTestProvider(provider, fn))
  const owner = 'intent-owner', other = 'other-owner', holder = randomUUID()
  t.after(async () => { hooks.deregister(); await scope.close(); await database.pool.end(); await pool.end(); await admin.end() })
  let sourceEventId = '', operationId = '', ref: Awaited<ReturnType<ReturnType<typeof runtime.actionIntents>['bindProposal']>>
  const calls = [call('first'), call('second')]
  await t.test('ten submission retries reuse source, changed request conflicts, intentional identical request differs', async () => {
    const id = randomUUID()
    const submissions = await Promise.all(Array.from({ length: 10 }, () => run(() => recordUserSubmission(owner, 'Create two separate controlled events', id))))
    sourceEventId = submissions[0].sourceEventId
    assert.equal(new Set(submissions.map(s => s.sourceEventId)).size, 1)
    await assert.rejects(run(() => recordUserSubmission(owner, 'changed', id)), /submissionConflict/)
    assert.notEqual((await run(() => recordUserSubmission(other, 'Create two separate controlled events', id))).sourceEventId, sourceEventId)
    const a = await run(() => recordUserSubmission('legacy', 'same')), b = await run(() => recordUserSubmission('legacy', 'same'))
    assert.notEqual(a.sourceEventId, b.sourceEventId)
    const inbox = await run(() => store.takeInbox(owner, holder)); assert.equal(inbox.actionContext?.sourceEventId, sourceEventId)
  })
  await t.test('actual tool wrapper persists entire batch before first proposal and distinct identical slots survive concurrency', async () => {
    const context = { sourceEventId, holder }, messages = [{ role: 'assistant' as const, content: calls }]
    const first = await Promise.all(Array.from({ length: 10 }, () => run(() => runtime.proposeCalendarBatch(owner, context, { messages, toolCallId: 'first' }))))
    operationId = first[0].actionId; ref = first[0].ref
    assert.equal(new Set(first.map(r => r.actionId)).size, 1)
    assert.equal((await createActionIntents(pool).slots(owner, context)).length, 2)
    const second = await run(() => runtime.proposeCalendarBatch(owner, context, { messages, toolCallId: 'second' }))
    assert.notEqual(second.actionId, operationId)
    await assert.rejects(createActionIntents(pool).persistBatch(owner, context, [call('first', { ...input, summary: 'changed' })]), /accountActionBatchConflict/)
    await pool.query(`INSERT INTO coordinator_sessions ("userId","leaseHolder","leaseUntil") VALUES ($1,$2,now()+interval '1 minute')`, [other, holder])
    await assert.rejects(createActionIntents(pool).slots(other, context), /accountActionSourceUnavailable/)
  })
  await t.test('migration replay after SQL commit preserves persisted source slots and operation identity', async () => {
    const snapshot = async () => ({
      batch: (await pool.query('SELECT "accountActionBatch" FROM coordinator_events WHERE id=$1', [sourceEventId])).rows,
      proposals: (await pool.query('SELECT * FROM pending_actions WHERE "sourceEventId"=$1 ORDER BY id', [sourceEventId])).rows,
    })
    const before = await snapshot()
    assert.equal(before.proposals.length, 2)
    const sql = await readFile(new URL('../../drizzle/20261025070001_account_action_intents.sql', import.meta.url), 'utf8')
    await pool.query(sql)
    await pool.query(sql)
    assert.deepEqual(await snapshot(), before)
    assert.equal((await createActionIntents(pool).slots(owner, { sourceEventId, holder })).length, 2)
  })

  await t.test('new workflow replays persisted calls before model; regenerated call cannot create another intent', async () => {
    await run(() => store.failTurn(owner, holder, 'synthetic lost response'))
    const nextHolder = randomUUID(), inbox = await run(() => store.takeInbox(owner, nextHolder)); assert.ok(inbox.actionContext)
    const messages = await run(() => runtime.recoverCalendarBatch(owner, inbox.actionContext!))
    assert.equal(messages.length, 2); assert.match(JSON.stringify(messages), new RegExp(operationId))
    await assert.rejects(run(() => runtime.proposeCalendarBatch(owner, inbox.actionContext!, { messages: [{ role: 'assistant', content: [call('regenerated')] }], toolCallId: 'regenerated' })), /accountActionRecoveryRequired/)
    await run(() => store.appendMessages(owner, nextHolder, messages, null, inbox.actionContext))
    await run(() => store.releaseLease(owner, nextHolder))
    assert.equal((await run(() => store.takeInbox(owner, randomUUID()))).added, 0)
  })
  await t.test('SIGKILL after batch commit before proposal: separate process and new holder recover original slots', async () => {
    const childOwner = 'restart-owner', childHolder = randomUUID()
    const submission = await run(() => recordUserSubmission(childOwner, 'synthetic crash test', randomUUID()))
    const inbox = await run(() => store.takeInbox(childOwner, childHolder)); assert.ok(inbox.actionContext)
    const child = fork(new URL('./fixtures/intent-worker.ts', import.meta.url), { execArgv: ['--import', 'tsx'], env: { ...process.env, INTENT_FIXTURE_URL: url.toString(), INTENT_FIXTURE_INPUT: JSON.stringify({ owner: childOwner, context: inbox.actionContext, calls: [call('crash-call')] }) }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    await once(child, 'message'); child.kill('SIGKILL'); await once(child, 'exit')
    const before = await createActionIntents(pool).slots(childOwner, inbox.actionContext!)
    assert.equal((await pool.query('SELECT count(*) FROM pending_actions WHERE "sourceEventId"=$1', [submission.sourceEventId])).rows[0].count, '0')
    await pool.query(`UPDATE coordinator_sessions SET "leaseUntil"=now()-interval '1 second' WHERE "userId"=$1`, [childOwner])
    const recovered = await run(() => store.takeInbox(childOwner, randomUUID()))
    await run(() => runtime.recoverCalendarBatch(childOwner, recovered.actionContext!))
    assert.deepEqual(await createActionIntents(pool).slots(childOwner, recovered.actionContext!), before)
    assert.equal((await pool.query('SELECT "actionSlotId" FROM pending_actions WHERE "sourceEventId"=$1', [submission.sourceEventId])).rows[0].actionSlotId, before[0].actionSlotId)
  })
  await t.test('background events still ride with one foreground source; expired preflight cannot create a proposal', async () => {
    const user = 'expiry-owner', h = randomUUID()
    const submitted = await run(() => recordUserSubmission(user, 'fixture expiry', randomUUID()))
    const bg = randomUUID()
    await pool.query(`INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey",payload,tier) VALUES ($1,$2,'run_report',$3,'{}','background')`, [bg, user, bg])
    const inbox = await run(() => store.takeInbox(user, h)); assert.equal(inbox.added, 2)
    assert.equal((await pool.query('SELECT "deliveredAt" FROM coordinator_events WHERE id=$1', [bg])).rows[0].deliveredAt instanceof Date, true)
    await pool.query(`UPDATE coordinator_sessions SET "leaseUntil"=now()+interval '0.3 seconds' WHERE "userId"=$1`, [user])
    const slowProvider = { ...provider, prepare: async () => { await new Promise(r => setTimeout(r, 450)); return { accountId: 'fixture', version: 'v1' } } }
    await assert.rejects(scope.run(() => calendar.withCalendarTestProvider(slowProvider, () => runtime.proposeCalendarBatch(user, inbox.actionContext!, { messages: [{ role: 'assistant', content: [call('expiry')] }], toolCallId: 'expiry' }))), /accountActionLeaseLost/)
    assert.equal((await pool.query('SELECT count(*) FROM pending_actions WHERE "userId"=$1', [user])).rows[0].count, '0')
    assert.equal((await pool.query('SELECT "accountActionBatch" FROM coordinator_events WHERE id=$1', [submitted.sourceEventId])).rows[0].accountActionBatch.batches.length, 1)
  })
  let runId = '', retryId = '', token = '', deviceId = randomUUID(), repoId = randomUUID(), agentId = randomUUID(), issueId = randomUUID()
  await t.test('real Factory dispatch snapshots references in its transaction; device-loss retry copies them', async () => {
    await pool.query(`INSERT INTO devices (id,"ownerId",name) VALUES ($1,$2,'Fixture')`, [deviceId, owner])
    await pool.query(`INSERT INTO device_repos (id,"deviceId","userId","repoPath") VALUES ($1,$2,$3,'/fixture')`, [repoId, deviceId, owner])
    await pool.query(`INSERT INTO agents (id,"userId",name,harness,"deviceId") VALUES ($1,$2,'Fixture','codex',$3)`, [agentId, owner, deviceId])
    await pool.query(`INSERT INTO issues (id,"userId",title,content,status,priority) VALUES ($1,$2,'Fixture','{}','todo','normal')`, [issueId, owner])
    const factory = createFactoryStore(pool, async (user, issue, tx) => Boolean((await tx.query('SELECT 1 FROM issues WHERE id=$1 AND "userId"=$2', [issue, user])).rows.length))
    const batchSource = await run(() => recordUserSubmission(owner, 'new intentional identical request', randomUUID()))
    await pool.query(`UPDATE coordinator_sessions SET "leaseUntil"=now()-interval '1 second' WHERE "userId"=$1`, [owner])
    const inbox = await run(() => store.takeInbox(owner, randomUUID())); assert.equal(inbox.actionContext?.sourceEventId, batchSource.sourceEventId)
    const state = await factory.route(owner, { issueId, sourceEventId: batchSource.sourceEventId, eventId: randomUUID(), rationale: 'Fixture authenticated source' })
    const dispatch = createFactoryDispatch(pool, factory, (tx, user, input) => insertRunOnce(factoryDispatchDatabase(tx), user, input, { deviceId, baseBranch: 'main', prompt: 'Fixture' }))
    const task = state.task
    const dispatchInput = { binding: { taskId: task.id, issueId, attemptId: task.attemptId, revision: task.revision, candidateId: task.candidateId }, agentId, deviceRepoId: repoId }
    const mixed = [{ role: 'assistant' as const, content: [{ type: 'tool-call' as const, toolCallId: 'dispatch-first', toolName: 'dispatch_run', input: dispatchInput }, ...calls] }]
    const [result, proposal] = await Promise.all([
      run(async () => { await runtime.prepareAccountActionBatch(owner, inbox.actionContext!, { messages: mixed, toolCallId: 'dispatch-first' }); return dispatch(owner, dispatchInput) }),
      run(() => runtime.proposeCalendarBatch(owner, inbox.actionContext!, { messages: mixed, toolCallId: 'first' })),
    ])
    assert.notEqual(proposal.actionId, operationId); operationId = proposal.actionId; ref = proposal.ref
    runId = result.runId
    assert.equal((await pool.query('SELECT "accountActionRefs" FROM agent_runs WHERE id=$1', [runId])).rows[0].accountActionRefs.length, 2)
    await pool.query(`UPDATE agent_runs SET status='running',"leaseExpiresAt"=now()-interval '1 minute' WHERE id=$1`, [runId])
    await run(() => reclaimLostRuns(owner))
    const retry = (await pool.query('SELECT * FROM agent_runs WHERE "retryOf"=$1', [runId])).rows[0]; assert.ok(retry); retryId = retry.id
    assert.deepEqual(retry.accountActionRefs.find((r: { operationId: string }) => r.operationId === operationId), ref)
    await pool.query(`UPDATE agent_runs SET status='running',"leaseExpiresAt"=now()+interval '5 minutes' WHERE id=$1`, [retryId])
    token = (await run(() => worker.issueRunToken({ id: retryId, userId: owner }))).token
  })
  let origin = ''
  const server = createServer(async (req, res) => {
    const response = await run(() => route.GET(new Request(origin + req.url, { headers: { authorization: req.headers.authorization ?? '' } })))
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text())
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string'); origin = `http://127.0.0.1:${address.port}`
  t.after(() => new Promise<void>(r => server.close(() => r())))
  await t.test('actual HTTP worker route checks token, owner, bound reference and live lease without provider writes', async () => {
    const headers = { Authorization: `Bearer ${token}` }
    const response = await fetch(`${origin}/api/worker/account-actions`, { headers }); assert.equal(response.status, 200)
    const body = await response.json(); assert.equal(body.actions.length, 2); assert.equal(body.actions[0].canExecute, false)
    assert.equal((await fetch(`${origin}/api/worker/account-actions?operationId=${randomUUID()}`, { headers })).status, 403)
    await pool.query(`UPDATE agent_runs SET "leaseExpiresAt"=now()-interval '1 second' WHERE id=$1`, [retryId])
    assert.equal((await fetch(`${origin}/api/worker/account-actions`, { headers })).status, 403)
    await pool.query(`UPDATE agent_runs SET "leaseExpiresAt"=now()+interval '5 minutes' WHERE id=$1`, [retryId])
  })
  await t.test('real daemon journal restart preserves references; local MCP tool reads actual HTTP endpoint', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'intent-daemon-'))
    const assignment = runAssignmentSchema.parse({ runId: retryId, issueId, deviceId, repoId, baseBranch: 'main', harness: 'codex', prompt: 'Fixture', accountActionRefs: [ref] })
    const file = join(dir, 'journal.json'); new RunJournal(file).put({ assignment, state: 'running', sessionId: 'fixture', worktree: dir, lastSeq: 0, error: null, updatedAt: new Date().toISOString() })
    assert.deepEqual(new RunJournal(file).active()[0].assignment.accountActionRefs, [ref])
    const child = spawn(process.execPath, ['packages/daemon/src/agents/mikka-mcp.mjs', '--handoff', join(dir, 'handoff.json')], { env: { ...process.env, MIKKA_ACTION_READBACK_URL: `${origin}/api/worker/account-actions`, MIKKA_ACTION_READBACK_TOKEN: token }, stdio: ['pipe', 'pipe', 'pipe'] })
    child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'resume_account_actions', arguments: { operationId } } }) + '\n')
    let output = ''; child.stdout.on('data', b => { output += b }); await once(child, 'exit')
    const result = JSON.parse(output).result; assert.ok(!result.isError); assert.equal(JSON.parse(result.content[0].text).actions[0].operationId, operationId)
    await assert.rejects(readFile(join(dir, 'handoff.json')), /ENOENT/)
    await run(() => worker.revokeRunTokens(retryId))
    assert.equal((await fetch(`${origin}/api/worker/account-actions`, { headers: { Authorization: `Bearer ${token}` } })).status, 401)
  })
})
