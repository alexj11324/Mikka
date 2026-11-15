import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import test, { mock } from 'node:test'
import { Pool } from 'pg'
import { disposableDatabase } from './helpers/e2e-target.mjs'
import { createTestDatabase, dropTestDatabase } from './support/drop-test-database'
import { orderMigrations } from '../scripts/migration-order.mjs'
import { applyMigration, planMigration } from '../scripts/migration-steps.mjs'
import { scopeMigrationBeforeCommit } from '../scripts/scope-migration-history.mjs'
import { backfillTaskWorkspaces } from '../scripts/task-workspace-backfill.mjs'

const url = process.env.E2E_DATABASE_URL
if (url && !disposableDatabase()) throw new Error('Workspace governance tests require a loopback *_e2e database')
if (process.env.REQUIRE_DB === '1' && !url) throw new Error('Workspace governance database tests cannot skip in required CI')

test('workspace ownership: real split-database migration, ACL, immutable provenance and membership races', { skip: !url, timeout: 240_000 }, async t => {
  let selectedWorkspace: string | undefined
  let requestBearer: string | undefined
  const framework = await import('next/headers')
  const requestContext = mock.module('next/headers', { namedExports: { ...framework,
    cookies: async () => ({ get: (name: string) => name === 'mikka-workspace' && selectedWorkspace ? { value: selectedWorkspace } : undefined }),
    headers: async () => new Headers(requestBearer ? { authorization: `Bearer ${requestBearer}` } : undefined),
  } })
  t.after(() => requestContext.restore())
  const localization = await import('next-intl/server')
  const localeContext = mock.module('next-intl/server', { namedExports: { ...localization, getLocale: async () => 'en' } })
  t.after(() => localeContext.restore())
  const admin = new Pool({ connectionString: url, max: 1 })
  const suffix = randomUUID().replaceAll('-', '')
  const appName = `governance_app_${suffix}_e2e`, workspaceName = `governance_ws_${suffix}_e2e`
  await createTestDatabase(admin, appName, 'template0')
  await createTestDatabase(admin, workspaceName, 'template0')
  const appUrl = new URL(url!), workspaceUrl = new URL(url!)
  appUrl.pathname = `/${appName}`; workspaceUrl.pathname = `/${workspaceName}`
  const app = new Pool({ connectionString: appUrl.toString(), max: 5 })
  const workspace = new Pool({ connectionString: workspaceUrl.toString(), max: 5 })
  const previous = { app: process.env.MIKKA_DATABASE_URL, workspace: process.env.DATABASE_URL }
  process.env.MIKKA_DATABASE_URL = appUrl.toString(); process.env.DATABASE_URL = workspaceUrl.toString()
  let moduleApp: Pool | undefined, moduleWorkspace: Pool | undefined
  try {
    const directory = new URL('../drizzle/', import.meta.url)
    const migrations = orderMigrations((await readdir(directory)).filter(file => file.endsWith('.sql')))
    const boundary = '20261109035000_task_workspace_ownership.sql'
    for (const pool of [app, workspace]) await pool.query('CREATE TABLE schema_migrations (name text PRIMARY KEY,"appliedAt" timestamptz NOT NULL DEFAULT now())')
    const migrate = async (names: string[]) => {
      for (const name of names) {
        const source = await readFile(new URL(name, directory), 'utf8')
        const plan = planMigration(name, source)
        const client = await (plan.target === 'DATABASE_URL' ? workspace : app).connect()
        try {
          const scope = scopeMigrationBeforeCommit(name, source)
          await applyMigration(client, name, scope === null ? plan : { ...plan, sql: scope })
          if (scope !== null) await client.query('COMMIT')
        } finally { client.release() }
      }
    }
    await migrate(migrations.filter(name => name < boundary))
    const owner = `owner-${suffix}`, member = `member-${suffix}`, stranger = `stranger-${suffix}`
    const alpha = randomUUID(), beta = randomUUID(), personal = randomUUID(), team = randomUUID()
    const bound = randomUUID(), conflict = randomUUID(), unresolved = randomUUID(), teamless = randomUUID()
    const malformed = randomUUID(), removed = randomUUID(), deletedWorkspace = randomUUID(), removedBot = randomUUID()
    const botA = randomUUID(), botB = randomUUID(), agent = randomUUID(), runA = randomUUID(), runConflict = randomUUID(), artifact = randomUUID()
    for (const id of [owner, member, stranger]) await app.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$1||\'@governance.example.invalid\',true,now(),now())', [id])
    for (const [id, kind] of [[alpha, 'team'], [beta, 'team'], [personal, 'personal']]) {
      await workspace.query('INSERT INTO mikka_workspaces(id,"userId",name,kind) VALUES($1,$2,\'Governance fixture\',$3)', [id, owner, kind])
      await workspace.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$2,\'admin\',\'active\')', [id, owner])
    }
    await workspace.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$2,\'member\',\'active\')', [alpha, member])
    await workspace.query('INSERT INTO mikka_teams(id,"workspaceId","userId",name,identifier) VALUES($1,$2,$3,\'Grouping\',\'GOV\')', [team, alpha, owner])
    for (const id of [bound, conflict, unresolved, malformed, removed]) await app.query('INSERT INTO issues(id,"userId",title,content,status,priority,scope) VALUES($1,$2,\'Personal title is not proof\',\'{"type":"doc"}\',\'todo\',\'normal\',\'workspace\')', [id, owner])
    for (const id of [bound, conflict, malformed]) await workspace.query('INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId") VALUES($1,$2,$3,$4)', [id, team, alpha, owner])
    await app.query('INSERT INTO agents(id,"userId",harness,name) VALUES($1,$2,\'codex\',\'Fixture\')', [agent, owner])
    for (const [id, tenant] of [[botA, alpha], [botB, beta], [removedBot, deletedWorkspace]]) await app.query('INSERT INTO bots(id,"ownerId","workspaceId",name) VALUES($1,$2,$3,\'Fixture\')', [id, owner, tenant])
    for (const [id, task, bot] of [[runA, bound, botA], [runConflict, conflict, botB]]) await app.query('INSERT INTO agent_runs(id,"userId","agentId","issueId","botId",status) VALUES($1,$2,$3,$4,$5,\'succeeded\')', [id, owner, agent, task, bot])
    await app.query('INSERT INTO agent_runs(id,"userId","agentId","issueId","botId",status,"agentDefinition") VALUES($1,$2,$3,$4,$5,\'succeeded\',$6)', [randomUUID(), owner, agent, malformed, botA, { executionIdentity: { workspaceId: 'not-a-uuid' } }])
    await app.query('INSERT INTO agent_runs(id,"userId","agentId","issueId","botId",status) VALUES($1,$2,$3,$4,$5,\'succeeded\')', [randomUUID(), owner, agent, removed, removedBot])
    await app.query('INSERT INTO artifacts(id,"userId","runId","issueId",kind,title) VALUES($1,$2,$3,$4,\'markdown\',\'Fixture\')', [artifact, owner, runA, bound])
    await app.query('INSERT INTO artifact_versions(id,"artifactId",version,"storageKey","inlineContent",sha256,size,"authorName") VALUES($1,$2,1,\'fixture\',\'tenant content\',\'fixture\',14,\'Fixture\')', [randomUUID(), artifact])
    const before = (await app.query('SELECT id,content,"scopeVersion" FROM issues WHERE id=$1', [bound])).rows[0]
    await migrate(migrations.filter(name => name >= boundary))
    const result = await backfillTaskWorkspaces(app, workspace)
    assert.equal(result.bound, 1); assert.equal(result.pending, 4)
    assert.equal(result.runsBound, 1); assert.equal(result.artifactsBound, 1)
    const after = (await app.query('SELECT id,content,"scopeVersion","workspaceId" FROM issues WHERE id=$1', [bound])).rows[0]
    assert.deepEqual({ id: after.id, content: after.content, scopeVersion: after.scopeVersion }, before, 'migration preserves UUID, mandatory number and publication generation')
    assert.equal(after.workspaceId, alpha)
    const repeat = await backfillTaskWorkspaces(app, workspace)
    assert.equal(repeat.bound, 0); assert.equal(repeat.runsBound, 0); assert.equal(repeat.artifactsBound, 0)
    assert.deepEqual((await app.query('SELECT reason FROM issue_workspace_repairs ORDER BY reason')).rows.map(row => row.reason), ['conflicting_evidence', 'conflicting_evidence', 'missing_evidence', 'missing_workspace'])

    const { db, pool } = await import('../lib/db'); moduleApp = pool
    const { workspacePool } = await import('../lib/workspace-db'); moduleWorkspace = workspacePool
    const { issueForUser } = await import('../lib/issue-access')
    const { activeTaskWorkspaces, withTaskWorkspace } = await import('../lib/task-workspace')
    const { tokenWorkspace } = await import('../lib/tokens/principal')
    const { readArtifact, readArtifactContent, listArtifacts, listRunArtifacts, createShare, sharedArtifact } = await import('../lib/artifacts/store')
    const { artifactOutsideToken, runOutsideToken } = await import('../lib/tokens/scope')
    const { actAs } = await import('../lib/acting-user')
    const { enterprisePrincipal } = await import('../lib/enterprise/principal')
    const { issueVisibility } = await import('../lib/issue-visibility')
    const { parseSearchParams, searchIssues } = await import('../lib/issue-search')
    const { documentLiveTargets, runLiveTargets } = await import('../lib/live/panels')
    const { factoryLiveTargets } = await import('../lib/live/factory')
    const { registeredTask } = await import('./helpers/registered-task')

    await t.test('the conversation directory uses authoritative split-workspace membership and the original PAT binding', async () => {
      const { conversationDirectory } = await import('../lib/conversation-directory')
      const ownRun = randomUUID()
      await app.query(`INSERT INTO agent_runs(id,"userId","workspaceId","agentId",title,"titleSource",status)
        VALUES ($1,$2,$3,$4,'Directory governance fixture','manual','succeeded')`, [ownRun, member, alpha, agent])
      const input = { search: 'Directory governance fixture' }
      const ids = async (reader: Parameters<typeof conversationDirectory>[1], workspaceId: string) =>
        (await conversationDirectory(app, reader, workspaceId, input)).items.map(row => row.id)
      assert.deepEqual(await ids({ id: member, [tokenWorkspace]: alpha }, alpha), [ownRun])
      assert.deepEqual(await ids({ id: member, [tokenWorkspace]: beta }, alpha), [])
      assert.deepEqual(await ids(owner, alpha), [], 'active workspace membership does not confer run ownership')
      await workspace.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"=$2`, [alpha, member])
      try {
        assert.deepEqual(await ids({ id: member, [tokenWorkspace]: alpha }, alpha), [])
      } finally {
        await workspace.query(`UPDATE mikka_workspace_members SET status='active' WHERE "workspaceId"=$1 AND "userId"=$2`, [alpha, member])
      }
    })
    await t.test('pending resources never inherit the creator personal workspace', async () => {
      for (const id of [conflict, unresolved, malformed, removed]) {
        assert.equal(await issueForUser(owner, id), null)
        assert.equal(await issueForUser({ id: owner, [tokenWorkspace]: personal }, id), null)
      }
      assert.equal(await runOutsideToken({ id: owner, [tokenWorkspace]: beta }, runConflict), true)
    })
    await registeredTask(app, owner, alpha, teamless, client =>
      client.query('INSERT INTO issues(id,"userId","workspaceId",title,content,status,priority,scope) VALUES($1,$2,$3,\'No Team required\',\'{"type":"doc"}\',\'todo\',\'normal\',\'personal\')', [teamless, owner, alpha]))
    const alternate = randomUUID()
    await registeredTask(app, owner, beta, alternate, client =>
      client.query('INSERT INTO issues(id,"userId","workspaceId",title,content,status,priority,scope) VALUES($1,$2,$3,\'No Team required elsewhere\',\'{"type":"doc"}\',\'todo\',\'normal\',\'personal\')', [alternate, owner, beta]))
    await t.test('members can read a tenant task without a Team; selected/PAT tenant has no owner bypass', async () => {
      assert.equal((await issueForUser(member, teamless))?.id, teamless)
      assert.equal(await issueForUser(stranger, teamless), null)
      assert.equal(await issueForUser({ id: owner, [tokenWorkspace]: beta }, teamless), null)
      assert.equal((await issueForUser({ id: owner, [tokenWorkspace]: alpha }, teamless))?.id, teamless)
      await assert.rejects(withTaskWorkspace({ id: owner, [tokenWorkspace]: alpha }, beta, async () => assert.fail('wrong tenant write')), /workspaceAccessDenied/)
    })
    await t.test('direct task-only citations preserve the reader workspace pin without a run lookup', async () => {
      const { citationSources } = await import('../lib/coordinator/store')
      // The owner belongs to both tenants; only the complete reader carries
      // the selected tenant. Empty run IDs exercise the direct-task prefetch.
      const citations = [`[[issue:${teamless}]]`]
      const denied = await citationSources({ id: owner, [tokenWorkspace]: beta }, citations, [])
      assert.deepEqual(denied, {}, 'a beta-pinned owner must not learn an alpha task through citation prefetch')
      const allowed = await citationSources({ id: owner, [tokenWorkspace]: alpha }, citations, [])
      assert.deepEqual(Object.keys(allowed), [teamless])
      const task = allowed[teamless]
      assert.ok(task?.kind === 'issue')
      assert.equal(task.id, teamless)
      assert.equal(task.title, 'No Team required')
    })
    await t.test('lists, search and push targets use the tenant even for one account in both workspaces', async () => {
      const { issues: table } = await import('../lib/db/schema')
      const reader = { id: owner, [tokenWorkspace]: alpha }
      const listed = await db.select({ id: table.id }).from(table).where((await issueVisibility(reader)).predicate)
      assert.deepEqual(new Set(listed.map(row => row.id)), new Set([bound, teamless]))
      const searched = await actAs(reader, () => searchIssues(db, { userId: owner, workspaceId: alpha,
        params: parseSearchParams(new URLSearchParams({ q: 'No Team required' })),
      }))
      assert.deepEqual(searched.items.map(row => row.id), [teamless])
      const outside = await actAs(reader, () => searchIssues(db, { userId: owner, workspaceId: beta,
        params: parseSearchParams(new URLSearchParams({ q: 'No Team required' })),
      }))
      assert.deepEqual(outside.items, [])
      const targets = await documentLiveTargets(app, workspace, teamless)
      assert.deepEqual(new Set(targets.map(target => JSON.stringify(target.scope))), new Set([
        JSON.stringify({ ownerId: owner, workspaceId: alpha }), JSON.stringify({ ownerId: member, workspaceId: alpha }),
      ]))
      assert.deepEqual(await documentLiveTargets(app, workspace, unresolved), [])
      assert.ok((await runLiveTargets(app, workspace, runA, 'run')).every(target => target.scope.workspaceId === alpha))
    })
    await t.test('real Factory storage honors browser selection and token pin; denied routing creates no rows or events', async () => {
      const { createFactoryStore } = await import('../lib/factory/store')
      const { factoryAuthorize } = await import('../lib/factory/runtime')
      const store = createFactoryStore(pool, factoryAuthorize, botA)
      const sourceEventId = randomUUID()
      await app.query('INSERT INTO coordinator_events(id,"userId","botId",kind,"dedupeKey",payload) VALUES($1,$2,$3,\'user_message\',$4,\'{"text":"Isolated task request"}\')', [sourceEventId, owner, botA, sourceEventId])
      const session = { id: owner, [enterprisePrincipal]: { kind: 'session' as const, sessionId: `fixture-${suffix}` } }
      const route = { issueId: teamless, sourceEventId, eventId: randomUUID(), rationale: 'Explicit workspace fixture', missingInformation: [], missingPermissions: [], needsSpec: false }
      selectedWorkspace = alpha
      const created = await actAs(session, () => store.route(owner, route))
      assert.equal(created.task.workspaceId, alpha)
      assert.equal((await actAs(session, () => store.listForIssue(owner, teamless))).tasks[0].id, created.task.id)
      const counts = async () => (await app.query('SELECT (SELECT count(*) FROM factory_tasks) AS tasks,(SELECT count(*) FROM factory_events) AS events,(SELECT count(*) FROM issues) AS issues')).rows[0]
      const before = await counts()
      selectedWorkspace = beta
      await assert.rejects(actAs(session, () => store.read(owner, created.task.id)), /factoryNotFound/)
      await assert.rejects(actAs(session, () => store.listForIssue(owner, teamless)), /factoryNotFound/)
      await assert.rejects(actAs(session, () => store.route(owner, { ...route, eventId: randomUUID() })), /factoryNotFound/)
      selectedWorkspace = alpha
      await assert.rejects(actAs({ id: owner, [tokenWorkspace]: beta }, () => store.read(owner, created.task.id)), /factoryNotFound/)
      assert.deepEqual(await counts(), before)
      const targets = await factoryLiveTargets(app, workspace, created.task.id, owner)
      assert.equal(targets.length, 1)
      assert.deepEqual(targets[0].scope, { ownerId: owner, workspaceId: alpha })
    })
    await t.test('tenant cannot be changed or cleared; run and artifact provenance must agree', async () => {
      for (const next of [beta, null]) await assert.rejects(app.query('UPDATE issues SET "workspaceId"=$2 WHERE id=$1', [teamless, next]), /taskWorkspaceTransferDenied/)
      await assert.rejects(app.query('INSERT INTO agent_runs(id,"userId","agentId","issueId","botId",status) VALUES($1,$2,$3,$4,$5,\'queued\')', [randomUUID(), owner, agent, teamless, botB]), /taskWorkspaceMismatch/)
      await assert.rejects(app.query('UPDATE agent_runs SET "workspaceId"=$2 WHERE id=$1', [runA, beta]), /taskWorkspaceTransferDenied/)
      await assert.rejects(app.query('UPDATE artifacts SET "workspaceId"=$2 WHERE id=$1', [artifact, beta]), /taskWorkspaceTransferDenied/)
      assert.equal(await artifactOutsideToken({ id: owner, [tokenWorkspace]: beta }, artifact), true)
      assert.equal(await readArtifact({ id: owner, [tokenWorkspace]: beta }, artifact), null)
      assert.equal((await readArtifactContent({ id: owner, [tokenWorkspace]: alpha }, artifact, 1))?.content, 'tenant content')
      const alphaReader = { id: owner, [tokenWorkspace]: alpha }, betaReader = { id: owner, [tokenWorkspace]: beta }
      const own = await listArtifacts(alphaReader)
      assert.deepEqual(own.map(row => row.id), [artifact])
      assert.match(own[0].issueKey ?? '', /^GOV-[1-9]\d*$/)
      assert.deepEqual(await listArtifacts(betaReader), [], 'the same owner cannot list Alpha artifacts through a Beta pin')
      assert.deepEqual((await listRunArtifacts(alphaReader, runA)).map(row => row.id), [artifact])
      assert.deepEqual(await listRunArtifacts(betaReader, runA), [])
      assert.deepEqual(await listArtifacts({ id: member, [tokenWorkspace]: alpha }), [], 'Workspace membership does not widen the artifact owner ACL')
    })
    await t.test('conversation envelopes use persisted mailbox tenancy; mismatched run or sender writes leave no message', async () => {
      const inbox = randomUUID(), sender = randomUUID(), outside = randomUUID(), otherOwner = randomUUID()
      for (const [id, userId, tenant] of [[inbox, owner, alpha], [sender, owner, alpha], [outside, owner, beta], [otherOwner, member, alpha]]) {
        await app.query('INSERT INTO session_mailboxes(id,"userId","workspaceId",kind,"sessionKey") VALUES($1,$2,$3,\'coordinator\',$4)', [id, userId, tenant, id])
      }
      const message = randomUUID()
      await app.query('INSERT INTO run_messages(id,"userId","mailboxId","senderMailboxId",text,origin) VALUES($1,$2,$3,$4,\'Isolated conversation envelope\',\'peer\')', [message, owner, inbox, sender])
      await app.query('UPDATE run_messages SET "acknowledgedAt"=now() WHERE id=$1', [message])
      for (const invalidSender of [outside, otherOwner]) {
        await assert.rejects(app.query('INSERT INTO run_messages(id,"userId","mailboxId","senderMailboxId",text) VALUES($1,$2,$3,$4,\'Denied\')', [randomUUID(), owner, inbox, invalidSender]), /taskWorkspaceMismatch/)
      }
      await assert.rejects(app.query('INSERT INTO run_messages(id,"userId","mailboxId","runId",text) VALUES($1,$2,$3,$4,\'Denied\')', [randomUUID(), owner, outside, runA]), /taskWorkspaceMismatch/)
      await assert.rejects(app.query('INSERT INTO run_messages(id,"userId","runId",text) VALUES($1,$2,$3,\'Denied\')', [randomUUID(), owner, runConflict]), /taskWorkspaceUnresolved/)
      assert.equal((await app.query('SELECT count(*)::int AS total FROM run_messages')).rows[0].total, 1)
    })
    await t.test('legacy and task-free leases require current persisted tenant membership with no creator bypass', async () => {
      const { renewRunLeases } = await import('../lib/run-leases')
      const memberDevice = randomUUID(), memberAgent = randomUUID(), ownerDevice = randomUUID()
      const memberRun = randomUUID(), taskFreeRun = randomUUID(), creatorRun = randomUUID(), otherTenantRun = randomUUID(), unresolvedRun = randomUUID()
      for (const [id, userId] of [[memberDevice, member], [ownerDevice, owner]]) {
        await app.query('INSERT INTO devices(id,"ownerId",name) VALUES($1,$2,\'Legacy tenant lease fixture\')', [id, userId])
      }
      await app.query('INSERT INTO agents(id,"userId","deviceId",harness,name) VALUES($1,$2,$3,\'codex\',\'Legacy tenant fixture\')', [memberAgent, member, memberDevice])
      for (const [id, userId, deviceId, agentId, issueId, tenant] of [
        [memberRun, member, memberDevice, memberAgent, teamless, alpha],
        [taskFreeRun, member, memberDevice, memberAgent, null, alpha],
        [unresolvedRun, member, memberDevice, memberAgent, null, null],
        [creatorRun, owner, ownerDevice, agent, teamless, alpha],
        [otherTenantRun, owner, ownerDevice, agent, alternate, beta],
      ]) {
        await app.query('INSERT INTO agent_runs(id,"userId","deviceId","agentId","issueId","workspaceId",status,"leaseExpiresAt") VALUES($1,$2,$3,$4,$5,$6,\'running\',now()+interval \'5 minutes\')', [id, userId, deviceId, agentId, issueId, tenant])
      }
      const first = await renewRunLeases(memberDevice, [memberRun, taskFreeRun, unresolvedRun])
      assert.deepEqual(new Set(Object.keys(first.leases)), new Set([memberRun, taskFreeRun]))
      assert.deepEqual(first.revoked, [unresolvedRun], 'unproved historical ownership cannot borrow an active personal tenant')
      await workspace.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [alpha, member])
      const stoppedAt = new Date()
      const revoked = await renewRunLeases(memberDevice, [memberRun, taskFreeRun], stoppedAt)
      assert.deepEqual(revoked, { leases: {}, revoked: [memberRun, taskFreeRun] })
      const stopped = (await app.query('SELECT "stopRequestedAt","leaseExpiresAt","agentDefinition" FROM agent_runs WHERE id=ANY($1::uuid[])', [[memberRun, taskFreeRun]])).rows
      assert.ok(stopped.every(row => row.agentDefinition === null && row.stopRequestedAt && row.leaseExpiresAt.getTime() === stoppedAt.getTime()))
      await workspace.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2', [alpha, member])
      assert.deepEqual((await renewRunLeases(memberDevice, [memberRun, taskFreeRun])).leases, {}, 'restoring membership cannot resume a stopped run implicitly')
      await workspace.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [alpha, owner])
      const ownerBeat = await renewRunLeases(ownerDevice, [creatorRun, otherTenantRun])
      assert.deepEqual(ownerBeat.revoked, [creatorRun])
      assert.deepEqual(Object.keys(ownerBeat.leases), [otherTenantRun], 'the same account retains its independent authorized tenant')
      await workspace.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2', [alpha, owner])
    })
    await t.test('membership is pinned until the app commit and the next read observes suspension', async () => {
      let entered!: () => void, release!: () => void
      const ready = new Promise<void>(resolve => { entered = resolve })
      const finish = new Promise<void>(resolve => { release = resolve })
      const writing = withTaskWorkspace(member, alpha, () => db.transaction(async tx => {
        const { sql } = await import('drizzle-orm')
        await tx.execute(sql`SELECT id FROM issues WHERE id=${teamless} FOR UPDATE`)
        entered(); await finish
      }))
      await ready
      const updater = await workspace.connect()
      let suspension: Promise<unknown> | undefined
      try {
        const pid = (await updater.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
        suspension = updater.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [alpha, member])
        let blocked = false
        for (let i = 0; i < 100 && !blocked; i++) {
          blocked = (await workspace.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0]?.wait_event_type === 'Lock'
          if (!blocked) await new Promise(resolve => setTimeout(resolve, 10))
        }
        assert.equal(blocked, true, 'suspension waits for the authorized app write to commit')
      } finally { release(); await writing; await suspension; updater.release() }
      assert.deepEqual(await activeTaskWorkspaces(member, alpha), [])
      assert.equal(await issueForUser(member, teamless), null)
      assert.equal((await documentLiveTargets(app, workspace, teamless)).some(target => target.scope.ownerId === member), false)
    })
    await t.test('suspending an artifact issuer closes shared links but leaves other workspace access intact', async () => {
      const link = await createShare(owner, artifact)
      assert.ok(link); assert.ok(await sharedArtifact(link.token))
      await workspace.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [alpha, owner])
      assert.equal(await readArtifact(owner, artifact), null)
      assert.deepEqual(await listArtifacts({ id: owner, [tokenWorkspace]: alpha }), [], 'a later list rechecks membership instead of retaining an earlier proof')
      assert.deepEqual(await listRunArtifacts({ id: owner, [tokenWorkspace]: alpha }, runA), [])
      assert.equal(await sharedArtifact(link.token), null)
      assert.equal((await activeTaskWorkspaces(owner, beta))[0]?.id, beta)
      assert.equal((await activeTaskWorkspaces(owner, personal))[0]?.id, personal)
    })
    await t.test('task-run aggregates exclude an interrupted migration\'s unbound run until its own tenant is proved', async () => {
      // Reuse the real pre-migration conflict row. Removing its contradictory
      // grouping leaves one durable Bot proof; only the ordinary migration
      // may bind the task. Simulate interruption after that commit, before
      // derived resources: do not disable a trigger or invent a second reader.
      assert.equal((await app.query('SELECT "workspaceId" FROM agent_runs WHERE id=$1', [runConflict])).rows[0].workspaceId, null)
      await workspace.query('DELETE FROM mikka_team_issues WHERE "issueId"=$1', [conflict])
      let interrupted = 0
      const interruptedApplication = new Proxy(app, {
        get(target, property, receiver) {
          if (property === 'query') return (statement: unknown, ...parameters: unknown[]) => {
            if (typeof statement === 'string' && statement.startsWith('SELECT id FROM agent_runs WHERE "workspaceId" IS NULL')) {
              interrupted++
              throw new Error('fixture backfill interrupted before derived resources')
            }
            return Reflect.apply(target.query, target, [statement, ...parameters])
          }
          const value = Reflect.get(target, property, receiver)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      await assert.rejects(backfillTaskWorkspaces(interruptedApplication, workspace), { message: 'fixture backfill interrupted before derived resources' })
      assert.equal(interrupted, 1)
      assert.equal((await app.query('SELECT "workspaceId" FROM issues WHERE id=$1', [conflict])).rows[0].workspaceId, beta,
        'the real task phase committed its unique verified tenant before the interruption')
      assert.equal((await app.query('SELECT "workspaceId" FROM agent_runs WHERE id=$1', [runConflict])).rows[0].workspaceId, null,
        'the older run still has no independent persisted tenant proof')

      const visibleAgent = randomUUID(), visibleRun = randomUUID(), day = 24 * 60 * 60 * 1000, now = Date.now()
      const legacyAt = new Date(now - 29 * day), visibleAt = new Date(now - 7 * day)
      await app.query('UPDATE agent_runs SET "createdAt"=$2 WHERE id=$1', [runConflict, legacyAt])
      await app.query('INSERT INTO agents(id,"userId",harness,name) VALUES($1,$2,\'claude_code\',\'Tenant aggregate fixture\')', [visibleAgent, owner])
      await app.query('INSERT INTO agent_runs(id,"userId","agentId","issueId",status,"createdAt") VALUES($1,$2,$3,$4,\'succeeded\',$5)', [visibleRun, owner, visibleAgent, conflict, visibleAt])
      assert.equal((await app.query('SELECT "workspaceId" FROM agent_runs WHERE id=$1', [visibleRun])).rows[0].workspaceId, beta,
        'the normal run trigger binds the new row to its already-bound task')

      const { auth } = await import('../lib/auth')
      const authContext = await auth.$context
      const session = await authContext.internalAdapter.createSession(owner)
      assert.ok(session)
      const previousWorkspace = selectedWorkspace, previousBearer = requestBearer
      selectedWorkspace = beta; requestBearer = session.token
      try {
        const { pollTaskRuns } = await import('../app/actions/task-runs')
        const pending = await pollTaskRuns()
        const row = pending.items.find(item => item.issueId === conflict)
        assert.equal(row?.runId, visibleRun)
        assert.deepEqual(row?.harnesses, ['claude_code'], 'an unbound historical harness must not join the selected tenant list')
        assert.equal(pending.live.workspaceId, beta)
        assert.equal(pending.live.deadline?.at, new Date(visibleAt.getTime() + 30 * day).toISOString(),
          'the selected tenant expiry must not use an unbound run\'s earlier timestamp')
        assert.equal((await app.query('SELECT "workspaceId" FROM agent_runs WHERE id=$1', [runConflict])).rows[0].workspaceId, null,
          'a read cannot silently assign the quarantined run')

        const resumed = await backfillTaskWorkspaces(app, workspace)
        assert.equal(resumed.runsBound, 1)
        assert.equal((await app.query('SELECT "workspaceId" FROM agent_runs WHERE id=$1', [runConflict])).rows[0].workspaceId, beta)
        const resolved = await pollTaskRuns()
        assert.deepEqual(resolved.items.find(item => item.issueId === conflict)?.harnesses, ['claude_code', 'codex'],
          'the same historical row contributes only after its own migration commits')
        assert.equal(resolved.live.deadline?.at, new Date(legacyAt.getTime() + 30 * day).toISOString())
      } finally {
        selectedWorkspace = previousWorkspace; requestBearer = previousBearer
        await authContext.internalAdapter.deleteSession(session.token)
      }
    })
    const migrationFrom = randomUUID(), migrationTo = randomUUID(), fromTeam = randomUUID(), toTeam = randomUUID()
    const fromBot = randomUUID(), toBot = randomUUID()
    for (const [tenant, group, bot] of [[migrationFrom, fromTeam, fromBot], [migrationTo, toTeam, toBot]]) {
      await workspace.query('INSERT INTO mikka_workspaces(id,"userId",name,kind) VALUES($1,$2,\'Migration lock fixture\',\'team\')', [tenant, owner])
      await workspace.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$2,\'admin\',\'active\')', [tenant, owner])
      await workspace.query('INSERT INTO mikka_teams(id,"workspaceId","userId",name,identifier) VALUES($1,$2,$3,\'Migration source\',\'LOCK\')', [group, tenant, owner])
      await app.query('INSERT INTO bots(id,"ownerId","workspaceId",name) VALUES($1,$2,$3,\'Migration source\')', [bot, owner, tenant])
    }
    const waitForMigrationLock = async (database: Pool, blockingPid: number, query: string) => {
      for (let attempt = 0; attempt < 500; attempt++) {
        const { rows: [state] } = await database.query(`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'
          AND $1::int=ANY(pg_blocking_pids(pid)) AND query LIKE $2
        ) AS waiting`, [blockingPid, query])
        if (state.waiting) return
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      assert.fail('migration did not reach the expected PostgreSQL row lock')
    }
    await t.test('migration locks workspace before relations and APP rows; changed task evidence stays unresolved until a fresh pass', async () => {
      const task = randomUUID()
      await app.query('INSERT INTO issues(id,"userId",title,content,status,priority,scope) VALUES($1,$2,\'Unresolved legacy task\',\'{"type":"doc"}\',\'todo\',\'normal\',\'personal\')', [task, owner])
      await workspace.query('INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId") VALUES($1,$2,$3,$4)', [task, fromTeam, migrationFrom, owner])
      const original = (await app.query('SELECT content,"scopeVersion" FROM issues WHERE id=$1', [task])).rows[0]
      const tenantWriter = await workspace.connect(), appWriter = await app.connect()
      let migrating: ReturnType<typeof backfillTaskWorkspaces> | undefined
      try {
        await tenantWriter.query('BEGIN')
        await tenantWriter.query('SELECT id FROM mikka_workspaces WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [[migrationFrom, migrationTo]])
        const { rows: [{ pid }] } = await tenantWriter.query('SELECT pg_backend_pid() AS pid')
        migrating = backfillTaskWorkspaces(app, workspace)
        void migrating.catch(() => {})
        await waitForMigrationLock(workspace, pid, '%mikka_workspaces%FOR SHARE%')
        const { rows: [{ acquired }] } = await tenantWriter.query("SELECT pg_try_advisory_xact_lock(hashtextextended('mikka-team-relations',0)) AS acquired")
        assert.equal(acquired, true, 'migration cannot hold the relation advisory while waiting for workspace authority')
        await appWriter.query('BEGIN')
        await appWriter.query("SET LOCAL lock_timeout='1s'")
        await appWriter.query('SELECT id FROM issues WHERE id=$1 FOR UPDATE', [task])
        await appWriter.query('UPDATE issues SET title=\'Normal workspace writer committed\' WHERE id=$1', [task])
        await appWriter.query('COMMIT')
        await tenantWriter.query('UPDATE mikka_team_issues SET "workspaceId"=$2,"teamId"=$3 WHERE "issueId"=$1', [task, migrationTo, toTeam])
        await tenantWriter.query('COMMIT')
        const report = await migrating
        assert.equal((await app.query('SELECT "workspaceId" FROM issues WHERE id=$1', [task])).rows[0].workspaceId, null,
          'a source discovered under different workspace authority cannot bind in this pass')
        assert.equal((await app.query('SELECT reason FROM issue_workspace_repairs WHERE "issueId"=$1', [task])).rows[0]?.reason, 'conflicting_evidence',
          'a first-pass race is included in the actionable pending list immediately')
        assert.equal(report.pending, (await app.query('SELECT count(*)::int AS total FROM issues WHERE "workspaceId" IS NULL')).rows[0].total)
      } finally {
        await appWriter.query('ROLLBACK'); await tenantWriter.query('ROLLBACK')
        appWriter.release(); tenantWriter.release()
        await migrating?.catch(() => {})
      }
      const resumed = await backfillTaskWorkspaces(app, workspace)
      assert.equal(resumed.bound, 1)
      const current = (await app.query('SELECT title,content,"scopeVersion","workspaceId","ownershipState" FROM issues WHERE id=$1', [task])).rows[0]
      assert.equal(current.workspaceId, migrationTo); assert.equal(current.ownershipState, 'bound')
      assert.equal(current.title, 'Normal workspace writer committed')
      assert.deepEqual({ content: current.content, scopeVersion: current.scopeVersion }, original)
      assert.equal((await app.query('SELECT count(*)::int AS total FROM issue_workspace_repairs WHERE "issueId"=$1', [task])).rows[0].total, 0)
      assert.equal((await backfillTaskWorkspaces(app, workspace)).bound, 0, 'a completed migration is repeatable and does not move bound tasks')
    })
    await t.test('derived migration holds no APP row while waiting for workspace; changed computer authority is retried safely', async () => {
      const run = randomUUID()
      // A quarantined task-free legacy run is legal. The durable computer
      // binding supplies its tenant; no trigger is disabled to construct it.
      await app.query('INSERT INTO agent_runs(id,"userId","agentId",status) VALUES($1,$2,$3,\'succeeded\')', [run, owner, agent])
      await app.query('INSERT INTO computer_run_bindings("runId","botId","workspaceId","ownerId") VALUES($1,$2,$3,$4)', [run, fromBot, migrationFrom, owner])
      const tenantWriter = await workspace.connect(), appWriter = await app.connect()
      let migrating: ReturnType<typeof backfillTaskWorkspaces> | undefined
      try {
        await tenantWriter.query('BEGIN')
        await tenantWriter.query('SELECT id FROM mikka_workspaces WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [[migrationFrom, migrationTo]])
        const { rows: [{ pid }] } = await tenantWriter.query('SELECT pg_backend_pid() AS pid')
        migrating = backfillTaskWorkspaces(app, workspace)
        void migrating.catch(() => {})
        await waitForMigrationLock(workspace, pid, '%mikka_workspaces%FOR SHARE%')
        await appWriter.query('BEGIN')
        await appWriter.query("SET LOCAL lock_timeout='1s'")
        await appWriter.query('SELECT id FROM agent_runs WHERE id=$1 FOR UPDATE', [run])
        await appWriter.query('UPDATE agent_runs SET prompt=\'Normal resource writer committed\' WHERE id=$1', [run])
        await appWriter.query('UPDATE computer_run_bindings SET "workspaceId"=$2,"botId"=$3 WHERE "runId"=$1', [run, migrationTo, toBot])
        await appWriter.query('COMMIT')
        await tenantWriter.query('COMMIT')
        await migrating
        assert.equal((await app.query('SELECT "workspaceId" FROM agent_runs WHERE id=$1', [run])).rows[0].workspaceId, null,
          'a changed resource proof cannot borrow a workspace lock from its discovery snapshot')
      } finally {
        await appWriter.query('ROLLBACK'); await tenantWriter.query('ROLLBACK')
        appWriter.release(); tenantWriter.release()
        await migrating?.catch(() => {})
      }
      assert.equal((await backfillTaskWorkspaces(app, workspace)).runsBound, 1)
      const current = (await app.query('SELECT "workspaceId",prompt FROM agent_runs WHERE id=$1', [run])).rows[0]
      assert.deepEqual(current, { workspaceId: migrationTo, prompt: 'Normal resource writer committed' })
      assert.equal((await backfillTaskWorkspaces(app, workspace)).runsBound, 0, 'a completed resource migration is repeatable')
    })
    await t.test('derived evidence is read from a fresh statement after waiting for the APP row lock', async () => {
      const run = randomUUID()
      await app.query('INSERT INTO agent_runs(id,"userId","agentId",status) VALUES($1,$2,$3,\'succeeded\')', [run, owner, agent])
      await app.query('INSERT INTO computer_run_bindings("runId","botId","workspaceId","ownerId") VALUES($1,$2,$3,$4)', [run, fromBot, migrationFrom, owner])
      const tenantWriter = await workspace.connect(), appWriter = await app.connect()
      let migrating: ReturnType<typeof backfillTaskWorkspaces> | undefined
      try {
        // Match a normal writer's WS -> APP order. Shared workspace locks
        // allow the migration to discover the old proof and reach the APP wait.
        await tenantWriter.query('BEGIN')
        await tenantWriter.query('SELECT id FROM mikka_workspaces WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE', [[migrationFrom, migrationTo]])
        await appWriter.query('BEGIN')
        await appWriter.query('SELECT id FROM agent_runs WHERE id=$1 FOR UPDATE', [run])
        const { rows: [{ pid }] } = await appWriter.query('SELECT pg_backend_pid() AS pid')
        migrating = backfillTaskWorkspaces(app, workspace)
        void migrating.catch(() => {})
        await waitForMigrationLock(app, pid, '%agent_runs%FOR UPDATE%')
        // Do not update the run: otherwise PostgreSQL may refresh the joined
        // projection through EvalPlanQual and hide the stale-statement bug.
        await appWriter.query('UPDATE computer_run_bindings SET "workspaceId"=$2,"botId"=$3 WHERE "runId"=$1', [run, migrationTo, toBot])
        await appWriter.query('COMMIT'); await tenantWriter.query('COMMIT')
        await migrating
        assert.equal((await app.query('SELECT "workspaceId" FROM agent_runs WHERE id=$1', [run])).rows[0].workspaceId, null,
          'a changed joined source cannot bind using a snapshot taken before the APP lock wait')
      } finally {
        await appWriter.query('ROLLBACK'); await tenantWriter.query('ROLLBACK')
        appWriter.release(); tenantWriter.release()
        await migrating?.catch(() => {})
      }
      assert.equal((await backfillTaskWorkspaces(app, workspace)).runsBound, 1)
      assert.equal((await app.query('SELECT "workspaceId" FROM agent_runs WHERE id=$1', [run])).rows[0].workspaceId, migrationTo)
      assert.equal((await backfillTaskWorkspaces(app, workspace)).runsBound, 0)
    })
  } finally {
    await Promise.all([moduleApp?.end(), moduleWorkspace?.end()])
    await dropTestDatabase(admin, appName, app)
    await dropTestDatabase(admin, workspaceName, workspace)
    await admin.end()
    if (previous.app === undefined) delete process.env.MIKKA_DATABASE_URL; else process.env.MIKKA_DATABASE_URL = previous.app
    if (previous.workspace === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous.workspace
  }
})
