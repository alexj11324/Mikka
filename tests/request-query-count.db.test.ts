import { seedFixtureWorkspace } from './helpers/task-workspace'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import pg from 'pg'
import { disposableDatabase } from './helpers/e2e-target.mjs'

// Only a disposable loopback *_e2e database is admissible; required in CI.
const enabled = disposableDatabase()
if (process.env.REQUIRE_DB === '1' && !enabled) throw new Error('Request query count test requires a loopback *_e2e database')

// Every statement either pool sends during one request (#1423 follow-up: Neon bytes were per-query overhead).
let statements: string[] | null = null
const query = pg.Client.prototype.query
pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) {
  const first = args[0] as string | { text?: string } | undefined
  statements?.push(typeof first === 'string' ? first : first?.text ?? '')
  return Reflect.apply(query, this, args)
} as typeof pg.Client.prototype.query
async function counted<T>(work: () => Promise<T>) {
  statements = []
  try { const value = await work(); return { value, queries: statements.length, bytes: Buffer.byteLength(JSON.stringify(value) ?? ''), queryShapes: statements.map(sql => ({ command: sql.trim().split(/\s+/, 1)[0], tables: [...sql.matchAll(/(?:from|join)\s+"?([a-z_]+)"?/gi)].map(match => match[1]) })) } }
  finally { statements = null }
}

