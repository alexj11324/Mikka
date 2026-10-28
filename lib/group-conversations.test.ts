import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { groupDirectory } from './group-conversations-directory'
import { handleGroup, type GroupRequest } from './group-conversations-store'

const workspaceId = randomUUID(), ownAgent = randomUUID(), privateAgent = randomUUID()
const directory = groupDirectory({
  async activeUsers(w, ids) { return w === workspaceId ? ids.filter(id => ['owner', 'member'].includes(id)) : [] },
  async ownedAgents(user, ids) { return user === 'owner' ? ids.filter(id => id === ownAgent) : [] },
})
const base: GroupRequest = { userId: 'owner', method: 'GET', resource: 'conversations', workspaceId, origin: null, host: 'localhost:3100' }
const neverConnect = { async connect() { throw new Error('must reject before DB') } } as unknown as Pool

test('directory rejects foreign/suspended users and private or malformed agents', async () => {
  assert.equal(await directory(workspaceId, 'owner', [{ memberType: 'agent', memberId: ownAgent }]), true)
  assert.equal(await directory(workspaceId, 'owner', [{ memberType: 'agent', memberId: privateAgent }]), false)
  assert.equal(await directory(workspaceId, 'owner', [{ memberType: 'agent', memberId: 'bad' }]), false)
  assert.equal(await directory(workspaceId, 'owner', [{ memberType: 'user', memberId: 'outsider' }]), false)
  assert.equal(await directory(workspaceId, 'removed', []), false)
  assert.equal(await directory(randomUUID(), 'owner', []), false)
})
for (const [resource, method] of [['conversations','GET'],['conversations','POST'],['messages','GET'],['messages','POST'],['members','POST'],['members','DELETE']] as const) {
  test(`${method} ${resource}: authentication, write Origin/Host before DB`, async () => {
    const req = { ...base, resource, method, id: resource === 'conversations' ? undefined : randomUUID() }
    assert.equal((await handleGroup(neverConnect, directory, { ...req, userId: null })).status, 401)
    if (method !== 'GET') {
      for (const origin of ['https://evil.test', 'null', 'malformed', 'ftp://localhost:3100']) {
        assert.equal((await handleGroup(neverConnect, directory, { ...req, origin })).status, 403)
      }
    }
  })
}

