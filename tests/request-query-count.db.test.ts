import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
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
  try { const value = await work(); return { value, queries: statements.length, bytes: Buffer.byteLength(JSON.stringify(value) ?? '') } }
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
      await pool.query('insert into issues(id,"userId",title,content,status,priority,scope) values($1,$2,$3,$4,$5,$6,$7)', [issue, owner, `Task ${index}`, JSON.stringify({ type: 'doc', attrs: { mikka: { number: index + 1 } }, content: [] }), 'doing', 'normal', 'personal'])
      await pool.query('insert into agent_runs(id,"userId","issueId","agentId",status,prompt) values($1,$2,$3,$4,$5,$6)', [run, owner, issue, agent, 'succeeded', `Fix thing ${index}`])
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
    assert.equal(fourScopes.queries, twoScopes.queries, 'factory tasks: the same queries for 2 and 4 bot scopes')
    assert.ok(fourScopes.queries <= 13, `factory tasks: ${fourScopes.queries} queries`)

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
    const insert = (id: string, userId: string, scope: string, deleted = false) => pool.query('insert into issues(id,"userId",title,content,status,priority,scope) values($1,$2,$3,$4,$5,$6,$7)',
      [id, userId, id, JSON.stringify({ type: 'doc', attrs: deleted ? { mikka: { deletedAt: new Date().toISOString() } } : {}, content: [] }), 'todo', 'normal', scope])
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