test('the polled routes read with a fixed number of queries, whatever the number of bots, tasks or Profiles', { skip: !enabled, timeout: 180_000 }, async t => {
  const prior = process.env.MIKKA_BYOS_ENABLED
  process.env.MIKKA_BYOS_ENABLED = '1'
  const { pool } = await import('../lib/db')
  const { withActivitySession } = await import('./fixtures/activity-runtime.mjs')
  const { loadWorkspaceContext } = await import('../lib/workspace-access')
  const { pollBotChatSummaries } = await import('../app/actions/coordinator')
  const { pollIssues } = await import('../app/actions/issues')
  const { getModelOrder } = await import('../app/actions/model-order')
  const profilesRoute = await import('../app/api/factory/agent-profiles/route')
  const tasksRoute = await import('../app/api/factory/tasks/route')
  const { AgentProfileStore } = await import('../lib/factory/agent-profile-store')
  const owner = `query-count-${randomUUID()}`
  const as = <T>(work: () => Promise<T>) => withActivitySession(owner, work) as Promise<T>
  const json = async (response: Response) => { assert.equal(response.status, 200); return response.json() }
  try {
    await pool.query('insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,$1,$2,true,now(),now())', [owner, `${owner}@example.invalid`])
    const workspaceId = (await as(() => loadWorkspaceContext())).workspace.id
    const agent = randomUUID()
    await pool.query('insert into agents(id,"userId",name,harness) values($1,$2,$3,$4)', [agent, owner, 'Fixture agent', 'codex'])
    const bots: string[] = [], tasks: string[] = []
    // A bot whose last reply cites a thread (run) on a task and the task itself, as the bot list shows them.
    const addBot = async () => {
      const bot = randomUUID(), issue = randomUUID(), run = randomUUID(), index = bots.length
      bots.push(bot); tasks.push(issue)
      await pool.query('insert into bots(id,"ownerId","workspaceId",name) values($1,$2,$3,$4)', [bot, owner, workspaceId, `Bot ${index}`])
      await pool.query('insert into issues(id,"userId",title,content,status,priority,scope,"workspaceId","ownershipState") values($1,$2,$3,$4,$5,$6,$7,$8,\'bound\')', [issue, owner, `Task ${index}`, JSON.stringify({ type: 'doc', attrs: { mikka: { number: index + 1 } }, content: [] }), 'doing', 'normal', 'personal', workspaceId])
      await pool.query('insert into agent_runs(id,"userId","issueId","agentId",status,prompt,"promptTaskStart","promptTaskLength") values($1,$2,$3,$4,$5,$6,0,char_length($6))', [run, owner, issue, agent, 'succeeded', `Fix thing ${index}`])
      await pool.query('insert into coordinator_messages(id,"userId","botId",position,message) values($1,$2,$3,1,$4)', [randomUUID(), owner, bot, JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: `Started [[run:${run}]] for [[issue:${issue}]]` }] })])
    }
    for (let index = 0; index < 2; index++) await addBot()
    await as(() => pollBotChatSummaries())
    const twoBots = await counted(() => as(() => pollBotChatSummaries()))
    for (let index = 0; index < 6; index++) await addBot()
    const eightBots = await counted(() => as(() => pollBotChatSummaries()))
    assert.equal(Object.keys(eightBots.value.items).length, 8)
    for (const [index, bot] of bots.entries()) assert.match(eightBots.value.items[bot].line ?? '', new RegExp(`Fix thing ${index}.*Task ${index}`), 'each cited thread and task is named')
    assert.equal(eightBots.queries, twoBots.queries, 'summaries: the same queries for 2 and 8 bots')
    assert.ok(eightBots.queries <= 14, `summaries: ${eightBots.queries} queries`)

    // Two subscriptions, an API key and a computer: what 模型与订阅 and Agent Profiles read.
    const allowance = (provider: string) => JSON.stringify({ vendor: provider === 'claude' ? 'claude_code' : 'codex', source: 'official', status: 'ok', plan: null, observedAt: new Date().toISOString(), windows: [{ kind: 'five_hour', used: .2, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }] })
    for (const [provider, models] of [['claude', ['claude-opus-5-5', 'claude-haiku-5-5']], ['codex', ['gpt-6', 'gpt-6-luna']]] as const) {
      const connection = randomUUID()
      await pool.query(`INSERT INTO byos_connections (id,"ownerId","workspaceId",provider,state,epoch,"secretName","secretDigest","providerSubject","modelCatalog",quota) VALUES ($1,$2,$3,$4,'connected',1,$5,$6,'synthetic-subject',$7,$8)`,
        [connection, owner, workspaceId, provider, `synthetic-${connection}`, 'a'.repeat(64), JSON.stringify({ revision: '1', models }), allowance(provider)])
      for (const model of models) await pool.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") VALUES ($1,$2,$3,'catalogue',$4,1,$5,$6)`,
        [randomUUID(), owner, workspaceId, connection, provider === 'codex' ? 'codex_cpa' : 'claude_cpa', model])
    }
    await pool.query(`insert into model_api_keys (id,"ownerId",provider,protocol,ciphertext,iv,"keyVersion",last4,models) values ($1,$2,'deepseek','openai','c','i',1,'abcd','["deepseek-flash"]')`, [randomUUID(), owner])
    const device = randomUUID()
    await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,enabled,"lastSeenAt",harnesses,"deviceType") VALUES ($1,$2,'Laptop','local',true,now(),$3,'laptop')`,
      [device, owner, JSON.stringify([{ harness: 'claude_code', installed: true, subscriptionBroker: true, models: ['claude-opus-5-5'] }, { harness: 'codex', installed: true, subscriptionBroker: true, models: ['gpt-6'] }])])
    for (const harness of ['claude_code', 'codex']) await pool.query('INSERT INTO agents (id,"userId","deviceId",harness,name) VALUES ($1,$2,$3,$4,$5)', [randomUUID(), owner, device, harness, `${harness} on Laptop`])

    await as(() => getModelOrder(workspaceId))
    const order = await counted(() => as(() => getModelOrder(workspaceId)))
    assert.ok(!order.value.error && order.value.entries.length > 0, JSON.stringify(order.value).slice(0, 200))
    if (order.queries > 15) t.diagnostic(JSON.stringify({ read: 'model-order', queryShapes: order.queryShapes }))
    assert.ok(order.queries <= 15, `model-order: ${order.queries} queries`)

    const store = new AgentProfileStore(pool)
    const profiles = `http://localhost/api/factory/agent-profiles?workspaceId=${workspaceId}`
    const addProfile = (index: number) => store.create({ ownerId: owner, workspaceId }, { name: `Profile ${index}`, harness: index % 2 ? 'codex' : 'claude_code', model: { mode: 'inherit' }, instructions: 'Review carefully' })
    await addProfile(0)
    await as(async () => json(await profilesRoute.GET(new Request(profiles))))
    const oneProfile = await counted(() => as(async () => json(await profilesRoute.GET(new Request(profiles)))))
    for (let index = 1; index < 4; index++) await addProfile(index)
    const fourProfiles = await counted(() => as(async () => json(await profilesRoute.GET(new Request(profiles)))))
    assert.equal(fourProfiles.value.profiles.length, 4)
    assert.equal(Object.keys(fourProfiles.value.availability).length, 4)
    // Each Profile adds only its own dispatch plan (its Agent's models), not another candidate/policy/device read.
    assert.ok(fourProfiles.queries - oneProfile.queries <= 6, `agent-profiles: ${oneProfile.queries} queries for one Profile, ${fourProfiles.queries} for four`)
    if (fourProfiles.queries > 28) t.diagnostic(JSON.stringify({ read: 'agent-profiles', queryShapes: fourProfiles.queryShapes }))
    assert.ok(fourProfiles.queries <= 28, `agent-profiles: ${fourProfiles.queries} queries`)

    // Factory tasks of one task across three bots and the unscoped chat, each from its own chat's message.
    const issue = tasks[0]
    const listed: string[] = []
    const addTasks = async (bot: string | null, eventBot: string | null = bot) => {
      const source = randomUUID(), task = randomUUID(), attempt = randomUUID()
      await pool.query(`INSERT INTO coordinator_events (id,"userId","botId","issueId",kind,"dedupeKey",payload) VALUES ($1,$2,$3,$4,'user_message',$5,'{}')`, [source, owner, eventBot, issue, `count:${source}`])
      const tx = await pool.connect()
      try {
        await tx.query('BEGIN')
        await tx.query(`INSERT INTO factory_tasks (id,"userId","botId","issueId","sourceEventId",route,stage,status,"attemptId",reason) VALUES ($1,$2,$3,$4,$5,'{}','execute','running',$6,'Fixture')`, [task, owner, bot, issue, source, attempt])
        await tx.query(`INSERT INTO factory_attempts (id,"taskId",stage,ordinal,position,status,reason) VALUES ($1,$2,'execute',1,1,'running','Fixture')`, [attempt, task])
        await tx.query('COMMIT')
      } finally { tx.release() }
      if (bot === eventBot) listed.push(task)
    }
    await addTasks(bots[0]); await addTasks(null)
    const url = `http://localhost/api/factory/tasks?issueId=${issue}`
    await as(async () => json(await tasksRoute.GET(new Request(url))))
    const twoScopes = await counted(() => as(async () => json(await tasksRoute.GET(new Request(url)))))
    await addTasks(bots[1]); await addTasks(bots[2]); await addTasks(bots[2])
    // A task whose source message is in another bot's chat is not listed, as before.
    await addTasks(bots[1], bots[3])
    const fourScopes = await counted(() => as(async () => json(await tasksRoute.GET(new Request(url)))))
    assert.deepEqual(fourScopes.value.tasks.map((task: { id: string }) => task.id).sort(), [...listed].sort())
    assert.equal(fourScopes.value.liveWorkspaceId, workspaceId, 'the live channel matches the authorized list tenant')
    assert.equal(fourScopes.queries, twoScopes.queries, 'factory tasks: the same queries for 2 and 4 bot scopes')
    if (fourScopes.queries > 13) t.diagnostic(JSON.stringify({ read: 'factory-task-list', queryShapes: fourScopes.queryShapes }))
    assert.ok(fourScopes.queries <= 13, `factory tasks: ${fourScopes.queries} queries`)

    const originalContent = (await pool.query('SELECT content FROM issues WHERE id=$1', [issue])).rows[0].content
    try {
      const deletedContent = {
        ...originalContent,
        attrs: { ...originalContent.attrs, mikka: { ...originalContent.attrs.mikka, deletedAt: new Date().toISOString() } },
      }
      await pool.query('UPDATE issues SET content=$2 WHERE id=$1', [issue, JSON.stringify(deletedContent)])
      const denied = await as(() => tasksRoute.GET(new Request(url)))
      assert.equal(denied.status, 404, 'the authorization snapshot preserves the canonical tombstone')
      assert.deepEqual(await denied.json(), { error: 'factoryNotFound' })
    } finally { await pool.query('UPDATE issues SET content=$2 WHERE id=$1', [issue, JSON.stringify(originalContent)]) }

    await as(() => pollIssues())
    const issues = await counted(() => as(() => pollIssues()))
    assert.equal(issues.value.items?.length, tasks.length)
    assert.ok(issues.queries <= 10, `issues poll: ${issues.queries} queries`)
    t.diagnostic(JSON.stringify({
      summaries: { bots: 8, queries: eightBots.queries, bytes: eightBots.bytes },
      modelOrder: { queries: order.queries, bytes: order.bytes },
      agentProfiles: { profiles: 4, queries: fourProfiles.queries, bytes: fourProfiles.bytes },
      factoryTasks: { tasks: listed.length, queries: fourScopes.queries, bytes: fourScopes.bytes },
      issuesPoll: { queries: issues.queries, bytes: issues.bytes },
    }))
  } finally {
    if (prior === undefined) delete process.env.MIKKA_BYOS_ENABLED; else process.env.MIKKA_BYOS_ENABLED = prior
    for (const statement of [
      'delete from factory_attempts where "taskId" in (select id from factory_tasks where "userId"=$1)', 'delete from factory_events where "taskId" in (select id from factory_tasks where "userId"=$1)',
      'delete from factory_tasks where "userId"=$1', 'delete from factory_agent_profile_versions where "ownerId"=$1', 'delete from factory_agent_profiles where "ownerId"=$1',
      'delete from coordinator_events where "userId"=$1', 'delete from coordinator_messages where "userId"=$1', 'delete from agent_runs where "userId"=$1',
      'delete from agents where "userId"=$1', 'delete from devices where "ownerId"=$1', 'delete from byos_bindings where "ownerId"=$1', 'delete from byos_connections where "ownerId"=$1',
      'delete from model_api_keys where "ownerId"=$1', 'delete from bots where "ownerId"=$1', 'delete from issues where "userId"=$1',
    ]) await pool.query(statement, [owner]).catch(() => undefined)
  }
})

