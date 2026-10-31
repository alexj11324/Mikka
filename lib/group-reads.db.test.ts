import 'next/dist/server/node-environment-baseline'
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
  const messages = await import('../app/api/conversations/[id]/messages/route')
  const { AfterContext } = await import('next/dist/server/after/after-context')
  const { workAsyncStorage } = await import('next/dist/server/app-render/work-async-storage.external')
  const { workUnitAsyncStorage } = await import('next/dist/server/app-render/work-unit-async-storage.external')
  const { createRequestStoreForAPI } = await import('next/dist/server/async-storage/request-store')
  const { NextRequest } = await import('next/server')
  const history = async (query = '', conversationId: string = group) => {
    const request = new NextRequest(`http://127.0.0.1/api/conversations/${conversationId}/messages${query}`)
    const waits: Promise<unknown>[] = [], errors: unknown[] = [], closes: Array<() => void> = []
    const afterContext = new AfterContext({ waitUntil: promise => { waits.push(promise) }, onClose: callback => { closes.push(callback) }, onTaskError: error => { errors.push(error) } })
    const requestStore: ReturnType<typeof createRequestStoreForAPI> = Reflect.apply(createRequestStoreForAPI, undefined, [request, new URL(request.url), { tags: [], expirationsByCacheKind: new Map() }, undefined, undefined, undefined])
    return workAsyncStorage.run({ afterContext } as NonNullable<ReturnType<typeof workAsyncStorage.getStore>>, () => workUnitAsyncStorage.run(requestStore, async () => {
      try { return await messages.GET(request, { params: Promise.resolve({ id: conversationId }) }) }
      finally { for (const close of closes) close(); await Promise.all(waits); assert.deepEqual(errors, []) }
    }))
  }
  const linked = (id: string = exchangeLink, query = '') => links.GET(new Request(`http://127.0.0.1/api/conversation-links/${id}/messages${query}`), { params: Promise.resolve({ id }) })
  const call = (method: 'GET' | 'POST', id: string = group, messageId?: string, origin?: string) => route[method](new Request(`http://127.0.0.1/api/conversations/${id}/read`, {
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
    const firstPageResponse = await history('?limit=1')
    assert.equal(firstPageResponse.status, 200)
    const firstPage = await firstPageResponse.json()
    assert.deepEqual(firstPage.messages.map((m: { position: string }) => m.position), ['4'])
    assert.deepEqual(firstPage.timeline.map((item: { type: string }) => item.type), ['message', 'agent_exchange'])
    assert.deepEqual(firstPage.timeline[1], { type: 'agent_exchange', linkId: exchangeLink, anchorPosition: '4', count: '2', participants: all.participants })
    assert.equal(firstPage.nextBefore, '4')
    const olderPage = await (await history(`?before=${firstPage.nextBefore}&limit=3`)).json()
    assert.deepEqual(olderPage.messages.map((m: { position: string }) => m.position), ['3', '2', '1'])
    assert.equal(olderPage.timeline.some((item: { type: string }) => item.type === 'agent_exchange'), false)
    assert.equal(olderPage.nextBefore, null)
    assert.equal(JSON.stringify(firstPage.timeline).includes('private-worker-instructions'), false)
    assert.equal(JSON.stringify(firstPage.timeline).includes('private-outside-segment'), false)
    assert.deepEqual(await (await call('GET')).json(), priorRead, 'timeline links neither change read state nor count as unread messages')
    assert.equal((await messages.GET(new Request(`http://127.0.0.1/api/conversations/${dm}/messages`), { params: Promise.resolve({ id: dm }) })).status, 404)
    for (const query of ['?limit=0', '?limit=101', '?before=0']) assert.equal((await linked(exchangeLink, query)).status, 422)
    const wrongKind = randomUUID(), foreignDM = randomUUID(), crossed = randomUUID(), unrelated = randomUUID()
    await pool.query('INSERT INTO conversations (id,"workspaceId",kind,title,"createdBy") VALUES ($1,$2,\'agent_dm\',\'Foreign fixture\',$3)', [foreignDM, otherWorkspace, outsider])
    for (const [id, source, target] of [[wrongKind, group, otherGroup], [crossed, group, foreignDM], [unrelated, otherGroup, foreignDM]]) await pool.query('INSERT INTO conversation_links (id,"sourceConversationId","linkedConversationId","anchorPosition","firstPosition","lastPosition","messageCount") VALUES ($1,$2,$3,1,1,1,1)', [id, source, target])
    for (const id of [randomUUID(), wrongKind, crossed, unrelated]) assert.equal((await linked(id)).status, 404)
    assert.deepEqual((await (await history()).json()).timeline.filter((item: { type: string }) => item.type === 'agent_exchange').map((item: { linkId: string }) => item.linkId), [exchangeLink], 'foreign and wrong-kind links cannot appear in the source timeline')
    tokenWorkspaceId = otherWorkspace
    assert.equal((await linked()).status, 404)
    assert.equal((await history()).status, 404)
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
    assert.equal((await history()).status, 404)
    assert.equal((await call('POST', group, ids[1])).status, 404)
    caller = owner
    await pool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspace, owner])
    assert.equal((await call('GET')).status, 404)
    assert.equal((await linked()).status, 404)
    assert.equal((await history()).status, 404)
    assert.equal((await call('POST', group, ids[1])).status, 404)
  })
  await t.test('the actual group-turn host produces bounded private links without publishing private context', async () => {
    const { processGroupTurn } = await import('./coordinator/group-turns')
    const { handleGroup } = await import('./group-conversations-store')
    const { groupDirectory } = await import('./group-conversations-directory')
    const w = randomUUID(), a = randomUUID(), b = randomUUID(), c = randomUUID()
    await pool.query(`INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,$2,'Exchange producer fixture')`, [w, owner])
    for (const user of [owner, member]) await pool.query(`INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$3,'admin','active')`, [w, user, `${user}@example.invalid`])
    for (const id of [a,b,c]) await pool.query(`INSERT INTO agents(id,"userId",name,harness) VALUES($1,$2,$3,'codex')`, [id, owner, `exchange-${id}`])
    const directory = groupDirectory({
      async activeUsers(workspaceId, users) { return (await pool.query(`SELECT "userId" FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=ANY($2::text[]) AND status='active'`, [workspaceId, users])).rows.map(row => row.userId) },
      async ownedAgents(userId, agents) { return (await pool.query(`SELECT id FROM agents WHERE "userId"=$1 AND id=ANY($2::uuid[])`, [userId, agents])).rows.map(row => row.id) },
    })
    const base = { userId: owner, origin: null, host: '127.0.0.1' }
    const created = await handleGroup(pool, directory, { ...base, method: 'POST', resource: 'conversations', body: JSON.stringify({ workspaceId: w, title: 'Exchange source', members: [a,b,c].map(memberId => ({ memberType: 'agent', memberId })) }) }, true)
    assert.equal(created.status, 201)
    const source = (created.body as { id: string }).id
    await pool.query(`INSERT INTO conversation_members("conversationId","memberType","memberId",role) VALUES($1,'user',$2,'member')`, [source, member])
    assert.equal((await handleGroup(pool, directory, { ...base, method: 'POST', resource: 'messages', id: source,
      body: JSON.stringify({ body: 'forged source', privateTo: b, linkedConversationId: dm }) }, true)).status, 422)
    const send = async (text: string, selected = [a]) => {
      const response = await handleGroup(pool, directory, { ...base, method: 'POST', resource: 'messages', id: source,
        body: JSON.stringify({ body: text, mentions: selected.map(memberId => ({ memberType: 'agent', memberId })) }) }, true)
      assert.equal(response.status, 201)
    }
    const runtime = {
      async agents(userId: string, ids: string[], client: import('pg').PoolClient) { return (await client.query(`SELECT id,name,description FROM agents WHERE "userId"=$1 AND id=ANY($2::uuid[])`, [userId, ids])).rows },
      async authorized(workspaceId: string, userId: string) { return Boolean((await pool.query(`SELECT 1 FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2 AND status='active'`, [workspaceId, userId])).rowCount) },
      async route(): Promise<never> { throw Error('An explicit mention must not call a decision fixture') },
      async correction(): Promise<never> { throw Error('Explicit mention roots need no correction fixture') },
      async generate(agent: { id: string }, input: { message: { text: string }; earlier: { text: string }[]; privatePeer?: { id: string } }) {
        if (agent.id === c) { assert.deepEqual(input.earlier, []); return { text: 'public response', mentions: [] } }
        if (!input.privatePeer) return { text: `private question ${input.message.text}`, mentions: [], privateTo: b,
          sourceConversationId: group, linkedConversationId: dm, linkId: exchangeLink, anchorPosition: '4' }
        return { text: agent.id === b ? `private answer ${input.message.text}` : '[nothing to add]', mentions: [] }
      },
    }
    await send('first', [a,c]); await processGroupTurn(pool, source, runtime)
    const initial = (await pool.query(`SELECT id,"linkedConversationId","anchorPosition"::text,"firstPosition"::text,"lastPosition"::text,"messageCount"::text FROM conversation_links WHERE "sourceConversationId"=$1`, [source])).rows
    assert.equal(initial.length, 1)
    assert.notEqual(initial[0].linkedConversationId, dm, 'model output cannot bind an existing arbitrary DM or source')
    assert.deepEqual([initial[0].anchorPosition, initial[0].firstPosition, initial[0].lastPosition, initial[0].messageCount], ['1','1','2','2'])
    const dmMembers = (await pool.query(`SELECT "memberType","memberId" FROM conversation_members WHERE "conversationId"=$1 ORDER BY "memberId"`, [initial[0].linkedConversationId])).rows
    assert.deepEqual(dmMembers, [a,b].sort().map(memberId => ({ memberType: 'agent', memberId })))
    caller = member
    const shown = await (await history('', source)).json()
    assert.equal(shown.messages.length, 2)
    assert.equal(shown.timeline.filter((item: { type: string }) => item.type === 'agent_exchange').length, 1)
    assert.equal(JSON.stringify(shown).includes('private question'), false)
    assert.equal((await (await call('GET', source)).json()).unreadCount, 2)
    const firstView = await (await linked(initial[0].id)).json()
    assert.deepEqual(firstView.messages.map((entry: { body: string }) => entry.body), ['private answer first','private question first'])
    assert.equal((await history('', initial[0].linkedConversationId)).status, 404)
    await send('second'); await processGroupTurn(pool, source, runtime)
    const segments = (await pool.query(`SELECT id,"linkedConversationId","firstPosition"::text,"lastPosition"::text,"messageCount"::text FROM conversation_links WHERE "sourceConversationId"=$1 ORDER BY "anchorPosition"`, [source])).rows
    assert.equal(segments.length, 2)
    assert.equal(segments[0].linkedConversationId, segments[1].linkedConversationId)
    assert.deepEqual([segments[1].firstPosition, segments[1].lastPosition, segments[1].messageCount], ['3','4','2'])
    assert.equal(JSON.stringify(await (await linked(segments[0].id, '?before=999')).json()).includes('second'), false)
    assert.equal((await (await call('GET', source)).json()).unreadCount, 3, 'private message positions do not add source unread messages')
    // Remove a source peer while its initial model response is in flight.
    await send('peer revoked')
    await processGroupTurn(pool, source, { ...runtime, async generate(agent, input) {
      const reply = await runtime.generate(agent, input)
      assert.equal((await handleGroup(pool, directory, { ...base, method: 'DELETE', resource: 'members', id: source, body: JSON.stringify({ memberType: 'agent', memberId: b }) }, true)).status, 200)
      return reply
    } })
    assert.equal((await pool.query(`SELECT count(*)::int n FROM conversation_messages WHERE "conversationId"=$1`, [initial[0].linkedConversationId])).rows[0].n, 4)
    assert.equal((await handleGroup(pool, directory, { ...base, method: 'POST', resource: 'members', id: source, body: JSON.stringify({ memberType: 'agent', memberId: b }) }, true)).status, 200)
    await send('owner revoked')
    await processGroupTurn(pool, source, { ...runtime, async generate(agent, input) {
      const reply = await runtime.generate(agent, input)
      await pool.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"=$2`, [w, owner])
      return reply
    } })
    assert.equal((await pool.query(`SELECT count(*)::int n FROM conversation_messages WHERE "conversationId"=$1`, [initial[0].linkedConversationId])).rows[0].n, 4)
    caller = outsider
    assert.equal((await linked(initial[0].id)).status, 404)
    caller = member
    await pool.query(`UPDATE conversation_members SET "leftAt"=now() WHERE "conversationId"=$1 AND "memberType"='user' AND "memberId"=$2`, [source, member])
    assert.equal((await linked(initial[0].id)).status, 404)
  })
})