// This test NEVER connects locally. The only authorized DB is the workflow's ephemeral service.
const dbURL = process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true' ? process.env.E2E_DATABASE_URL : undefined
if (dbURL) {
  const target = new URL(dbURL)
  if (target.hostname !== '127.0.0.1' || target.pathname !== '/mikka_e2e') throw new Error('Group tests require CI temporary mikka_e2e')
}
test('Postgres17 migration, atomic history, pagination, unread counts, membership and privacy', { skip: !dbURL }, async () => {
  const pool = new Pool({ connectionString: dbURL, max: 16 })
  // Isolated schema inside the ephemeral CI database; no dependency on bootstrap #115.
  const schema = `group_test_${randomUUID().replaceAll('-', '')}`
  const reverseSchema = `group_test_${randomUUID().replaceAll('-', '')}`
  await pool.query(`CREATE SCHEMA "${schema}"`)
  console.log(`Retaining synthetic group test schema ${schema} at ${new Date().toISOString()}`)
  await pool.query(`CREATE SCHEMA "${reverseSchema}"`)
  console.log(`Retaining synthetic group test schema ${reverseSchema} at ${new Date().toISOString()}`)
  const scoped = new Pool({ connectionString: dbURL, max: 16, options: `-c search_path=${schema}` })
  try {
    const migration = await readFile(new URL('../drizzle/20261023213851_group_conversations.sql', import.meta.url), 'utf8')
    await Promise.all([scoped.query(migration), scoped.query(migration)])
    await scoped.query(migration) // production retry / coexistence with #69
    const reads = await readFile(new URL('../tests/fixtures/conversation-reads-69.sql', import.meta.url), 'utf8')
    await scoped.query(reads) // this migration first, then #69
    // Exercise the reverse migration order in a second retained schema.
    const reverse = new Pool({ connectionString: dbURL, max: 1, options: `-c search_path=${reverseSchema}` })
    try {
      await reverse.query(reads) // #69 first, then this migration
      await reverse.query(migration)
      // Compare both orders at the catalog level, including table columns,
      // defaults, constraints and index keys. Each pool resolves its own schema.
      const catalog = async (target: Pool) => {
        const columns = await target.query(`SELECT table_name,column_name,ordinal_position,data_type,udt_name,is_nullable,column_default
          FROM information_schema.columns WHERE table_schema=current_schema()
          ORDER BY table_name,ordinal_position`)
        const constraints = await target.query(`SELECT t.relname AS table_name,c.conname,c.contype,pg_get_constraintdef(c.oid) AS definition
          FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
          WHERE n.nspname=current_schema() ORDER BY t.relname,c.conname`)
        const indexes = await target.query(`SELECT t.relname AS table_name,idx.relname AS index_name,i.indisunique,i.indisprimary,
          ARRAY(SELECT pg_get_indexdef(i.indexrelid,k,true) FROM generate_series(1,i.indnkeyatts) AS k ORDER BY k) AS keys,
          pg_get_expr(i.indpred,i.indrelid) AS predicate
          FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_class idx ON idx.oid=i.indexrelid
          JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=current_schema()
          ORDER BY t.relname,idx.relname`)
        return {columns:columns.rows,constraints:constraints.rows,indexes:indexes.rows}
      }
      const forwardCatalog = await catalog(scoped)
      const reverseCatalog = await catalog(reverse)
      assert.deepEqual([...new Set(forwardCatalog.columns.map(row => row.table_name))],
        ['conversation_links','conversation_members','conversation_messages','conversation_reads','conversations'])
      assert.deepEqual(reverseCatalog, forwardCatalog, 'both migration orders must produce equivalent columns, constraints and indexes')
    } finally { await reverse.end() }
    const run = (changes: Partial<GroupRequest>) => handleGroup(scoped, directory, { ...base, ...changes })
    for (const input of [undefined, '{', JSON.stringify({ workspaceId, title: '', members: [] }), JSON.stringify({ workspaceId: randomUUID(), title: 'foreign' }), JSON.stringify({ workspaceId, title: 'private', members: [{ memberType: 'agent', memberId: privateAgent }] })]) {
      assert.ok([404, 422].includes((await run({ method: 'POST', body: input })).status))
    }
    const created = await run({ method: 'POST', origin: 'http://localhost:3100', body: JSON.stringify({ workspaceId, title: 'Group', members: [{ memberType: 'user', memberId: 'member' }, { memberType: 'agent', memberId: ownAgent }] }) })
    assert.equal(created.status, 201)
    const id = (created.body as { id: string }).id
    for (const [resource, method] of [['messages','GET'],['messages','POST'],['members','POST'],['members','DELETE']] as const) {
      assert.equal((await run({ id, resource, method, userId: 'outsider', body: '{}' })).status, 404)
    }
    assert.equal((await run({ workspaceId: randomUUID() })).status, 404)
    assert.deepEqual((await run({ userId: 'member' })).status, 200)
    assert.equal((await run({ id, resource: 'members', method: 'POST', userId: 'member', body: JSON.stringify({ memberType: 'agent', memberId: ownAgent }) })).status, 403)
    assert.equal((await run({ id, resource: 'members', method: 'POST', body: JSON.stringify({ memberType: 'agent', memberId: privateAgent }) })).status, 404)
    const send = (body: string, extra: Record<string, unknown> = {}) => run({ id, resource: 'messages', method: 'POST', body: JSON.stringify({ body, ...extra }) })
    assert.equal((await send('bad mention', { mentions: [{ memberType: 'user', memberId: 'outsider' }] })).status, 422)
    // A stale group member row must not make a removed workspace user mentionable.
    await scoped.query(`INSERT INTO conversation_members ("conversationId","memberType","memberId",role) VALUES ($1,'user','removed-workspace','member')`, [id])
    assert.equal((await send('stale workspace mention', { mentions: [{ memberType: 'user', memberId: 'removed-workspace' }] })).status, 422)
    assert.equal((await send('bad reply', { replyToId: randomUUID() })).status, 422)
    const first = await send('first', { mentions: [{ memberType: 'agent', memberId: ownAgent }] })
    assert.equal(first.status, 201)
    const firstMessage = first.body as { id: string; position: string }
    assert.equal(firstMessage.position, '1')
    const concurrent = await Promise.all(Array.from({ length: 16 }, (_, i) => send(`parallel ${i}`)))
    assert.ok(concurrent.every(r => r.status === 201))
    assert.equal(new Set(concurrent.map(r => (r.body as { position: string }).position)).size, 16)
    assert.equal((await send('reply', { replyToId: firstMessage.id })).status, 201)
    const firstPage = await run({ id, resource: 'messages', limit: '5' })
    const page = firstPage.body as { messages: { position: string }[]; nextBefore: string }
    assert.equal(page.messages.length, 5); assert.equal(page.nextBefore, '14')
    const secondPage = (await run({ id, resource: 'messages', limit: '5', before: page.nextBefore })).body as typeof page
    assert.equal(secondPage.messages[0].position, '13')
    for (const limit of ['0', '-1', '101', 'NaN', '1.5']) assert.equal((await run({ id, resource: 'messages', limit })).status, 422)
    assert.equal((await run({ workspaceId: undefined })).status, 200)
    const list = (await run({ userId: 'member' })).body as { conversations: { unreadCount: string; lastMessage: { position: string } }[] }
    assert.equal(list.conversations[0].unreadCount, '18'); assert.equal(list.conversations[0].lastMessage.position, '18')
    await scoped.query('INSERT INTO conversation_reads ("userId","conversationId","lastReadPosition") VALUES ($1,$2,10)', ['member', id])
    assert.equal(((await run({ userId: 'member' })).body as typeof list).conversations[0].unreadCount, '8')
    assert.equal(((await run({})).body as typeof list).conversations[0].unreadCount, '0')
    const remove = await run({ id, resource: 'members', method: 'DELETE', body: JSON.stringify({ memberType: 'user', memberId: 'member' }) })
    assert.equal(remove.status, 200)
    assert.equal((await run({ id, resource: 'messages', userId: 'member' })).status, 404)
    assert.equal((await run({ id, resource: 'messages', method: 'POST', userId: 'member', body: '{"body":"after removal"}' })).status, 404)
    assert.equal(((await run({ userId: 'member' })).body as typeof list).conversations.length, 0)
    assert.equal((await scoped.query('SELECT "leftAt" FROM conversation_members WHERE "conversationId"=$1 AND "memberId"=$2', [id, 'member'])).rows[0].leftAt instanceof Date, true)
    assert.equal((await run({ id, resource: 'members', method: 'DELETE', body: JSON.stringify({ memberType: 'user', memberId: 'owner' }) })).status, 422)
    assert.equal((await run({ id, resource: 'members', method: 'POST', body: JSON.stringify({ memberType: 'user', memberId: 'member' }) })).status, 200)
    assert.equal((await run({ id, resource: 'messages', userId: 'member' })).status, 200)
    // Removal commits while a send waits on the conversation lock: sender must recheck.
    const removal = await scoped.connect()
    await removal.query('BEGIN')
    await removal.query('SELECT id FROM conversations WHERE id=$1 FOR UPDATE', [id])
    await removal.query('UPDATE conversation_members SET "leftAt"=now() WHERE "conversationId"=$1 AND "memberId"=$2', [id, 'member'])
    const waitingSend = run({ id, resource: 'messages', method: 'POST', userId: 'member', body: '{"body":"racing removal"}' })
    let observedWait = false
    try {
      for (let attempt = 0; attempt < 100 && !observedWait; attempt++) {
        const { rows } = await scoped.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT * FROM conversations WHERE id=%'`)
        observedWait = rows.length > 0
        if (!observedWait) await new Promise(resolve => setTimeout(resolve, 10))
      }
    } finally {
      await removal.query('COMMIT')
      removal.release()
    }
    assert.equal((await waitingSend).status, 404)
    assert.equal(observedWait, true, 'the send actually waited for the removal lock')
    const suspendedDirectory = groupDirectory({ async activeUsers() { return [] }, async ownedAgents() { return [] } })
    for (const [resource, method] of [['messages','GET'],['messages','POST'],['members','POST'],['members','DELETE']] as const) {
      assert.equal((await handleGroup(scoped, suspendedDirectory, { ...base, id, resource, method, body: '{}' })).status, 404)
    }
    // Forged sender / elevated initial role are not accepted by the strict schemas.
    assert.equal((await send('forged', { authorId: 'member' })).status, 422)
    assert.equal((await run({ method: 'POST', body: JSON.stringify({ workspaceId, title: 'bad role', members: [{ memberType: 'user', memberId: 'member', role: 'owner' }] }) })).status, 422)

    const dm = randomUUID()
    await scoped.query('INSERT INTO conversations (id,"workspaceId",kind,title,"createdBy") VALUES ($1,$2,\'agent_dm\',\'private\',\'owner\')', [dm, workspaceId])
    assert.equal((await run({ id: dm, resource: 'messages' })).status, 404)
    // Integer precision is retained beyond JS MAX_SAFE_INTEGER in both endpoint shapes.
    await scoped.query('UPDATE conversations SET "lastPosition"=9007199254740992 WHERE id=$1', [id])
    assert.equal(((await send('big')).body as typeof firstMessage).position, '9007199254740993')
    assert.equal(((await run({})).body as typeof list).conversations[0].lastMessage.position, '9007199254740993')
  } finally {
    await scoped.end()
    await pool.end()
  }
})