test('issuesForUser answers as issueForUser does for each task: personal, shared, revoked, deleted and token-pinned', { skip: !enabled, timeout: 60_000 }, async () => {
  const { pool } = await import('../lib/db')
  const { issueForUser } = await import('../lib/issue-access')
  const { issuesForUser } = await import('../lib/issues-for-user')
  const { tokenWorkspace } = await import('../lib/tokens/principal')
  const suffix = randomUUID()
  const owner = `batch-owner-${suffix}`, peer = `batch-peer-${suffix}`
  const shared = randomUUID(), revoked = randomUUID(), empty = randomUUID()
  const sharedTeam = randomUUID(), revokedTeam = randomUUID()
  const ids = { peerPersonal: randomUUID(), peerDeleted: randomUUID(), ownerPersonal: randomUUID(), teamTask: randomUUID(), revokedTask: randomUUID(), peerWorkspace: randomUUID() }
  try {
    for (const person of [owner, peer]) await pool.query('insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,$1,$2,true,now(),now())', [person, `${person}@example.invalid`])
    for (const [workspace, status] of [[shared, 'active'], [revoked, 'suspended'], [empty, 'active']]) {
      await pool.query('insert into mikka_workspaces(id,"userId",name) values($1,$2,$3)', [workspace, owner, 'Batch visibility'])
      await pool.query('insert into mikka_workspace_members("workspaceId","userId",name,email,role) values($1,$2,$2,$3,$4)', [workspace, owner, `${owner}@example.invalid`, 'admin'])
      await pool.query('insert into mikka_workspace_members("workspaceId","userId",name,email,role,status) values($1,$2,$2,$3,$4,$5)', [workspace, peer, `${peer}@example.invalid`, 'member', status])
    }
    await pool.query('insert into mikka_teams(id,"workspaceId","userId",name,identifier) values($1,$2,$3,$4,$5)', [sharedTeam, shared, owner, 'Shared', 'BSH'])
    await pool.query('insert into mikka_teams(id,"workspaceId","userId",name,identifier) values($1,$2,$3,$4,$5)', [revokedTeam, revoked, owner, 'Revoked', 'BRV'])
    const insert = async (id: string, userId: string, scope: string, deleted = false) => pool.query('insert into issues(id,"userId",title,content,status,priority,scope,"workspaceId","ownershipState") values($1,$2,$3,$4,$5,$6,$7,$8,\'bound\')',
      [id, userId, id, JSON.stringify({ type: 'doc', attrs: deleted ? { mikka: { deletedAt: new Date().toISOString() } } : {}, content: [] }), 'todo', 'normal', scope,
        scope === 'personal' ? await seedFixtureWorkspace(pool, userId) : id === ids.revokedTask ? revoked : shared])
    await insert(ids.peerPersonal, peer, 'personal'); await insert(ids.peerDeleted, peer, 'personal', true); await insert(ids.ownerPersonal, owner, 'personal')
    await insert(ids.teamTask, owner, 'workspace'); await insert(ids.revokedTask, owner, 'workspace'); await insert(ids.peerWorkspace, peer, 'workspace')
    await pool.query('insert into mikka_team_issues("issueId","teamId","workspaceId","userId") values($1,$2,$3,$4)', [ids.teamTask, sharedTeam, shared, owner])
    await pool.query('insert into mikka_team_issues("issueId","teamId","workspaceId","userId") values($1,$2,$3,$4)', [ids.revokedTask, revokedTeam, revoked, owner])
    // The peer's own workspace task, linked to the shared workspace: a token pinned elsewhere must not read it.
    await pool.query('insert into mikka_team_issues("issueId","teamId","workspaceId","userId") values($1,$2,$3,$4)', [ids.peerWorkspace, sharedTeam, shared, peer])
    const all = [...Object.values(ids), 'not-a-uuid']
    const readers = [peer, owner, { id: peer, [tokenWorkspace]: shared }, { id: peer, [tokenWorkspace]: empty }]
    for (const reader of readers) for (const includeDeleted of [false, true]) {
      const one: string[] = []
      for (const id of all) if (await issueForUser(reader, id, includeDeleted)) one.push(id)
      const many = await issuesForUser(reader, all, includeDeleted, undefined, { withoutBody: true })
      assert.deepEqual([...many.keys()].sort(), one.sort(), `${typeof reader === 'string' ? reader.split('-')[1] : `token:${reader[tokenWorkspace] === shared ? 'shared' : 'empty'}`} includeDeleted=${includeDeleted}`)
    }
    // The cases above are not all empty or all visible.
    assert.deepEqual([...(await issuesForUser(peer, all)).keys()].sort(), [ids.peerPersonal, ids.teamTask, ids.peerWorkspace].sort())
  } finally {
    await pool.query('delete from mikka_team_issues where "issueId"=any($1::uuid[])', [Object.values(ids)])
    await pool.query('delete from issues where id=any($1::uuid[])', [Object.values(ids)])
    await pool.query('delete from mikka_teams where id=any($1::uuid[])', [[sharedTeam, revokedTeam]])
    await pool.query('delete from mikka_workspace_members where "workspaceId"=any($1::uuid[])', [[shared, revoked, empty]])
    await pool.query('delete from mikka_workspaces where id=any($1::uuid[])', [[shared, revoked, empty]])
    await pool.query('delete from "user" where id=any($1::text[])', [[owner, peer]])
  }
})

