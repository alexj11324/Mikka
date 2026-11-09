import assert from 'node:assert/strict'
import { wireKeys } from './wire-keys.test-support'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import test, { mock } from 'node:test'
import { Pool } from 'pg'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { dropTestDatabase } from '../../tests/support/drop-test-database'
import { orderMigrations } from '../../scripts/migration-order.mjs'
import { observePoolCommits, databaseCommitScope, captureDatabaseQuery } from '../db/commit-effects'
import { documentLiveTargets, runLiveTargets, runChanged, threadLiveReferences } from './panels'
import type { LiveInvalidation } from './events'
import { liveChannelId, type LiveScope } from './scope'
import { isolateCoordinatorWakes } from '../../tests/support/coordinator-wake'

const url = process.env.E2E_DATABASE_URL
if (process.env.REQUIRE_DB === '1') assert.ok(url, 'REQUIRE_DB=1 needs PostgreSQL')
if (url) assert.ok(disposableDatabase(process.env, url), 'loopback *_e2e only')

test('panel notifications follow actual committed writes and persisted owner/workspace scopes', { skip: !url, timeout: 180_000 }, async t => {
  const pending: (() => Promise<void>)[] = []
  const sent: { scope: LiveScope; events: LiveInvalidation[] }[] = []
  const nextServer = await import('next/server')
  const scheduler = mock.module('next/server', { namedExports: { ...nextServer,
    after: (work: () => Promise<void>) => { pending.push(work) },
  } })
  const coordinator = await isolateCoordinatorWakes(t)
  // The same writers also refresh owner/workspace lists; lists.db.test.ts covers
  // those keys. Here count task/thread panel keys only.
  const lists = await import('./lists')
  const listMock = mock.module(new URL('./lists.ts', import.meta.url).href, { namedExports: Object.fromEntries(Object.entries(lists).map(([name, value]) =>
    [name, name.endsWith('ScopesBeforeChange') ? async () => [] : name.endsWith('Changed') ? async () => {} : value])) })
  const channelScopes = new Map<string, LiveScope>(), unexpectedPaths: string[] = []
  const devicePaths = new Set<string>(), deviceWakes: string[] = []
  const previous = { url: process.env.DEVICE_GATEWAY_URL, secret: process.env.DEVICE_GATEWAY_PUSH_SECRET }
  process.env.DEVICE_GATEWAY_URL = 'https://gateway.example.invalid'
  process.env.DEVICE_GATEWAY_PUSH_SECRET = 'isolated-panel-test-secret'
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, options?: RequestInit) => {
    const target = new URL(String(input))
    assert.equal(target.hostname, 'gateway.example.invalid', 'no provider or production request is allowed')
    // Queuing the fixture's local run also wakes its own device. This is the
    // device protocol (no body), separate from the live panel keys below.
    if (devicePaths.has(target.pathname)) {
      assert.equal(options?.method, 'POST')
      assert.equal(options?.body, undefined)
      assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer isolated-panel-test-secret')
      deviceWakes.push(target.pathname)
      return new Response(null, { status: 204 })
    }
    const scope = channelScopes.get(target.pathname)
    if (!scope) unexpectedPaths.push(target.pathname)
    sent.push({ scope: scope ?? { ownerId: 'unexpected', workspaceId: target.pathname }, events: wireKeys(JSON.parse(String(options?.body))) })
    return new Response(null, { status: 204 })
  })
  const admin = new Pool({ connectionString: url, max: 1 })
  const database = `panel_live_${randomUUID().replaceAll('-', '')}_e2e`
  await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`)
  const target = new URL(url!); target.pathname = `/${database}`
  const databasePool = new Pool({ connectionString: target.toString(), max: 6 })
  observePoolCommits(databasePool)
  const globalDb = globalThis as unknown as { workspacePool?: Pool }
  const previousWorkspace = globalDb.workspacePool
  globalDb.workspacePool = databasePool
  const { pool, db, createRequestDatabaseScope, withDatabaseClient, withDatabaseTransaction } = await import('../db/request-scope')
  const scope = createRequestDatabaseScope(target.toString())
  try {
    const dir = new URL('../../drizzle/', import.meta.url)
    for (const name of orderMigrations((await readdir(dir)).filter(name => name.endsWith('.sql')))) await databasePool.query(await readFile(new URL(name, dir), 'utf8'))
    for (const userId of ['owner', 'peer', 'suspended', 'foreign']) {
      await databasePool.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$1,$1||'@panel.example.invalid',true,now(),now())`, [userId])
    }
    const personal = randomUUID(), a = randomUUID(), b = randomUUID(), foreignPersonal = randomUUID()
    for (const ownerId of ['owner', 'peer', 'suspended', 'foreign']) for (const workspaceId of [personal, a, b, foreignPersonal]) {
      const scope = { ownerId, workspaceId }
      channelScopes.set(`/v1/live/${liveChannelId(scope)}/push`, scope)
    }
    for (const [id, owner, kind] of [[personal, 'owner', 'personal'], [a, 'owner', 'team'], [b, 'owner', 'team'], [foreignPersonal, 'foreign', 'personal']]) {
      await databasePool.query(`INSERT INTO mikka_workspaces(id,"userId",name,kind) VALUES ($1,$2,'Fixture',$3)`, [id, owner, kind])
    }
    for (const [workspace, userId, status] of [[personal, 'owner', 'active'], [personal, 'peer', 'active'], [personal, 'foreign', 'active'], [a, 'owner', 'active'], [a, 'peer', 'active'], [a, 'suspended', 'suspended'], [b, 'owner', 'active'], [foreignPersonal, 'foreign', 'active']]) {
      await databasePool.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$2,\'member\',$3)', [workspace, userId, status])
    }
    const agentIds = new Map<string, string>()
    for (const owner of ['owner', 'foreign']) {
      const id = randomUUID(); agentIds.set(owner, id)
      await databasePool.query('INSERT INTO agents(id,"userId",name,harness) VALUES ($1,$2,\'Fixture\',\'codex\')', [id, owner])
    }
    async function issue(owner = 'owner', workspace: string | null = null) {
      const id = randomUUID()
      const workspaceId = workspace ?? (owner === 'foreign' ? foreignPersonal : personal)
      await databasePool.query(`INSERT INTO issues(id,"userId","workspaceId","ownershipState",title,content,status,priority,scope) VALUES ($1,$2,$3,'bound','Fixture','{"type":"doc","content":[]}','todo','normal',$4)`, [id, owner, workspaceId, workspace ? 'workspace' : 'personal'])
      if (workspace) await databasePool.query('INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId") VALUES ($1,$2,$3,$4)', [id, randomUUID(), workspace, owner])
      return id
    }
    async function run(issueId: string | null, owner = 'owner', botId: string | null = null) {
      const id = randomUUID()
      const workspaceId = issueId ? (await databasePool.query('SELECT "workspaceId" FROM issues WHERE id=$1', [issueId])).rows[0].workspaceId
        : botId ? (await databasePool.query('SELECT "workspaceId" FROM bots WHERE id=$1', [botId])).rows[0].workspaceId : null
      await databasePool.query('INSERT INTO agent_runs(id,"userId","workspaceId","issueId","agentId","botId",status,prompt) VALUES($1,$2,$3,$4,$5,$6,\'running\',\'Fixture\')', [id, owner, workspaceId, issueId, agentIds.get(owner), botId])
      return id
    }
    const personalIssue = await issue(), teamIssue = await issue('owner', a), otherIssue = await issue()
    const privateRun = await run(personalIssue), teamRun = await run(teamIssue)
    const foreignRun = await run(teamIssue, 'foreign'), wrongIssueRun = await run(otherIssue), wrongPersonalRun = await run(personalIssue, 'foreign')
    const bot = randomUUID()
    await databasePool.query('INSERT INTO bots(id,"ownerId","workspaceId",name) VALUES($1,\'owner\',$2,\'Fixture\')', [bot, b])
    const taskFree = await run(null, 'owner', bot)
    const legacyTaskFree = await run(null)
    await databasePool.query('INSERT INTO computer_run_bindings("runId","botId","ownerId","workspaceId") VALUES($1,$2,\'owner\',$3)', [legacyTaskFree, bot, b])
    const drain = async () => { await coordinator.flush(); await Promise.all(pending.splice(0).map(work => work())) }

    await t.test('private document content has one owner; workspace documents notify only active authorized members', async () => {
      assert.deepEqual(await documentLiveTargets(databasePool, databasePool, personalIssue), [{
        scope: { ownerId: 'owner', workspaceId: personal }, events: [{ kind: 'issue_document', id: personalIssue }],
      }], 'even an accidental extra membership cannot publish a private body to a peer')
      const targets = await documentLiveTargets(databasePool, databasePool, teamIssue)
      assert.deepEqual(new Set(targets.map(value => value.scope.ownerId)), new Set(['owner', 'peer']))
      assert.ok(targets.every(value => value.scope.workspaceId === a))
      assert.deepEqual(await documentLiveTargets(databasePool, databasePool, teamIssue, 'foreign'), [])
      await databasePool.query(`UPDATE issues SET content='{"type":"doc","attrs":{"mikka":{"deletedAt":"2026-11-04"}}}' WHERE id=$1`, [otherIssue])
      assert.deepEqual(await documentLiveTargets(databasePool, databasePool, otherIssue), [])
    })

    await t.test('run keys stay private to their owner and actual scope; continuation edges cannot cross owner or issue', async () => {
      assert.deepEqual(await threadLiveReferences(databasePool, databasePool, [privateRun, teamRun, taskFree, legacyTaskFree, foreignRun], 'owner'), [
        { id: privateRun, workspaceId: personal }, { id: teamRun, workspaceId: a }, { id: taskFree, workspaceId: b }, { id: legacyTaskFree, workspaceId: null }, { id: foreignRun, workspaceId: null },
      ])
      assert.deepEqual(await runLiveTargets(databasePool, databasePool, legacyTaskFree, 'run'), [], 'an unresolved legacy run cannot gain a tenant from a later computer binding')
      assert.deepEqual(await threadLiveReferences(databasePool, databasePool, [wrongPersonalRun], 'foreign'), [{ id: wrongPersonalRun, workspaceId: null }], 'accidental membership cannot authorize another account\'s personal run channel')
      assert.deepEqual(await runLiveTargets(databasePool, databasePool, wrongPersonalRun, 'run'), [])
      const child = await run(personalIssue)
      await assert.rejects(databasePool.query('UPDATE agent_runs SET "retryOf"=$2,"continuesRunId"=$3,"questionContinuation"=$4 WHERE id=$1', [child, privateRun, foreignRun, JSON.stringify({ originRunId: wrongIssueRun })]), { code: '23514' }, 'a new cross-owner or cross-workspace lineage is refused atomically')
      assert.deepEqual((await databasePool.query('SELECT "retryOf","continuesRunId","questionContinuation" FROM agent_runs WHERE id=$1', [child])).rows[0], { retryOf: null, continuesRunId: null, questionContinuation: null })
      await databasePool.query('UPDATE agent_runs SET "retryOf"=$2 WHERE id=$1', [child, privateRun])
      const targets = await runLiveTargets(databasePool, databasePool, child, 'run')
      assert.deepEqual(targets, [{ scope: { ownerId: 'owner', workspaceId: personal }, events: [{ kind: 'run', id: child }, { kind: 'run', id: privateRun }] }])
      assert.deepEqual((await runLiveTargets(databasePool, databasePool, child, 'thread'))[0].events, [{ kind: 'thread', id: child }])
      await databasePool.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"='owner'`, [a])
      assert.deepEqual(await runLiveTargets(databasePool, databasePool, teamRun, 'run'), [])
      await databasePool.query(`UPDATE mikka_workspace_members SET status='active' WHERE "workspaceId"=$1 AND "userId"='owner'`, [a])
      const foreignBot = randomUUID()
      await databasePool.query(`INSERT INTO bots(id,"ownerId","workspaceId",name) VALUES($1,'foreign',$2,'Foreign')`, [foreignBot, b])
      await databasePool.query('UPDATE agent_runs SET "botId"=$2 WHERE id=$1', [taskFree, foreignBot])
      assert.deepEqual(await runLiveTargets(databasePool, databasePool, taskFree, 'run'), [])
      await databasePool.query('UPDATE agent_runs SET "botId"=$2 WHERE id=$1', [taskFree, bot])
    })

    await t.test('a request Pool proxy follows its held native client until the real outer COMMIT', async () => {
      await scope.run(async () => {
        const tx = await pool.connect()
        try {
          await tx.query('BEGIN')
          await withDatabaseClient(tx, async () => {
            assert.equal(databaseCommitScope(pool), databaseCommitScope(tx))
            await pool.query(`UPDATE agent_runs SET status='waiting_input' WHERE id=$1`, [privateRun])
            await runChanged(pool, privateRun)
            assert.equal(pending.length, 0)
            assert.equal((await databasePool.query('SELECT status FROM agent_runs WHERE id=$1', [privateRun])).rows[0].status, 'running')
          })
          await tx.query('COMMIT')
          assert.equal(pending.length, 1)
          await drain()
          assert.equal((await databasePool.query('SELECT status FROM agent_runs WHERE id=$1', [privateRun])).rows[0].status, 'waiting_input')
          assert.deepEqual(sent.splice(0), [{ scope: { ownerId: 'owner', workspaceId: personal }, events: [{ kind: 'run', id: privateRun }, { kind: 'issue_threads', id: personalIssue }] }])
        } finally { tx.release() }
      })
    })

    await t.test('a retained query keeps its actual transaction and request database across later callback contexts', async () => {
      const tx = await scope.run(() => pool.connect())
      try {
        await tx.query('BEGIN')
        const retained = scope.run(() => withDatabaseClient(tx, () => captureDatabaseQuery(pool)))
        assert.equal(databaseCommitScope(retained), databaseCommitScope(tx))
        // These callbacks run outside the original request. Neither the write
        // nor its later scope read may silently switch to the default DB.
        await retained.query(`UPDATE agent_runs SET status='running' WHERE id=$1`, [privateRun])
        await runChanged(retained, privateRun)
        assert.equal(pending.length, 0)
        assert.equal((await databasePool.query('SELECT status FROM agent_runs WHERE id=$1', [privateRun])).rows[0].status, 'waiting_input')
        await tx.query('COMMIT')
        assert.equal(pending.length, 1)
        await drain()
        assert.deepEqual(sent.splice(0), [{ scope: { ownerId: 'owner', workspaceId: personal }, events: [{ kind: 'run', id: privateRun }, { kind: 'issue_threads', id: personalIssue }] }])
        assert.equal((await databasePool.query('SELECT status FROM agent_runs WHERE id=$1', [privateRun])).rows[0].status, 'running')
      } finally { tx.release() }
    })

    await t.test('the actual stream writer waits through Drizzle savepoints, ignores duplicate batches, and keeps a final update', async () => {
      const { persistRunEventBatch } = await import('../secrets/run-events')
      const { identityMasker } = await import('../secrets/mask')
      await scope.run(async () => {
        await db.transaction(outer => withDatabaseTransaction(outer, async () => {
          await persistRunEventBatch(privateRun, 0, [{ type: 'text-start', id: 'reply' }, { type: 'text-delta', id: 'reply', delta: 'first' }], identityMasker)
          assert.equal(pending.length, 0)
          assert.equal((await databasePool.query('SELECT id FROM run_chunks WHERE "runId"=$1', [privateRun])).rowCount, 0)
          await assert.rejects(db.transaction(inner => withDatabaseTransaction(inner, async () => {
            await persistRunEventBatch(privateRun, 2, [{ type: 'text-delta', id: 'reply', delta: 'reverted' }], identityMasker)
            throw new Error('rollback inner')
          })), /rollback inner/)
          assert.equal(pending.length, 0)
        }))
        assert.equal(pending.length, 1)
        await persistRunEventBatch(privateRun, 0, [{ type: 'text-start', id: 'reply' }, { type: 'text-delta', id: 'reply', delta: 'first' }], identityMasker)
        assert.equal(pending.length, 1, 'duplicate outbox delivery cannot create another invalidation')
        for (let seq = 2; seq < 22; seq++) await persistRunEventBatch(privateRun, seq, [{ type: 'text-delta', id: 'reply', delta: String(seq) }], identityMasker)
        await drain()
        assert.deepEqual(sent.splice(0), [{ scope: { ownerId: 'owner', workspaceId: personal }, events: [{ kind: 'thread', id: privateRun }] }], 'committed token batches coalesce before scope queries')
        const chunks = (await databasePool.query('SELECT chunk FROM run_chunks WHERE "runId"=$1 ORDER BY seq', [privateRun])).rows
        assert.equal(chunks.length, 22)
        assert.equal(chunks.at(-1).chunk.delta, '21')
        assert.equal(JSON.stringify(chunks).includes('reverted'), false)
        await assert.rejects(db.transaction(outer => withDatabaseTransaction(outer, async () => {
          await persistRunEventBatch(privateRun, 22, [{ type: 'text-delta', id: 'reply', delta: 'outer rollback' }], identityMasker)
          throw new Error('rollback outer')
        })), /rollback outer/)
        assert.equal(pending.length, 0)
        assert.equal((await databasePool.query('SELECT id FROM run_chunks WHERE "runId"=$1 AND seq=22', [privateRun])).rowCount, 0)
      })
    })

    await t.test('actual messages and first stop requests notify once, while repeats and rejected owners send nothing', async () => {
      const { sendOwnedRunMessage, stopOwnedRun } = await import('../run-control')
      const messageId = randomUUID()
      await scope.run(async () => {
        await sendOwnedRunMessage(db, 'owner', { runId: privateRun, messageId, text: 'Please continue' })
        assert.equal(pending.length, 1)
        await sendOwnedRunMessage(db, 'owner', { runId: privateRun, messageId, text: 'Please continue' })
        assert.equal(pending.length, 1)
        await assert.rejects(sendOwnedRunMessage(db, 'foreign', { runId: privateRun, text: 'forbidden' }))
        assert.equal(pending.length, 1)
        await drain(); sent.length = 0
        await stopOwnedRun(db, 'owner', privateRun)
        assert.equal(pending.length, 1)
        await stopOwnedRun(db, 'owner', privateRun)
        assert.equal(pending.length, 1)
        await drain()
        assert.deepEqual(sent.splice(0), [{ scope: { ownerId: 'owner', workspaceId: personal }, events: [{ kind: 'run', id: privateRun }, { kind: 'issue_threads', id: personalIssue }] }])
      })
    })

    await t.test('the actual document exchange notifies after a committed body change, never for unchanged versions or rollback', async () => {
      const { actAs } = await import('../acting-user')
      const { tokenWorkspace } = await import('../tokens/principal')
      const { exchangeDocument } = await import('../../app/actions/collaboration')
      const { createDocumentSeed } = await import('../../components/workspace/issue-editor-schema')
      const docId = await issue()
      const seed = createDocumentSeed({ type: 'doc', content: [] }, docId)!
      await scope.run(async () => {
        await assert.rejects(db.transaction(outer => withDatabaseTransaction(outer, async () => {
          await actAs({ id: 'owner', [tokenWorkspace]: personal }, () => exchangeDocument({ id: docId, seed: Buffer.from(seed).toString('base64') }))
          assert.equal(pending.length, 0)
          throw new Error('document rollback')
        })), /document rollback/)
        assert.equal(pending.length, 0)
        assert.equal((await databasePool.query('SELECT "issueId" FROM issue_documents WHERE "issueId"=$1', [docId])).rowCount, 0)
        const first = await actAs({ id: 'owner', [tokenWorkspace]: personal }, () => exchangeDocument({ id: docId, seed: Buffer.from(seed).toString('base64') }))
        assert.equal(first.workspaceId, personal)
        assert.equal(pending.length, 1)
        assert.deepEqual(await actAs({ id: 'owner', [tokenWorkspace]: personal }, () => exchangeDocument({ id: docId, known: first.version })), { version: first.version, workspaceId: personal })
        assert.equal(pending.length, 1)
        await assert.rejects(actAs({ id: 'foreign', [tokenWorkspace]: foreignPersonal }, () => exchangeDocument({ id: docId, known: first.version })), { code: 'issueNotFound' })
        await drain()
        assert.deepEqual(sent.splice(0), [{ scope: { ownerId: 'owner', workspaceId: personal }, events: [{ kind: 'issue_document', id: docId }] }])
      })
    })
    await t.test('disabling sync preserves the tenant; a committed document change rechecks members and never publishes in the personal workspace', async () => {
      const { changeIssueScopeLocally } = await import('../issue-scope-store')
      const { actAs } = await import('../acting-user')
      const { tokenWorkspace } = await import('../tokens/principal')
      const { exchangeDocument } = await import('../../app/actions/collaboration')
      const { createDocumentSeed } = await import('../../components/workspace/issue-editor-schema')
      const id = await issue('owner', a)
      await databasePool.query(`UPDATE issues SET "linearSyncPolicy"='explicit',"linearSyncBlocked"=false WHERE id=$1`, [id])
      const before = (await databasePool.query('SELECT revision FROM issues WHERE id=$1', [id])).rows[0].revision
      const seed = createDocumentSeed({ type: 'doc', content: [] }, id)!
      await scope.run(async () => {
        await db.transaction(outer => withDatabaseTransaction(outer, async () => {
          const result = await changeIssueScopeLocally('owner', { id, revision: before, scope: 'personal' }, { allowLinkedPersonal: true })
          assert.ok('issue' in result && result.issue)
          assert.equal(result.issue.workspaceId, a)
          assert.equal(result.issue.scope, 'workspace')
          assert.equal(result.issue.linearSyncPolicy, 'disabled')
          assert.equal(pending.length, 0)
          await actAs({ id: 'owner', [tokenWorkspace]: a }, () => exchangeDocument({ id, seed: Buffer.from(seed).toString('base64') }))
          assert.equal(pending.length, 0)
          await databasePool.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"='peer'`, [a])
        }))
        assert.equal(pending.length, 1)
        await drain()
        assert.deepEqual(new Set(sent.map(target => JSON.stringify(target.scope))), new Set([
          JSON.stringify({ ownerId: 'owner', workspaceId: a }),
        ]))
        assert.ok(sent.every(target => target.events.every(event => event.id === id && Object.keys(event).length === 2)))
        await assert.rejects(actAs({ id: 'peer', [tokenWorkspace]: a }, () => exchangeDocument({ id, known: 'a'.repeat(32) })), { code: 'issueNotFound' })
        sent.length = 0
      })
      await databasePool.query(`UPDATE mikka_workspace_members SET status='active' WHERE "workspaceId"=$1 AND "userId"='peer'`, [a])
    })

    await t.test('Factory question-only writes notify once after commit, and a rolled-back settlement stays silent', async () => {
      const { createFactoryStore } = await import('../factory/store')
      const { createFactoryDispatch, factoryBinding } = await import('../factory/dispatch')
      const { factoryCheckIndependent } = await import('../factory/check-independence')
      const { createFactoryQuestions } = await import('../factory/questions/store')
      const deviceId = randomUUID(), repoId = randomUUID(), agentId = agentIds.get('owner')!
      devicePaths.add(`/v1/devices/${deviceId}/push`)
      await databasePool.query(`INSERT INTO devices(id,"ownerId",name,"lastSeenAt",harnesses) VALUES($1,'owner','Fixture',now(),'[{"harness":"codex","installed":true}]')`, [deviceId])
      await databasePool.query('UPDATE agents SET "deviceId"=$2 WHERE id=$1', [agentId, deviceId])
      await databasePool.query(`INSERT INTO device_repos(id,"deviceId","userId","repoPath") VALUES($1,$2,'owner','/fixture/repo')`, [repoId, deviceId])
      const authorize = async (owner: string, issueId: string, tx: import('pg').PoolClient) => (await tx.query('SELECT id FROM issues WHERE id=$1 AND "userId"=$2', [issueId, owner])).rowCount === 1
      const store = createFactoryStore(databasePool, authorize, null, { independent: factoryCheckIndependent })
      const dispatch = createFactoryDispatch(databasePool, store, async (tx, owner, input, botId) => {
        const runId = randomUUID()
        await tx.query(`INSERT INTO agent_runs(id,"userId","issueId","agentId","deviceId","deviceRepoId","botId",status,prompt) VALUES($1,$2,$3,$4,$5,$6,$7,'queued','Fixture')`, [runId, owner, input.issueId, input.agentId, deviceId, input.deviceRepoId, botId])
        return { runId }
      }, { configure: { execute: async () => {} }, freeze: async (tx, _task, id) => {
        await tx.query('UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=$1', [id, JSON.stringify({ schemaVersion: 1, definitionDigest: 'fixture', harness: 'codex' })])
      } })
      const questions = createFactoryQuestions(databasePool, authorize, store, dispatch)
      await scope.run(async () => {
        async function asked() {
          const issueId = await issue(), sourceEventId = randomUUID(), questionId = randomUUID()
          await databasePool.query(`INSERT INTO coordinator_events(id,"userId",kind,"dedupeKey",payload) VALUES($1,'owner','user_message',$2,'{"text":"Fixture"}')`, [sourceEventId, sourceEventId])
          const routed = await store.route('owner', { issueId, sourceEventId, eventId: randomUUID(), rationale: 'Requested task', missingInformation: [], missingPermissions: [], needsSpec: false })
          const { runId } = await dispatch('owner', { binding: factoryBinding(routed.task), agentId, deviceRepoId: repoId })
          await databasePool.query(`UPDATE agent_runs SET status='stopped',"stopReason"='asked_human',"sessionId"='session:'||id,"startedAt"=now(),"finishedAt"=now(),report=$2 WHERE id=$1`, [runId, JSON.stringify({ summary: 'Fixture hand-in', openQuestions: ['Which context?'], question: { questionId, kind: 'context', question: 'Which context?', options: [] } })])
          await questions.record('owner', runId)
          // Finish the preparation commit, including its asynchronously
          // registered inbox wake, before observing the escalation commit.
          await drain()
          sent.length = 0; coordinator.calls.length = 0
          return { issueId, questionId, runId }
        }
        const first = await asked()
        const { readThreadQuestionState } = await import('../issue-thread-questions')
        await databasePool.query(`UPDATE factory_questions SET "expiresAt"=now()+interval '5 minutes' WHERE id=$1`, [first.questionId])
        const timed = await readThreadQuestionState(databasePool, [first.runId], 'owner')
        assert.equal(timed.states.get(first.runId), 'waiting')
        assert.ok(timed.deadline && timed.deadline.afterMs > 0 && timed.deadline.afterMs <= 300_000)
        const reference = (await questions.read('owner', first.questionId)).reference
        const escalation = { reference, eventId: randomUUID(), reason: 'Context requires the owner' }
        assert.equal((await questions.escalate('owner', escalation)).status, 'waiting_user')
        await coordinator.flush()
        assert.equal(pending.length, 2, 'only Factory/project-map live notifications enter the delivery queue')
        await questions.read('owner', first.questionId)
        await questions.escalate('owner', escalation)
        await coordinator.flush()
        assert.equal(pending.length, 2, 'reads and an idempotent replay add nothing')
        await drain()
        assert.deepEqual(coordinator.calls.splice(0), ['owner'], 'the committed question wakes its owner once')
        assert.ok(sent.some(target => target.events.some(event => event.kind === 'factory_issue' && event.id === first.issueId)))
        sent.length = 0
        await databasePool.query(`UPDATE factory_questions SET "expiresAt"=now()-interval '1 minute' WHERE id=$1`, [first.questionId])
        const expired = await readThreadQuestionState(databasePool, [first.runId], 'owner')
        assert.equal(expired.states.size, 0)
        assert.equal(expired.deadline, null)
        assert.equal((await questions.escalate('owner', escalation)).status, 'expired')
        assert.equal(pending.length, 2, 'currentView on a write path persists expiry and invalidates')
        await drain(); sent.length = 0

        const second = await asked(), continuation = await run(second.issueId)
        await databasePool.query(`UPDATE agent_runs SET status='succeeded',"stopReason"='submitted',"sessionId"=$2 WHERE id=$1`, [continuation, `session:${second.runId}`])
        await databasePool.query(`UPDATE factory_questions SET status='resuming',"continuationRunId"=$2 WHERE id=$1`, [second.questionId, continuation])
        const tx = await databasePool.connect()
        try {
          await tx.query('BEGIN')
          assert.equal((await questions.settle('owner', continuation, tx))?.status, 'resolved')
          assert.equal(pending.length, 0)
          assert.equal((await databasePool.query('SELECT status FROM factory_questions WHERE id=$1', [second.questionId])).rows[0].status, 'resuming')
          await tx.query('ROLLBACK')
          assert.equal(pending.length, 0)
          await tx.query('BEGIN')
          await questions.settle('owner', continuation, tx)
          assert.equal(pending.length, 0)
          await tx.query('COMMIT')
          assert.equal(pending.length, 2)
          await questions.settle('owner', continuation)
          assert.equal(pending.length, 2, 'settled replay does not notify again')
          await drain()
          assert.ok(sent.some(target => target.events.some(event => event.kind === 'factory_issue' && event.id === second.issueId)))
        } finally { tx.release() }
      })
    })
  } finally {
    await scope.close()
    globalDb.workspacePool = previousWorkspace
    scheduler.restore(); listMock.restore()
    if (previous.url === undefined) delete process.env.DEVICE_GATEWAY_URL; else process.env.DEVICE_GATEWAY_URL = previous.url
    if (previous.secret === undefined) delete process.env.DEVICE_GATEWAY_PUSH_SECRET; else process.env.DEVICE_GATEWAY_PUSH_SECRET = previous.secret
    await dropTestDatabase(admin, database, databasePool)
    await admin.end()
    assert.deepEqual(unexpectedPaths, [], 'the real notifier can address only the fixture scopes')
    assert.deepEqual(new Set(deviceWakes), devicePaths, 'queued work wakes only the fixture device without sending panel data')
  }
})
