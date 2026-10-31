import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mock, test } from 'node:test'
import { Pool } from 'pg'
import { assertE2eTarget } from '../tests/helpers/e2e-target.mjs'

const target = process.env.E2E_DATABASE_URL
if (target) {
  assertE2eTarget(target)
  assert.equal(process.env.MIKKA_DATABASE_URL, target)
  assert.equal(process.env.DATABASE_URL, target)
}
if (!target && process.env.REQUIRE_DB === '1') throw Error('An isolated group read database is required')
let caller: string | null = null, tokenWorkspaceId: string | undefined
// Only session lookup is a fixture. The exported routes, group/workspace
// membership, timeline, read-position storage and unread SQL are real.
mock.module(new URL('./auth.ts', import.meta.url).href, { namedExports: { auth: { api: {
  getSession: async () => caller ? { user: { id: caller }, session: { id: 'group-read-fixture' }, tokenWorkspaceId } : null,
} } } })

test('group read routes advance actual group history without opening private DMs', { skip: !target }, async t => {
  const pool = new Pool({ connectionString: target })
  const { pool: appPool } = await import('./db')
  const { workspacePool } = await import('./workspace-db')
  t.after(async () => { await Promise.all([pool.end(), appPool.end(), workspacePool.end()]) })
  const owner = `group105-owner-${randomUUID()}`, member = `group105-member-${randomUUID()}`, outsider = `group105-outsider-${randomUUID()}`
  const workspace = randomUUID(), otherWorkspace = randomUUID(), group = randomUUID(), otherGroup = randomUUID(), dm = randomUUID(), agent = randomUUID(), exchangeLink = randomUUID()
  for (const user of [owner, member, outsider]) await pool.query('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$1,$2,true,now(),now())', [user, `${user}@example.invalid`])
  for (const [id, user] of [[workspace, owner], [otherWorkspace, outsider]]) await pool.query('INSERT INTO mikka_workspaces (id,"userId",name) VALUES ($1,$2,\'Group read fixture\')', [id, user])
  for (const [id, user, role] of [[workspace, owner, 'admin'], [workspace, member, 'member'], [otherWorkspace, outsider, 'admin']]) await pool.query('INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status) VALUES ($1,$2,$2,$3,$4,\'active\')', [id, user, `${user}@example.invalid`, role])
  for (const [id, w, user, kind] of [[group, workspace, owner, 'group'], [otherGroup, otherWorkspace, outsider, 'group'], [dm, workspace, owner, 'agent_dm']]) await pool.query('INSERT INTO conversations (id,"workspaceId",kind,title,"createdBy","lastPosition") VALUES ($1,$2,$3,\'Group read fixture\',$4,4)', [id, w, kind, user])
  for (const [id, user] of [[group, owner], [group, member], [otherGroup, outsider]]) await pool.query('INSERT INTO conversation_members ("conversationId","memberType","memberId",role) VALUES ($1,\'user\',$2,\'member\')', [id, user])
  const ids = Array.from({ length: 4 }, () => randomUUID()), foreign = randomUUID()
  for (let index = 0; index < ids.length; index++) await pool.query('INSERT INTO conversation_messages (id,"conversationId",position,"authorType","authorId",body) VALUES ($1,$2,$3,$4,$5,\'Group read fixture\')', [ids[index], group, index + 1, index % 2 ? 'agent' : 'user', index === 0 ? owner : index === 2 ? member : agent])
  await pool.query('INSERT INTO conversation_messages (id,"conversationId",position,"authorType","authorId",body) VALUES ($1,$2,1,\'user\',$3,\'Private fixture\')', [foreign, otherGroup, outsider])
  const route = await import('../app/api/conversations/[id]/read/route')
  const list = await import('../app/api/conversations/route')
  const links = await import('../app/api/conversation-links/[id]/messages/route')
  const linked = (id = exchangeLink, query = '') => links.GET(new Request(`http://127.0.0.1/api/conversation-links/${id}/messages${query}`), { params: Promise.resolve({ id }) })
  const call = (method: 'GET' | 'POST', id = group, messageId?: string, origin?: string) => route[method](new Request(`http://127.0.0.1/api/conversations/${id}/read`, {
    method, headers: { host: '127.0.0.1', ...(origin ? { origin } : {}), 'content-type': 'text/plain' },
    ...(method === 'POST' ? { body: JSON.stringify({ messageId }) } : {}),
  }), { params: Promise.resolve({ id }) })
  caller = member
  await t.test('a member can read, mark by UUID or position, and reduce list unread counts', async () => {
    assert.deepEqual(await (await call('GET')).json(), { lastReadMessageId: null, lastReadPosition: null, unreadCount: 3 })
    assert.deepEqual(await (await call('POST', group, ids[1])).json(), { lastReadMessageId: ids[1], lastReadPosition: 2, unreadCount: 1 })
    const response = await list.GET(new Request('http://127.0.0.1/api/conversations'))
    const rows = (await response.json()).conversations
    assert.equal(rows.find((row: { id: string }) => row.id === group).unreadCount, '1')
    assert.deepEqual(await (await call('POST', group, '1')).json(), { lastReadMessageId: ids[1], lastReadPosition: 2, unreadCount: 1 })
    assert.deepEqual(await (await call('POST', group, '4')).json(), { lastReadMessageId: ids[3], lastReadPosition: 4, unreadCount: 0 })
  })
  await t.test('unknown and foreign messages are rejected without moving the read position', async () => {
    for (const id of [foreign, randomUUID(), '5', '0', 'bad']) assert.equal((await call('POST', group, id)).status, 422)
    assert.equal((await (await call('GET')).json()).lastReadPosition, 4)
  })
  await t.test('concurrent marks remain forward-only and another member has an independent position', async () => {
    caller = owner
    const responses = await Promise.all([call('POST', group, ids[3]), call('POST', group, ids[1])])
    assert.deepEqual(responses.map(response => response.status), [200, 200])
    assert.equal((await (await call('GET')).json()).lastReadPosition, 4)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM conversation_reads WHERE "conversationId"=$1', [group])).rows[0].n, 2)
  })
  await t.test('a source member reads only the linked exchange range with public sender metadata', async () => {
    const secondAgent = randomUUID()
    for (const [id, harness, name] of [[agent, 'codex', 'Worker A'], [secondAgent, 'claude_code', 'Worker B']]) {
      await pool.query('INSERT INTO agents (id,"userId",harness,name,instructions) VALUES ($1,$2,$3,$4,\'private-worker-instructions\')', [id, owner, harness, name])
      await pool.query('INSERT INTO conversation_members ("conversationId","memberType","memberId",role) VALUES ($1,\'agent\',$2,\'member\')', [dm, id])
    }
    for (let position = 1; position <= 5; position++) await pool.query('INSERT INTO conversation_messages (id,"conversationId",position,"authorType","authorId",body) VALUES ($1,$2,$3,\'agent\',$4,$5)', [randomUUID(), dm, position, position % 2 ? agent : secondAgent, position < 2 || position > 3 ? 'private-outside-segment' : `exchange-${position}`])
    await pool.query('UPDATE conversations SET "lastPosition"=5 WHERE id=$1', [dm])
    await pool.query('INSERT INTO conversation_links (id,"sourceConversationId","linkedConversationId","anchorPosition","firstPosition","lastPosition","messageCount") VALUES ($1,$2,$3,4,2,3,2)', [exchangeLink, group, dm])
    caller = member
    const priorRead = await (await call('GET')).json()
    const response = await linked(exchangeLink, '?limit=1')
    assert.equal(response.status, 200)
    const first = await response.json()
    assert.equal(first.messageCount, '2')
    assert.deepEqual(first.messages.map((m: { position: string }) => m.position), ['3'])
    assert.equal(first.messages[0].author.name, 'Worker A')
    assert.equal(first.messages[0].author.avatarUrl, null)
    assert.deepEqual(first.participants.map((p: { name: string }) => p.name).sort(), ['Worker A', 'Worker B'])
    const second = await (await linked(exchangeLink, `?limit=1&before=${first.nextBefore}`)).json()
    assert.deepEqual(second.messages.map((m: { position: string }) => m.position), ['2'])
    assert.equal(second.nextBefore, null)
    const all = await (await linked(exchangeLink, '?before=999')).json()
    assert.deepEqual(all.messages.map((m: { position: string }) => m.position), ['3', '2'])
    assert.equal(JSON.stringify(all).includes('private-outside-segment'), false)
    assert.equal(JSON.stringify(all).includes('private-worker-instructions'), false)
    assert.equal('linkedConversationId' in all, false)
    assert.equal('POST' in links, false)
    assert.deepEqual(await (await call('GET')).json(), priorRead, 'viewing an exchange neither marks nor adds unread source messages')
    const messages = await import('../app/api/conversations/[id]/messages/route')
    assert.equal((await messages.GET(new Request(`http://127.0.0.1/api/conversations/${dm}/messages`), { params: Promise.resolve({ id: dm }) })).status, 404)
    for (const query of ['?limit=0', '?limit=101', '?before=0']) assert.equal((await linked(exchangeLink, query)).status, 422)
    const wrongKind = randomUUID(), foreignDM = randomUUID(), crossed = randomUUID(), unrelated = randomUUID()
    await pool.query('INSERT INTO conversations (id,"workspaceId",kind,title,"createdBy") VALUES ($1,$2,\'agent_dm\',\'Foreign fixture\',$3)', [foreignDM, otherWorkspace, outsider])
    for (const [id, source, target] of [[wrongKind, group, otherGroup], [crossed, group, foreignDM], [unrelated, otherGroup, foreignDM]]) await pool.query('INSERT INTO conversation_links (id,"sourceConversationId","linkedConversationId","anchorPosition","firstPosition","lastPosition","messageCount") VALUES ($1,$2,$3,1,1,1,1)', [id, source, target])
    for (const id of [randomUUID(), wrongKind, crossed, unrelated]) assert.equal((await linked(id)).status, 404)
    tokenWorkspaceId = otherWorkspace
    assert.equal((await linked()).status, 404)
    tokenWorkspaceId = undefined
  })
  await t.test('unknown groups, unrelated workspaces, scoped callers and raw DMs stay private', async () => {
    for (const id of [randomUUID(), otherGroup, dm]) assert.equal((await call('GET', id)).status, 404)
    tokenWorkspaceId = otherWorkspace
    assert.equal((await call('GET')).status, 404)
    tokenWorkspaceId = undefined
    for (const method of ['GET', 'POST'] as const) assert.equal((await call(method, group, ids[3], 'https://foreign.invalid')).status, 403)
    caller = null
    assert.equal((await call('GET')).status, 401)
  })
  await t.test('group removal and workspace suspension reject subsequent read and mark calls', async () => {
    caller = member
    await pool.query('UPDATE conversation_members SET "leftAt"=now() WHERE "conversationId"=$1 AND "memberId"=$2', [group, member])
    assert.equal((await call('GET')).status, 404)
    assert.equal((await linked()).status, 404)
    assert.equal((await call('POST', group, ids[1])).status, 404)
    caller = owner
    await pool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspace, owner])
    assert.equal((await call('GET')).status, 404)
    assert.equal((await linked()).status, 404)
    assert.equal((await call('POST', group, ids[1])).status, 404)
  })
})