test('readOnce shares an identical read within one operation, never a write, a lock or a read after a write', { skip: !enabled }, async () => {
  const { pool } = await import('../lib/db')
  const { readOnce } = await import('../lib/db/read-once')
  const reads = readOnce(pool)
  const marker = `read-once-${randomUUID()}`
  await pool.query('create temporary table if not exists read_once_probe (id text)')
  const run = await counted(async () => {
    const [a, b] = await Promise.all([reads.query('SELECT $1::text AS v', [marker]), reads.query('SELECT $1::text AS v', [marker])])
    a.rows[0].v = 'changed by a caller'
    const c = await reads.query('SELECT $1::text AS v', [marker])
    await reads.query('SELECT $1::text AS v FOR UPDATE', [marker]).catch(() => undefined)
    await reads.query('INSERT INTO read_once_probe VALUES ($1)', [marker]).catch(() => undefined)
    const d = await reads.query('SELECT $1::text AS v', [marker])
    return [b.rows[0].v, c.rows[0].v, d.rows[0].v]
  })
  assert.deepEqual(run.value, [marker, marker, marker], 'each caller gets its own copy')
  // One shared SELECT, the lock, the write, and the SELECT again after the write.
  assert.equal(run.queries, 4)
  const fresh = await counted(() => readOnce(pool).query('SELECT $1::text AS v', [marker]))
  assert.equal(fresh.queries, 1, 'a new operation reads again')
})

