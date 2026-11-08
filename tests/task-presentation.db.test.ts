import './fixtures/activity-runtime.mjs'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { Client, Pool } from 'pg'
import { disposableDatabase } from './helpers/e2e-target.mjs'
import { dropTestDatabase } from './support/drop-test-database'
import { orderMigrations } from '../scripts/migration-order.mjs'
import { applyMigration, planMigration } from '../scripts/migration-steps.mjs'
import { scopeMigrationBeforeCommit } from '../scripts/scope-migration-history.mjs'
import type { FactoryTask } from '../lib/factory/store'

const url = process.env.E2E_DATABASE_URL
if (url && !disposableDatabase()) throw new Error('Task presentation requires isolated loopback *_e2e databases')
if (process.env.REQUIRE_DB === '1' && !url) throw new Error('Task presentation cannot skip required PostgreSQL verification')

test('Task presentation batches keep current tenant authority and one Factory projection on separate databases', { skip: !url, timeout: 240_000 }, async t => {
  const suffix = randomUUID().replaceAll('-', '')
  const appName = `presentation_app_${suffix}_e2e`, workspaceName = `presentation_ws_${suffix}_e2e`
  const admin = new Pool({ connectionString: url, max: 1 })
  await admin.query(`CREATE DATABASE "${appName}" TEMPLATE template0`)
  await admin.query(`CREATE DATABASE "${workspaceName}" TEMPLATE template0`)
  const appUrl = new URL(url!), workspaceUrl = new URL(url!)
  appUrl.pathname = `/${appName}`; workspaceUrl.pathname = `/${workspaceName}`
  const application = new Pool({ connectionString: appUrl.toString(), max: 4 })
  const workspace = new Pool({ connectionString: workspaceUrl.toString(), max: 4 })
  const previousEnv = { app: process.env.MIKKA_DATABASE_URL, workspace: process.env.DATABASE_URL }
  process.env.MIKKA_DATABASE_URL = appUrl.toString(); process.env.DATABASE_URL = workspaceUrl.toString()
  let applicationModule: Pool | undefined, workspaceModule: Pool | undefined
  type Statement = { database: string; sql: string }
  let statements: Statement[] | undefined
  let pauseFactoryRead: (() => Promise<void>) | undefined
  const originalQuery = Client.prototype.query
  Client.prototype.query = function (this: Client, ...args: unknown[]) {
    const first = args[0] as string | { text?: string }
    const sql = typeof first === 'string' ? first : first?.text ?? ''
    const database = (this as unknown as { connectionParameters: { database: string } }).connectionParameters.database
    statements?.push({ database, sql })
    if (pauseFactoryRead && sql.includes('SELECT DISTINCT ON (t."issueId")')) {
      const pause = pauseFactoryRead; pauseFactoryRead = undefined
      return pause().then(() => Reflect.apply(originalQuery, this, args))
    }
    return Reflect.apply(originalQuery, this, args)
  } as typeof Client.prototype.query
  const counted = async <T>(work: () => Promise<T>) => {
    statements = []
    try { const result = await work(); return { result, statements: [...statements] } }
    finally { statements = undefined }
  }
  try {
    const directory = new URL('../drizzle/', import.meta.url)
    for (const target of [application, workspace]) await target.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,"appliedAt" timestamptz NOT NULL DEFAULT now())')
    for (const name of orderMigrations((await readdir(directory)).filter(name => name.endsWith('.sql')))) {
      const source = await readFile(new URL(name, directory), 'utf8')
      const plan = planMigration(name, source)
      const client = await (plan.target === 'DATABASE_URL' ? workspace : application).connect()
      try {
        const scope = scopeMigrationBeforeCommit(name, source)
        await applyMigration(client, name, scope === null ? plan : { ...plan, sql: scope })
        if (scope !== null) await client.query('COMMIT')
      } finally { client.release() }
    }
    assert.equal((await application.query("SELECT to_regclass('mikka_workspaces') AS relation")).rows[0].relation, null)
    assert.equal((await workspace.query("SELECT to_regclass('issues') AS relation")).rows[0].relation, null)
    const { withActivitySession } = await import('./fixtures/activity-runtime.mjs')
    const { getTaskPresentation, getTaskPresentations } = await import('../app/actions/task-domain')
    const { scopedTaskPresentationReader } = await import('../lib/task-presentation-read')
    const { tokenWorkspace } = await import('../lib/tokens/principal')
    const { enterprisePrincipal } = await import('../lib/enterprise/principal')
    const { actAs } = await import('../lib/acting-user')
    const { createRequestScope, runRequestScope } = await import('../apps/api/src/context')
    applicationModule = (await import('../lib/db')).pool
    workspaceModule = (await import('../lib/workspace-db')).workspacePool
    const owner = `presentation-owner-${suffix}`, peer = `presentation-peer-${suffix}`
    for (const userId of [owner, peer]) await application.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())', [userId, `${userId}@example.invalid`])
    const personal = randomUUID(), shared = randomUUID(), other = randomUUID()
    for (const [id, kind] of [[personal, 'personal'], [shared, 'team'], [other, 'team']]) {
      await workspace.query('INSERT INTO mikka_workspaces(id,"userId",name,kind) VALUES($1,$2,\'Presentation fixture\',$3)', [id, owner, kind])
      for (const userId of kind === 'personal' ? [owner] : [owner, peer]) await workspace.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$3,\'admin\',\'active\')', [id, userId, `${userId}@example.invalid`])
    }
    const as = <T>(userId: string, workspaceId: string, work: () => Promise<T>, header?: string) =>
      withActivitySession(userId, () => runRequestScope(createRequestScope(new Request('http://localhost/mikka/api/rpc', {
        headers: header === undefined ? {} : { 'x-mikka-workspace-id': header },
      })), work), workspaceId)
    const batch = (issueIds: string[], workspaceId = shared, userId = owner) => as(userId, workspaceId, () => getTaskPresentations({ workspaceId, issueIds }))
    const makeTask = async (workspaceId = shared, metadata: Record<string, unknown> = {}, status = 'doing', userId = owner, contentOverride?: unknown) => {
      const id = randomUUID()
      await application.query(`INSERT INTO issues(id,"userId","workspaceId","ownershipState",scope,title,content,status,priority)
        VALUES($1,$2,$3,'bound',$4,'Presentation fixture',$5,$6,'normal')`, [id, userId, workspaceId, workspaceId === personal ? 'personal' : 'workspace',
        JSON.stringify(contentOverride ?? { type: 'doc', attrs: { mikka: metadata }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'private body '.repeat(8000) }] }] }), status])
      return id
    }
    const agents = new Map<string, string>()
    for (const userId of [owner, peer]) {
      const id = randomUUID(); agents.set(userId, id)
      await application.query('INSERT INTO agents(id,"userId",harness,name) VALUES($1,$2,\'codex\',\'Synthetic agent\')', [id, userId])
    }
    const makeBot = async (userId = owner, workspaceId = shared) => {
      const id = randomUUID()
      await application.query('INSERT INTO bots(id,"ownerId","workspaceId",name) VALUES($1,$2,$3,$4)', [id, userId, workspaceId, `Synthetic bot ${id}`])
      return id
    }
    const makeRun = async (issueId: string, options: { userId?: string; workspaceId?: string; status?: string; outcome?: string | null; id?: string; createdAt?: string } = {}) => {
      const userId = options.userId ?? owner, id = options.id ?? randomUUID()
      await application.query(`INSERT INTO agent_runs(id,"userId","agentId","workspaceId","issueId",status,outcome,prompt,"createdAt")
        VALUES($1,$2,$3,$4,$5,$6,$7,'private prompt must stay in APP',$8)`,
      [id, userId, agents.get(userId), options.workspaceId ?? shared, issueId, options.status ?? 'succeeded', options.outcome ?? null, options.createdAt ?? '2026-11-08T00:00:00Z'])
      return id
    }
    const makeFactory = async (issueId: string, options: { userId?: string; workspaceId?: string; botId?: string | null; sourceBotId?: string | null;
      sourceUserId?: string; sourceIssueId?: string; sourceKind?: string; id?: string; stage?: FactoryTask['stage']; status?: FactoryTask['status']; updatedAt?: string } = {}) => {
      const id = options.id ?? randomUUID(), source = randomUUID(), attempt = randomUUID(), userId = options.userId ?? owner
      const botId = options.botId ?? null, sourceBotId = Object.hasOwn(options, 'sourceBotId') ? options.sourceBotId : botId
      await application.query('INSERT INTO coordinator_events(id,"userId","botId","issueId",kind,"dedupeKey",payload) VALUES($1,$2,$3,$4,$5,$6,\'{}\')',
        [source, options.sourceUserId ?? userId, sourceBotId, options.sourceIssueId ?? issueId, options.sourceKind ?? 'user_message', source])
      const client = await application.connect()
      try {
        await client.query('BEGIN')
        await client.query(`INSERT INTO factory_tasks(id,"userId","workspaceId","botId","issueId","sourceEventId",route,stage,status,"attemptId",reason,"updatedAt")
          VALUES($1,$2,$3,$4,$5,$6,'{"flowVersion":2}',$7,$8,$9,'private reason must stay in APP',$10)`,
        [id, userId, options.workspaceId ?? shared, botId, issueId, source, options.stage ?? 'clarify', options.status ?? 'waiting', attempt, options.updatedAt ?? '2026-11-08T00:00:00Z'])
        await client.query('INSERT INTO factory_attempts(id,"taskId",stage,ordinal,position,status,reason) VALUES($1,$2,$3,1,1,$4,\'Synthetic\')',
          [attempt, id, options.stage ?? 'clarify', options.status ?? 'waiting'])
        await client.query('COMMIT')
      } catch (error) { await client.query('ROLLBACK'); throw error }
      finally { client.release() }
      return { id, source, attempt, issueId, userId }
    }
    const expected = (patch: Record<string, unknown> = {}) => ({ version: 1, primaryStatus: 'doing', factoryStage: null, runStatus: null, needsAction: null, blockedReason: null, completion: null, ...patch })

    await t.test('the action returns current-tenant business status without another actor private Run or Factory', async () => {
      const issue = await makeTask(shared, {}, 'doing', peer)
      await makeRun(issue, { userId: peer, status: 'waiting_input' })
      await makeFactory(issue, { userId: peer })
      assert.deepEqual((await batch([issue])).items[issue], expected())
      const own = await batch([issue], shared, peer)
      assert.deepEqual(own.items[issue], expected({ factoryStage: 'triage', runStatus: 'waiting_input', needsAction: 'question', blockedReason: 'question' }))
      assert.deepEqual(await as(peer, shared, () => getTaskPresentation(issue)), own.items[issue], 'detail and batch use the same existing Factory state rule')
      assert.doesNotMatch(JSON.stringify(own), /private body|private prompt|private reason/)
    })

    await t.test('missing, quarantined, tombstoned, foreign-Workspace and malformed Team-linked IDs are omitted alike', async () => {
      const valid = await makeTask(), foreign = await makeTask(other), privateTask = await makeTask(personal)
      const deleted = await makeTask(shared, { deletedAt: new Date().toISOString() })
      const deletedAt = new Date().toISOString()
      // JSON-null mikka cannot survive the installed generated-number constraint,
      // even on UPDATE. Keep that refusal, then read a valid numbered tombstone
      // that still carries its historical orvilo metadata.
      await assert.rejects(makeTask(shared, {}, 'doing', owner, { type: 'doc', attrs: { mikka: null, orvilo: { deletedAt } } }),
        { code: '23514', constraint: 'issues_number_required' })
      const legacyDeleted = await makeTask(shared, {}, 'doing', owner, { type: 'doc', attrs: { mikka: { deletedAt }, orvilo: { deletedAt } } })
      const pending = randomUUID()
      await application.query('INSERT INTO issues(id,"userId",scope,title,content,status,priority) VALUES($1,$2,\'personal\',\'Pending\',\'{"type":"doc"}\',\'todo\',\'normal\')', [pending, owner])
      const malformed = await makeTask(), team = randomUUID()
      await workspace.query('INSERT INTO mikka_teams(id,"workspaceId","userId",name,identifier) VALUES($1,$2,$3,\'Foreign group\',$4)', [team, other, owner, `P${suffix.slice(0, 6).toUpperCase()}`])
      await workspace.query('INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId") VALUES($1,$2,$3,$4)', [malformed, team, other, owner])
      const result = await batch([valid, valid, randomUUID(), foreign, privateTask, deleted, legacyDeleted, pending, malformed])
      assert.deepEqual(result, { version: 1, workspaceId: shared, items: { [valid]: expected() } })
      for (const id of [foreign, deleted, legacyDeleted, pending, malformed]) await assert.rejects(as(owner, shared, () => getTaskPresentation(id)), { code: 'issueNotFound' })
    })

    await t.test('the current selection, immutable PAT pin and non-enumerable principal all survive batch binding', async () => {
      const issue = await makeTask()
      await assert.rejects(as(owner, other, () => getTaskPresentations({ workspaceId: shared, issueIds: [issue] })), { code: 'workspaceAccessDenied' })
      await assert.rejects(as(owner, shared, () => getTaskPresentations({ workspaceId: shared, issueIds: [issue] }), other), { code: 'workspaceAccessDenied' })
      const proof = Object.freeze({ kind: 'pat' as const, tokenId: randomUUID(), workspaceId: shared })
      const pat = Object.freeze(Object.defineProperties({ id: owner }, { [tokenWorkspace]: { value: shared }, [enterprisePrincipal]: { value: proof } }))
      const bound = scopedTaskPresentationReader(pat, shared)
      assert.equal(Object.getOwnPropertyDescriptor(bound, enterprisePrincipal)?.value, proof)
      assert.equal(Object.getOwnPropertyDescriptor(bound, tokenWorkspace)?.value, shared)
      assert.equal(Object.getOwnPropertyDescriptor(bound, enterprisePrincipal)?.enumerable, false)
      assert.throws(() => scopedTaskPresentationReader(pat, other), { code: 'workspaceAccessDenied' })
      assert.deepEqual((await actAs(pat, () => getTaskPresentations({ workspaceId: shared, issueIds: [issue] }))).items[issue], expected())
      await assert.rejects(actAs(pat, () => getTaskPresentations({ workspaceId: other, issueIds: [] })), { code: 'workspaceAccessDenied' })
      await assert.rejects(as(owner, shared, () => actAs(pat, () => getTaskPresentations({ workspaceId: shared, issueIds: [issue] })), other), { code: 'workspaceAccessDenied' })
    })

    await t.test('batch input is bounded before database reads; an empty batch still requires live membership', async () => {
      for (const input of [{ workspaceId: shared, issueIds: Array.from({ length: 201 }, () => randomUUID()) },
        { workspaceId: shared, issueIds: ['not-an-id'] }, { workspaceId: shared, issueIds: [], userId: peer }]) {
        const result = await counted(async () => { await assert.rejects(as(owner, shared, () => getTaskPresentations(input))) })
        assert.equal(result.statements.length, 0)
      }
      assert.deepEqual(await batch([]), { version: 1, workspaceId: shared, items: {} })
      await workspace.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [shared, peer])
      await assert.rejects(batch([], shared, peer), { code: 'workspaceAccessDenied' })
      await workspace.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2', [shared, peer])
    })

    await t.test('unknown dependencies stay blocked, resolved dependencies clear, and successful execution never completes work', async () => {
      const foreign = await makeTask(other, {}, 'done'), closed = await makeTask(shared, {}, 'done')
      const unknown = await makeTask(shared, { blockedByIds: [foreign, randomUUID()] })
      const ready = await makeTask(shared, { blockedByIds: [closed] })
      const success = await makeTask(), cancelled = await makeTask(shared, {}, 'canceled')
      await makeRun(success, { outcome: 'done' })
      await makeRun(cancelled, { status: 'waiting_input' })
      const result = await batch([unknown, ready, success, cancelled])
      assert.deepEqual(result.items[unknown], expected({ needsAction: 'dependency', blockedReason: 'dependency' }))
      assert.deepEqual(result.items[ready], expected())
      assert.deepEqual(result.items[success], expected({ runStatus: 'succeeded' }))
      assert.deepEqual(result.items[cancelled], expected({ primaryStatus: 'canceled', runStatus: 'waiting_input' }))
      for (const id of [unknown, ready, success, cancelled]) assert.deepEqual(await as(owner, shared, () => getTaskPresentation(id)), result.items[id])
    })

    await t.test('equal timestamps use stable UUID ordering for the latest Run and Factory', async () => {
      const issue = await makeTask()
      await makeRun(issue, { id: '00000000-0000-4000-8000-000000000001', status: 'waiting_input' })
      await makeRun(issue, { id: '00000000-0000-4000-8000-000000000002', status: 'succeeded' })
      await makeFactory(issue, { id: '00000000-0000-4000-8000-000000000003', stage: 'execute', status: 'running' })
      await makeFactory(issue, { id: '00000000-0000-4000-8000-000000000004' })
      const result = await batch([issue])
      assert.deepEqual(result.items[issue], expected({ runStatus: 'succeeded', factoryStage: 'triage', needsAction: 'question' }))
      assert.deepEqual(await as(owner, shared, () => getTaskPresentation(issue)), result.items[issue])
    })

    await t.test('foreign source users, issues, message kinds and Bots do not expose a Factory state or resurrect an older one', async () => {
      const ownBot = await makeBot(), foreignBot = await makeBot(peer), anotherWorkspaceBot = await makeBot(), anotherIssue = await makeTask()
      const ids: string[] = []
      for (const options of [{ sourceUserId: peer }, { sourceIssueId: anotherIssue }, { sourceKind: 'system' },
        { botId: ownBot, sourceBotId: foreignBot }, { botId: foreignBot }, { botId: anotherWorkspaceBot }]) {
        const issue = await makeTask(); ids.push(issue)
        await makeFactory(issue, { stage: 'execute', status: 'running', updatedAt: '2026-11-07T23:00:00Z' })
        await makeFactory(issue, options)
      }
      // Admission correctly refuses a foreign Bot. Seed a valid historical
      // binding first, then exercise a later Bot tenant change at read time.
      const moved = await application.query('UPDATE bots SET "workspaceId"=$2 WHERE id=$1 AND "ownerId"=$3 RETURNING "workspaceId"', [anotherWorkspaceBot, other, owner])
      assert.deepEqual(moved.rows, [{ workspaceId: other }])
      const result = await batch(ids)
      for (const id of ids) assert.deepEqual(result.items[id], expected())
    })

    await t.test('only the current candidate actual merge or deliverable acceptance supplies completion', async () => {
      const ids: string[] = []
      for (const kind of ['repository', 'report', 'deliverable'] as const) {
        const issue = await makeTask(); ids.push(issue)
        const factory = await makeFactory(issue, { stage: 'approval', status: 'passed' })
        const candidate = randomUUID()
        await application.query('INSERT INTO factory_candidates(id,"taskId",sha,kind,repository,environment,scope,"runId") VALUES($1,$2,$3,$4,\'example/report\',\'fixture\',\'repo\',$5)', [candidate, factory.id, kind === 'deliverable' ? null : 'a'.repeat(40), kind, randomUUID()])
        await application.query('UPDATE factory_tasks SET "candidateId"=$2 WHERE id=$1', [factory.id, candidate])
        if (kind === 'repository') await application.query('INSERT INTO factory_merges(id,"taskId","candidateId","userId","eventId","pullRequestUrl",sha,status,source) VALUES($1,$2,$3,$4,$5,\'https://github.com/example/report/pull/1\',$6,\'merged\',\'mikka\')', [randomUUID(), factory.id, candidate, owner, randomUUID(), 'a'.repeat(40)])
        else await application.query('INSERT INTO factory_deliverable_acceptances(id,"taskId","candidateId","userId","sessionId","eventId") VALUES($1,$2,$3,$4,\'synthetic-session\',$5)', [randomUUID(), factory.id, candidate, owner, randomUUID()])
        const result = await batch([issue])
        assert.deepEqual(result.items[issue], expected({ factoryStage: 'completed', completion: kind === 'repository' ? 'merged' : 'accepted' }))
        assert.deepEqual(await as(owner, shared, () => getTaskPresentation(issue)), result.items[issue])
        await application.query('UPDATE factory_tasks SET "candidateId"=NULL WHERE id=$1', [factory.id])
      }
      const result = await batch(ids)
      for (const id of ids) assert.equal(result.items[id].completion, null, 'a receipt for an old candidate cannot finish the current work')
    })

    await t.test('one and 200 Tasks use the same bounded APP/WS query count and no full bodies', async () => {
      const blocker = await makeTask(shared, {}, 'done'), ids: string[] = []
      for (let i = 0; i < 200; i++) {
        const issue = await makeTask(shared, { blockedByIds: [blocker] }); ids.push(issue)
        await makeRun(issue)
        await makeFactory(issue)
      }
      const one = await counted(() => batch(ids.slice(0, 1))), many = await counted(() => batch(ids))
      assert.equal(Object.keys(many.result.items).length, 200)
      for (const id of ids) assert.deepEqual(many.result.items[id], expected({ runStatus: 'succeeded', factoryStage: 'triage', needsAction: 'question' }))
      assert.equal(many.statements.length, one.statements.length, 'no per-Task authorization, Factory or dependency queries')
      assert.ok(many.statements.length <= 14, `Task presentation: ${many.statements.length} statements exceed the fixed budget`)
      const appSelects = many.statements.filter(row => row.database === appName && /^\s*select\b/i.test(row.sql))
      assert.ok(appSelects.length <= 5, `APP projection: ${appSelects.length} SELECTs`)
      assert.equal(appSelects.filter(row => /FROM factory_tasks t WHERE/.test(row.sql)).length, 1)
      assert.equal(appSelects.filter(row => /factory_deliverable_acceptances/.test(row.sql)).length, 1)
      assert.ok(appSelects.every(row => !/\bmikka_(?:workspaces|workspace_members|team_issues)\b/.test(row.sql)), 'APP never joins Workspace tables')
      assert.ok(many.statements.filter(row => row.database === workspaceName).every(row => !/\b(?:issues|agent_runs|factory_tasks)\b/.test(row.sql)), 'WS never joins APP tables')
      assert.ok(Buffer.byteLength(JSON.stringify(many.result)) < 60_000)
      assert.doesNotMatch(JSON.stringify(many.result), /private body|private prompt|private reason/)
      t.diagnostic(JSON.stringify({ read: 'task-presentations', tasks: [1, 200], statements: [one.statements.length, many.statements.length], appSelects: appSelects.length, bytes: Buffer.byteLength(JSON.stringify(many.result)), splitDatabases: true }))
    })

    await t.test('membership is held through the APP snapshot and a completed revocation denies the next batch', async () => {
      const issue = await makeTask(); await makeFactory(issue)
      let reached!: () => void, release!: () => void
      const entered = new Promise<void>(resolve => { reached = resolve })
      const resume = new Promise<void>(resolve => { release = resolve })
      pauseFactoryRead = async () => { reached(); await resume }
      const reading = batch([issue], shared, peer)
      const writer = await workspace.connect()
      let writing: Promise<unknown> | undefined
      try {
        await entered
        const pid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
        writing = writer.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [shared, peer])
        const deadline = Date.now() + 5000
        let waiting = false
        while (Date.now() < deadline) {
          waiting = (await workspace.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0]?.wait_event_type === 'Lock'
          if (waiting) break
          await delay(10)
        }
        assert.equal(waiting, true, 'real membership row lock prevents revocation between the state reads')
        release()
        assert.deepEqual((await reading).items[issue], expected())
        await writing
        await assert.rejects(batch([issue], shared, peer), { code: 'workspaceAccessDenied' })
      } finally {
        release(); pauseFactoryRead = undefined
        await reading; await writing; writer.release()
        await workspace.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2', [shared, peer])
      }
    })
  } finally {
    Client.prototype.query = originalQuery
    if (previousEnv.app === undefined) delete process.env.MIKKA_DATABASE_URL; else process.env.MIKKA_DATABASE_URL = previousEnv.app
    if (previousEnv.workspace === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousEnv.workspace
    await dropTestDatabase(admin, appName, application, applicationModule)
    await dropTestDatabase(admin, workspaceName, workspace, workspaceModule)
    await admin.end()
  }
})