test('held Workspace membership remains exact and expires before detached reads can outlive its transaction', { skip: !enabled, timeout: 30_000 }, async () => {
  const { pool } = await import('../lib/db')
  const { activeTaskWorkspaces, withTaskWorkspace } = await import('../lib/task-workspace')
  const { tokenWorkspace } = await import('../lib/tokens/principal')
  const owner = `held-reader-${randomUUID()}`, peer = `held-peer-${randomUUID()}`
  const tenants: string[] = []
  const later = Promise.withResolvers<void>()
  let detached: Promise<Awaited<ReturnType<typeof activeTaskWorkspaces>>> | undefined
  try {
    for (const userId of [owner, peer]) await pool.query('insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,$1,$2,true,now(),now())', [userId, `${userId}@example.invalid`])
    const alpha = await seedFixtureWorkspace(pool, owner, 'team')
    const beta = await seedFixtureWorkspace(pool, owner, 'team')
    tenants.push(alpha, beta)
    const pinned = { id: owner, [tokenWorkspace]: alpha }
    await withTaskWorkspace(owner, alpha, async () => {
      assert.deepEqual(await activeTaskWorkspaces(pinned, alpha), [{ id: alpha, kind: 'team' }])
      assert.deepEqual(await activeTaskWorkspaces(pinned, beta), [], 'an explicit request cannot override the principal pin')
      assert.deepEqual(await activeTaskWorkspaces({ id: peer, [tokenWorkspace]: alpha }, alpha), [], 'a lease never supplies another person membership')
      assert.deepEqual((await activeTaskWorkspaces(owner)).map(row => row.id).sort(), [...tenants].sort(), 'an unscoped read still discovers all current memberships')
      assert.deepEqual(await activeTaskWorkspaces(owner, beta), [{ id: beta, kind: 'team' }], 'another explicit tenant gets its own real membership read')
      await pool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [beta, owner])
      assert.deepEqual(await activeTaskWorkspaces(owner, beta), [], 'the held Alpha lease cannot hide revocation in another tenant')
      // This continuation retains the real ALS context, but not its authority
      // after withTaskWorkspace has committed and invalidated the lease.
      detached = later.promise.then(() => activeTaskWorkspaces(pinned, alpha))
    })
    await pool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [alpha, owner])
    assert.ok(detached)
    later.resolve()
    assert.deepEqual(await detached, [], 'a detached read must observe revocation after the owner transaction ends')
    assert.deepEqual(await activeTaskWorkspaces(pinned, alpha), [])
  } finally {
    later.resolve()
    if (detached) await detached.catch(() => undefined)
    await pool.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=ANY($1::uuid[])', [tenants])
    await pool.query('DELETE FROM mikka_workspaces WHERE id=ANY($1::uuid[])', [tenants])
    await pool.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [[owner, peer]])
  }
})

test('workspace context combines fresh membership and Org linkage while rechecking policy, directory and session authority', { skip: !enabled, timeout: 30_000 }, async () => {
  const { pool } = await import('../lib/db')
  const { withActivitySession } = await import('./fixtures/activity-runtime.mjs')
  const { loadWorkspaceContext } = await import('../lib/workspace-access')
  const { enterprisePrincipal } = await import('../lib/enterprise/principal')
  const owner = 'context-policy-' + randomUUID(), organizationId = randomUUID(), sessionId = randomUUID()
  const providerId = 'context-provider-' + randomUUID(), connectionId = randomUUID(), directoryId = randomUUID()
  const hash = createHash('sha256').update(randomUUID()).digest('hex')
  const reader = { id: owner, name: 'Context policy fixture', email: owner + '@example.invalid',
    [enterprisePrincipal]: { kind: 'session' as const, sessionId } }
  const tenants: string[] = []
  try {
    await pool.query('insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,$2,$3,true,now(),now())', [owner, reader.name, reader.email])
    const personal = await seedFixtureWorkspace(pool, owner)
    const workspaceId = await seedFixtureWorkspace(pool, owner, 'team')
    tenants.push(personal, workspaceId)
    await pool.query('insert into session(id,token,"userId","expiresAt","createdAt","updatedAt") values($1,$2,$3,now()+interval \'1 hour\',now(),now())', [sessionId, randomUUID(), owner])
    await pool.query('insert into mikka_organizations(id,name,"createdBy") values($1,\'Context policy fixture\',$2)', [organizationId, owner])
    // Only the framework context is isolated. These are real persisted plain
    // sessions and directory/policy rows; no SSO assurance is synthesized.
    await withActivitySession(owner, async () => {
      const read = () => loadWorkspaceContext(workspaceId, reader)
      await read() // Warm the existing Personal sharing initialization.
      const unlinked = await counted(read)
      assert.equal(unlinked.queries, 1, 'one fresh membership read also proves the current absence of an Org link')
      assert.equal(unlinked.value.workspace.id, workspaceId)
      await pool.query('insert into mikka_organization_workspaces("workspaceId","organizationId") values($1,$2)', [workspaceId, organizationId])
      await pool.query('insert into enterprise_org_policy("organizationId","enforceSso","allowMachineCredentials") values($1,false,false)', [organizationId])
      const linked = await counted(read)
      assert.equal(linked.queries, 2, 'the freshly linked Org adds its canonical policy read, without a second linkage query')
      assert.equal('organizationId' in linked.value, false, 'internal linkage does not extend the public context contract')
      assert.ok(linked.value.choices.every(choice => Object.keys(choice).sort().join(',') === 'id,kind,name'))
      await pool.query('update enterprise_org_policy set "enforceSso"=true where "organizationId"=$1', [organizationId])
      await assert.rejects(read, { code: 'workspaceAccessDenied' }, 'an existing plain session does not acquire SSO assurance')
      await pool.query('update enterprise_org_policy set "enforceSso"=false,"archivedAt"=now() where "organizationId"=$1', [organizationId])
      await assert.rejects(read, { code: 'workspaceAccessDenied' }, 'Org archival affects the next read in the same framework session')
      await pool.query('update enterprise_org_policy set "archivedAt"=null where "organizationId"=$1', [organizationId])
      assert.equal((await read()).workspace.id, workspaceId)
      await pool.query('insert into enterprise_sso_provider(id,"providerId","organizationScopeId","userId",issuer,domain,"domainVerified","oidcConfig","domainTokenHash") values($1,$2,$3,$4,$5,$6,true,$7,$8)',
        [randomUUID(), providerId, organizationId, owner, 'https://context.example.invalid', providerId + '.example.invalid', '{}', hash])
      await pool.query('insert into enterprise_scim_connection(id,"organizationId","providerId","tokenHash") values($1,$2,$3,$4)', [connectionId, organizationId, providerId, hash])
      await pool.query('insert into enterprise_scim_user(id,"connectionId","organizationId","externalId","userName","userId",active,document) values($1,$2,$3,$4,$5,$4,true,$6)',
        [directoryId, connectionId, organizationId, owner, reader.email, {}])
      assert.equal((await read()).workspace.id, workspaceId)
      await pool.query('update enterprise_scim_user set active=false where id=$1', [directoryId])
      await assert.rejects(read, { code: 'workspaceAccessDenied' }, 'directory suspension wins before any downstream membership delivery')
      assert.equal((await loadWorkspaceContext(personal, reader)).workspace.id, personal)
      await pool.query('update enterprise_scim_user set active=true where id=$1', [directoryId])
      await pool.query('update enterprise_sso_provider set "domainVerified"=false where "providerId"=$1', [providerId])
      await assert.rejects(read, { code: 'workspaceAccessDenied' }, 'the linked provider is checked fresh even with enforced SSO disabled')
      await pool.query('delete from mikka_organization_workspaces where "workspaceId"=$1', [workspaceId])
      assert.equal((await read()).workspace.id, workspaceId, 'a detached tenant no longer inherits the former Org policy')
      await pool.query('update mikka_workspace_members set status=\'suspended\' where "workspaceId"=$1 and "userId"=$2', [workspaceId, owner])
      await assert.rejects(read, { code: 'workspaceAccessDenied' }, 'same-session membership revocation never falls back to Personal')
    }, workspaceId)
  } finally {
    await pool.query('delete from enterprise_scim_user where id=$1', [directoryId])
    await pool.query('delete from enterprise_scim_connection where id=$1', [connectionId])
    await pool.query('delete from enterprise_sso_provider where "providerId"=$1', [providerId])
    await pool.query('delete from enterprise_org_policy where "organizationId"=$1', [organizationId])
    await pool.query('delete from mikka_organization_workspaces where "organizationId"=$1', [organizationId])
    await pool.query('delete from mikka_organizations where id=$1', [organizationId])
    await pool.query('delete from session where id=$1', [sessionId])
    await pool.query('delete from mikka_workspace_members where "workspaceId"=any($1::uuid[])', [tenants])
    await pool.query('delete from mikka_workspaces where id=any($1::uuid[])', [tenants])
    await pool.query('delete from "user" where id=$1', [owner])
  }
})


test('held Task Workspace linkage follows real Org writers, nested rollback and current APP authority', { skip: !enabled, timeout: 90_000 }, async t => {
  const { setTimeout: delay } = await import('node:timers/promises')
  const { pool } = await import('../lib/db')
  const { workspaceDb, workspacePool } = await import('../lib/workspace-db')
  const { activeTaskWorkspaces, withTaskWorkspace } = await import('../lib/task-workspace')
  const { enterprisePrincipal } = await import('../lib/enterprise/principal')
  const org = await import('../lib/governance/organizations')
  const keys = ['MIKKA_EDITION', 'DEVICE_GATEWAY_URL', 'DEVICE_GATEWAY_PUSH_SECRET'] as const
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  process.env.MIKKA_EDITION = 'cloud'
  // Real canonical writes and APP tombstones run; there is no remote gateway in this PG fixture.
  delete process.env.DEVICE_GATEWAY_URL; delete process.env.DEVICE_GATEWAY_PUSH_SECRET
  const owner = { id: 'held-link-' + randomUUID(), name: 'Held linkage fixture', email: randomUUID() + '@example.invalid' }
  const plainSession = randomUUID(), assuredSession = randomUUID()
  const providerId = 'held-provider-' + randomUUID(), connectionId = randomUUID(), directoryId = randomUUID(), identityId = randomUUID()
  const hash = createHash('sha256').update(randomUUID()).digest('hex')
  const plain = { ...owner, [enterprisePrincipal]: { kind: 'session' as const, sessionId: plainSession } }
  const assured = { ...owner, [enterprisePrincipal]: { kind: 'session' as const, sessionId: assuredSession } }
  const tenants: string[] = []
  let organizationId: string | undefined
  async function bounded<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('held linkage fixture timed out')), 5_000) })]) }
    finally { clearTimeout(timer) }
  }
  try {
    await pool.query('insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,$2,$3,true,now(),now())', [owner.id, owner.name, owner.email])
    const workspaceId = await seedFixtureWorkspace(pool, owner.id, 'team')
    const racingWorkspace = await seedFixtureWorkspace(pool, owner.id, 'team')
    tenants.push(workspaceId, racingWorkspace)
    for (const id of [plainSession, assuredSession]) await pool.query('insert into session(id,token,"userId","expiresAt","createdAt","updatedAt") values($1,$2,$3,now()+interval \'1 hour\',now(),now())', [id, randomUUID(), owner.id])
    organizationId = (await org.createOrganization(owner, { name: 'Held linkage Org' })).id
    const orgId = organizationId
    await pool.query('update mikka_organization_entitlements set plan=\'enterprise\',source=\'cloud\',"seatLimit"=5 where "organizationId"=$1', [orgId])
    const policy = (enforceSso: boolean) => pool.query('insert into enterprise_org_policy("organizationId","enforceSso","allowMachineCredentials") values($1,$2,false) on conflict("organizationId") do update set "enforceSso"=excluded."enforceSso"', [orgId, enforceSso])
    const visible = (id: string) => [{ id, kind: 'team' }]
    const read = (id = workspaceId, reader = plain) => activeTaskWorkspaces(reader, id)
    await policy(true)

    await t.test('a same-transaction attach takes effect immediately and a rolled-back savepoint restores the actual link', async () => {
      await withTaskWorkspace(plain, workspaceId, async () => {
        assert.deepEqual(await read(), visible(workspaceId))
        const rollback = new Error('rollback only this fixture savepoint')
        await assert.rejects(() => withTaskWorkspace(plain, workspaceId, async () => {
          await org.attachOrganizationWorkspace(orgId, workspaceId, owner.id)
          assert.deepEqual(await read(), [], 'a same-transaction attach cannot retain an admitted no-Org result')
          throw rollback
        }), error => error === rollback)
        assert.deepEqual(await read(), visible(workspaceId), 'a rollback is read from canonical WS state, not the attempted Org link')
        await org.attachOrganizationWorkspace(orgId, workspaceId, owner.id)
        assert.deepEqual(await read(), [], 'the parent lease also observes the next successful writer')
      })
      assert.deepEqual(await read(), [], 'a new operation observes the committed binding')
    })

    await t.test('nested detach invalidates the parent and previously admitted sibling leases observe a later attach', async () => {
      await policy(false)
      await withTaskWorkspace(plain, workspaceId, async () => {
        assert.deepEqual(await read(), visible(workspaceId))
        await withTaskWorkspace(plain, workspaceId, async () => {
          await org.detachOrganizationWorkspace(orgId, workspaceId, owner.id)
          await policy(true)
          assert.deepEqual(await read(), visible(workspaceId), 'the former Org policy does not follow a detached workspace')
        })
        assert.deepEqual(await read(), visible(workspaceId), 'the parent cannot retain its pre-detach Org link')
      })

      await withTaskWorkspace(plain, workspaceId, async () => {
        const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
        const earlierSibling = withTaskWorkspace(plain, workspaceId, async () => {
          assert.deepEqual(await read(), visible(workspaceId))
          entered.resolve()
          await resume.promise
          assert.deepEqual(await read(), [], 'an already admitted sibling must observe the other sibling\'s committed savepoint')
        })
        void earlierSibling.catch(() => undefined)
        try {
          await bounded(entered.promise)
          await withTaskWorkspace(plain, workspaceId, async () => {
            await org.attachOrganizationWorkspace(orgId, workspaceId, owner.id)
            assert.deepEqual(await read(), [])
          })
          assert.deepEqual(await read(), [], 'the shared parent also observes its child\'s attach')
        } finally { resume.resolve(); await bounded(earlierSibling) }
      })
    })

    await t.test('an outer WS transaction propagates a direct writer to a sibling Task lease with no Task ancestor', async () => {
      await policy(false)
      await org.detachOrganizationWorkspace(orgId, workspaceId, owner.id)
      await policy(true)
      await workspaceDb.transaction(async () => {
        const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
        const reader = withTaskWorkspace(plain, workspaceId, async () => {
          assert.deepEqual(await read(), visible(workspaceId))
          entered.resolve()
          await resume.promise
          assert.deepEqual(await read(), [], 'a canonical sibling writer cannot bypass invalidation because it has no Task ALS context')
        })
        void reader.catch(() => undefined)
        try {
          await bounded(entered.promise)
          // This writer shares only the real WS transaction, not the reader's Task lease.
          await org.attachOrganizationWorkspace(orgId, workspaceId, owner.id)
        } finally { resume.resolve(); await bounded(reader) }
      })
      assert.deepEqual(await read(), [])
    })

    await t.test('external attach and detach wait on the real WS lease and a later operation sees their committed links', async () => {
      async function writerWaits(mutate: () => Promise<void>) {
        const entered = Promise.withResolvers<number>(), release = Promise.withResolvers<void>()
        const held = withTaskWorkspace(plain, racingWorkspace, async () => {
          entered.resolve((await workspacePool.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0].pid)
          await release.promise
          assert.deepEqual(await read(racingWorkspace), visible(racingWorkspace), 'a waiting external writer has not changed the locked link')
        })
        void held.catch(() => undefined)
        let writing: Promise<void> | undefined, settled = false
        try {
          const holder = await bounded(entered.promise)
          // This continuation is outside the held transaction: mutate uses the real requireWorkspace FOR UPDATE path.
          writing = mutate().then(() => { settled = true })
          void writing.catch(() => undefined)
          const deadline = Date.now() + 5_000
          let blocked = false
          while (Date.now() < deadline) {
            blocked = (await pool.query<{ blocked: boolean }>('select exists(select 1 from pg_stat_activity where $1::integer=any(pg_blocking_pids(pid))) as blocked', [holder])).rows[0].blocked
            if (blocked) break
            await delay(10)
          }
          assert.equal(blocked, true, 'the real Org writer must wait for the held WS row lock')
          assert.equal(settled, false, 'the writer cannot finish while the read lease is active')
        } finally { release.resolve(); await bounded(Promise.all([held, ...(writing ? [writing] : [])])) }
        assert.equal(settled, true, 'the writer finishes after the read lease releases its lock')
      }
      await writerWaits(() => org.attachOrganizationWorkspace(orgId, racingWorkspace, owner.id))
      assert.deepEqual(await read(racingWorkspace), [], 'a new read inherits the attached enforced Org')
      await policy(false)
      await writerWaits(() => org.detachOrganizationWorkspace(orgId, racingWorkspace, owner.id))
      await policy(true)
      assert.deepEqual(await read(racingWorkspace), visible(racingWorkspace), 'a new read does not inherit the detached Org')
    })

    await t.test('a Task continuation cannot keep authority after its outer WS transaction has committed', async () => {
      const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
      const result = Promise.withResolvers<Awaited<ReturnType<typeof activeTaskWorkspaces>>>()
      void result.promise.catch(() => undefined)
      let settled: Promise<unknown> | undefined
      try {
        await workspaceDb.transaction(async () => {
          const continuation = withTaskWorkspace(plain, racingWorkspace, async () => {
            entered.resolve()
            await resume.promise
            try { result.resolve(await read(racingWorkspace)) }
            catch (error) { result.reject(error); throw error }
          })
          // Deliberately retain the Task ALS beyond its real owner transaction.
          // Ending its already-committed savepoint may reject; drain that below.
          settled = continuation.catch(error => { entered.reject(error); result.reject(error) })
          await bounded(entered.promise)
        })
        await pool.query('update mikka_workspace_members set status=\'suspended\' where "workspaceId"=$1 and "userId"=$2', [racingWorkspace, owner.id])
        resume.resolve()
        assert.deepEqual(await bounded(result.promise), [], 'an inactive canonical transaction cannot lend its old membership or Org snapshot')
      } finally {
        resume.resolve()
        if (settled) await bounded(settled)
      }
    })

    await t.test('held linkage never freezes current policy, SCIM, provider verification or the exact session', async () => {
      // These are real persisted bindings. OIDC/SAML protocol validation has its separate HTTP/PG suite.
      await pool.query('insert into enterprise_sso_provider(id,"providerId","organizationScopeId","userId",issuer,domain,"domainVerified","oidcConfig","domainTokenHash") values($1,$2,$3,$4,$5,$6,true,$7,$8)', [randomUUID(), providerId, orgId, owner.id, 'https://held.example.invalid', providerId + '.example.invalid', '{}', hash])
      await pool.query('insert into enterprise_scim_connection(id,"organizationId","providerId","tokenHash") values($1,$2,$3,$4)', [connectionId, orgId, providerId, hash])
      await pool.query('insert into enterprise_scim_user(id,"connectionId","organizationId","externalId","userName","userId",active,document) values($1,$2,$3,$4,$5,$4,true,$6)', [directoryId, connectionId, orgId, owner.id, owner.email, {}])
      await pool.query('insert into enterprise_identity(id,"providerId",issuer,subject,"userId","directoryUserId") values($1,$2,$3,$4,$4,$5)', [identityId, providerId, 'https://held.example.invalid', owner.id, directoryId])
      await pool.query('update session set "enterpriseOrganizationId"=$2,"enterpriseProviderId"=$3,"enterpriseIdentityId"=$4 where id=$1', [assuredSession, orgId, providerId, identityId])
      await withTaskWorkspace(assured, workspaceId, async () => {
        assert.deepEqual(await read(workspaceId, assured), visible(workspaceId))
        await policy(false)
        assert.deepEqual(await read(), visible(workspaceId))
        await policy(true)
        assert.deepEqual(await read(), [], 'a plain session does not acquire the held reader\'s SSO assurance')
        assert.deepEqual(await read(workspaceId, assured), visible(workspaceId))
        await pool.query('update enterprise_scim_user set active=false where id=$1', [directoryId])
        assert.deepEqual(await read(workspaceId, assured), [], 'SCIM deactivation wins within the existing lease')
        await pool.query('update enterprise_scim_user set active=true where id=$1', [directoryId])
        assert.deepEqual(await read(workspaceId, assured), visible(workspaceId))
        await pool.query('update enterprise_sso_provider set "domainVerified"=false where "providerId"=$1', [providerId])
        assert.deepEqual(await read(workspaceId, assured), [], 'provider verification is checked on the next call')
        await pool.query('update enterprise_sso_provider set "domainVerified"=true where "providerId"=$1', [providerId])
        assert.deepEqual(await read(workspaceId, assured), visible(workspaceId))
        await pool.query('update session set "expiresAt"=now()-interval \'1 second\' where id=$1', [assuredSession])
        assert.deepEqual(await read(workspaceId, assured), [], 'a once-assured session must still be current')
        await pool.query('update session set "expiresAt"=now()+interval \'1 hour\' where id=$1', [assuredSession])
        assert.deepEqual(await read(workspaceId, assured), visible(workspaceId))
      })
    })
  } finally {
    try {
      if (organizationId) {
        await pool.query('delete from enterprise_scim_outbox where "organizationId"=$1', [organizationId])
        await pool.query('delete from enterprise_revocation where "organizationId"=$1', [organizationId])
        await pool.query('delete from enterprise_identity where "providerId"=$1', [providerId])
        await pool.query('delete from enterprise_scim_user where "organizationId"=$1', [organizationId])
        await pool.query('delete from enterprise_scim_connection where "organizationId"=$1', [organizationId])
        await pool.query('delete from enterprise_sso_provider where "providerId"=$1', [providerId])
        await pool.query('delete from enterprise_org_policy where "organizationId"=$1', [organizationId])
        await pool.query('delete from enterprise_audit_outbox where "organizationId"=$1', [organizationId])
        await pool.query('delete from mikka_organizations where id=$1', [organizationId])
      }
      await pool.query('delete from mikka_governance_member_outbox where "workspaceId"=any($1::uuid[])', [tenants])
      await pool.query('delete from mikka_workspace_members where "workspaceId"=any($1::uuid[])', [tenants])
      await pool.query('delete from mikka_workspaces where id=any($1::uuid[])', [tenants])
      await pool.query('delete from session where "userId"=$1', [owner.id])
      await pool.query('delete from "user" where id=$1', [owner.id])
      await pool.query('delete from enterprise_live_capabilities where "workspaceId"=any($1::uuid[])', [tenants])
    } finally {
      for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key] }
    }
  }
})
