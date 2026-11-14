import { seedFixtureWorkspace } from './helpers/task-workspace'
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { Pool } from 'pg'
import { orderMigrations } from '../scripts/migration-order.mjs'
import { createTestDatabase, dropTestDatabase } from './support/drop-test-database'
import { groupDirectory } from '../lib/group-conversations-directory'
import { handleGroup, type GroupRequest } from '../lib/group-conversations-store'
import { conversationDirectory, conversationSidebar } from '../lib/conversation-directory'
import { conversationOrganization } from '../lib/conversation-organization'
import { nameConversation, renameConversationTitle } from '../lib/conversation-title-server'

const base = process.env.E2E_DATABASE_URL
const required = process.env.REQUIRE_DB === '1' || (process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true')
if (required) assert.ok(base, 'E2E_DATABASE_URL is required')
function guarded(url: string) {
  const u = new URL(url)
  assert.ok(['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname), 'loopback only')
  assert.match(u.pathname, /^\/[a-z0-9_]+_e2e$/)
  return u
}

// Decision 2026-11-13-1405: a conversation owns a bounded short title; a person's rename is never overwritten.
test('a conversation\'s stored title: bounded by the schema, generated per trigger, shared by its chain, and a manual rename wins', { skip: !base, timeout: 120_000 }, async () => {
  const admin = guarded(base!)
  const name = `cvt_${randomUUID().replaceAll('-', '')}_e2e`
  const adminPool = new Pool({ connectionString: admin.toString(), max: 1 })
  await createTestDatabase(adminPool, name, 'template0')
  const target = new URL(admin.toString()); target.pathname = `/${name}`; guarded(target.toString())
  const pool = new Pool({ connectionString: target.toString(), max: 2 })
  try {
    const dir = new URL('../drizzle/', import.meta.url)
    for (const f of orderMigrations((await readdir(dir)).filter(f => f.endsWith('.sql')))) await pool.query(await readFile(new URL(f, dir), 'utf8'))
    await pool.query(`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ('owner','O','o@example.invalid',true,now(),now()),('other','X','x@example.invalid',true,now(),now())`)
    const agentId = randomUUID()
    await pool.query(`INSERT INTO agents (id,"userId",name,harness) VALUES ($1,'owner','Coder','codex')`, [agentId])
    const workspaceId = await seedFixtureWorkspace(pool, 'owner')
    const issueId = randomUUID()
    await pool.query(`INSERT INTO issues (id,"userId","workspaceId",title,content,status,priority) VALUES ($1,'owner',$2,'修复登录后的工作区前缀和查询参数丢失问题并补充回归测试','{"type":"doc"}','doing','normal')`, [issueId, workspaceId])
    const asked = '排查登录回调里丢失的 workspace 前缀\n补上回归测试'
    const run = async (extra: { continues?: string; prompt?: string; finished?: boolean } = {}) => {
      const id = randomUUID(), prompt = extra.prompt ?? asked
      await pool.query(`INSERT INTO agent_runs (id,"userId","workspaceId","issueId","agentId",status,prompt,"promptTaskStart","promptTaskLength","continuesRunId",report,"finishedAt")
        VALUES ($1,'owner',$2,$3,$4,$5,$6,0,$7,$8,$9,$10)`, [id, workspaceId, issueId, agentId, extra.finished ? 'succeeded' : 'running', prompt, prompt.length, extra.continues ?? null,
        extra.finished ? JSON.stringify({ summary: 'Restored the workspace prefix in the callback' }) : null, extra.finished ? new Date() : null])
      return id
    }
    const stored = async (id: string) => (await pool.query<{ title: string | null; titleSource: string | null }>('SELECT title, "titleSource" FROM agent_runs WHERE id=$1', [id])).rows[0]
    const calls: { title: string; body: string }[] = []
    const model = (answer: string | null) => async (_owner: string, text: { title: string; body: string }, scope: string) => {
      assert.equal(scope, workspaceId, 'model admission belongs to the run workspace')
      calls.push(text)
      return answer
    }

    // The schema holds the bound and ties a title to who wrote it.
    const first = await run()
    await assert.rejects(pool.query(`UPDATE agent_runs SET title=$2,"titleSource"='generated' WHERE id=$1`, [first, '修复登录后的工作区前缀和查询参数']), /agent_runs_title_compact/)
    await assert.rejects(pool.query(`UPDATE agent_runs SET title=$2,"titleSource"='generated' WHERE id=$1`, [first, 'one two three four five six seven']), /agent_runs_title_compact/)
    await assert.rejects(pool.query(`UPDATE agent_runs SET title='登录回调修复' WHERE id=$1`, [first]), /agent_runs_title_source/)
    await assert.rejects(pool.query(`UPDATE agent_runs SET title='登录回调修复',"titleSource"='model' WHERE id=$1`, [first]), /agent_runs_title_source/)
    assert.deepEqual(await stored(first), { title: null, titleSource: null }, 'no backfill: an old conversation has no stored title')

    // Created: named from what it was asked, never from its task's title or the execution instructions.
    assert.equal(await nameConversation(pool, first, 'owner', 'created', model('登录回调排查')), '登录回调排查')
    assert.deepEqual(calls.at(-1), { title: '排查登录回调里丢失的 workspace 前缀', body: '补上回归测试' })
    assert.deepEqual(await stored(first), { title: '登录回调排查', titleSource: 'generated' })
    assert.equal(await nameConversation(pool, first, 'owner', 'created', model('另一个名字')), null, 'created names it once')
    // A model that gives nothing usable, or a conversation with no recorded request, keeps what it has.
    const silent = await run({ prompt: '' })
    assert.equal(await nameConversation(pool, silent, 'owner', 'created', model('不该用到')), null)
    const unnamed = await run({ prompt: '整理设计备份' })
    assert.equal(await nameConversation(pool, unnamed, 'owner', 'created', model(null)), null)
    assert.deepEqual(await stored(unnamed), { title: null, titleSource: null })
    // Another person's run is never read or named.
    assert.equal(await nameConversation(pool, first, 'other', 'regenerate', model('越权')), null)

    // First run ended: named again from what it did, while the title is a generated one.
    await pool.query(`UPDATE agent_runs SET status='succeeded',"finishedAt"=now(),report=$2 WHERE id=$1`, [first, JSON.stringify({ summary: 'Restored the workspace prefix in the callback' })])
    const before = calls.length
    assert.equal(await nameConversation(pool, first, 'owner', 'first_run_ended', model('回调前缀修复')), '回调前缀修复')
    assert.match(calls.at(-1)!.body, /Restored the workspace prefix/)
    assert.equal(calls.length, before + 1)

    // A run that continues the conversation takes its title without asking the model, and its end does not rename it.
    const second = await run({ continues: first })
    assert.equal(await nameConversation(pool, second, 'owner', 'created', model('不该用到')), '回调前缀修复')
    assert.deepEqual(await stored(second), { title: '回调前缀修复', titleSource: 'generated' })
    assert.equal(calls.length, before + 1, 'no model call for a continuation')
    assert.equal(await nameConversation(pool, second, 'owner', 'first_run_ended', model('不该用到')), null, 'only the first run\'s end')

    // PR opened: the whole conversation is named again, with the PR's title as evidence.
    await pool.query(`INSERT INTO run_publications ("runId","userId","issueId","remoteUrl","remoteKey",status,"pullRequest") VALUES ($1,'owner',$2,'https://github.com/o/r','o/r','published',$3)`,
      [second, issueId, JSON.stringify({ url: 'https://github.com/o/r/pull/7', state: 'open', title: 'Keep the workspace prefix after sign-in' })])
    assert.equal(await nameConversation(pool, second, 'owner', 'pull_opened', model('登录前缀保留')), '登录前缀保留')
    assert.match(calls.at(-1)!.body, /Pull request: Keep the workspace prefix after sign-in/)
    assert.deepEqual([await stored(first), await stored(second)], [{ title: '登录前缀保留', titleSource: 'generated' }, { title: '登录前缀保留', titleSource: 'generated' }], 'every run of the chain carries it')

    // A manual rename is the title: bounded, on every run, and no trigger overwrites it.
    assert.equal(await renameConversationTitle(pool, first, 'other', '越权改名', workspaceId), null)
    assert.equal(await renameConversationTitle(pool, first, 'owner', '   ', workspaceId), null)
    assert.equal(await renameConversationTitle(pool, first, 'owner', '  我自己起的名字，特别特别特别长  ', workspaceId), '我自己起的名字，特别特别')
    assert.deepEqual([await stored(first), await stored(second)], Array(2).fill({ title: '我自己起的名字，特别特别', titleSource: 'manual' }))
    const quiet = calls.length
    for (const trigger of ['created', 'first_run_ended', 'pull_opened'] as const) assert.equal(await nameConversation(pool, second, 'owner', trigger, model('模型的名字')), null, trigger)
    assert.equal(calls.length, quiet, 'a manual title does not even ask the model')
    // A third run of the renamed conversation takes the person's title.
    const third = await run({ continues: second })
    assert.equal(await nameConversation(pool, third, 'owner', 'created', model('不该用到')), '我自己起的名字，特别特别')
    assert.deepEqual(await stored(third), { title: '我自己起的名字，特别特别', titleSource: 'manual' })
    // A rename that lands while the model is answering is kept: the write checks again.
    const racing = await run({ prompt: '导出账单 CSV' })
    assert.equal(await nameConversation(pool, racing, 'owner', 'created', async () => { await renameConversationTitle(pool, racing, 'owner', '账单导出', workspaceId); return '模型晚到的名字' }), null)
    assert.deepEqual(await stored(racing), { title: '账单导出', titleSource: 'manual' })

    const foreignWorkspace = randomUUID()
    assert.equal(await renameConversationTitle(pool, first, 'owner', 'different workspace', foreignWorkspace), null)
    const organize = (id: string, field: 'archived' | 'pinned', value: boolean) =>
      conversationOrganization(pool, 'owner', workspaceId, id, { field, value })
    assert.deepEqual(await organize(second, 'pinned', true), { archived: false, pinned: true })
    const originalPin = (await pool.query('SELECT "conversationPinnedAt" FROM agent_runs WHERE id=$1', [first])).rows[0]
    await organize(first, 'pinned', true)
    assert.deepEqual((await pool.query('SELECT "conversationPinnedAt" FROM agent_runs WHERE id=$1', [first])).rows[0], originalPin)
    assert.deepEqual(await organize(first, 'archived', true), { archived: true, pinned: true })
    assert.deepEqual(await conversationOrganization(pool, 'owner', workspaceId, third), { archived: true, pinned: true })
    for (const [actor, space] of [['other', workspaceId], ['owner', foreignWorkspace]]) {
      assert.equal(await conversationOrganization(pool, actor, space, first), null)
      assert.equal(await conversationOrganization(pool, actor, space, first, { field: 'pinned', value: false }), null)
    }
    assert.deepEqual(await organize(third, 'archived', false), { archived: false, pinned: true })
    assert.deepEqual(await organize(second, 'pinned', false), { archived: false, pinned: false })

    const unlinked = await run({ prompt: 'Needle question' })
    await pool.query(`UPDATE agent_runs SET "issueId"=NULL, "createdAt"=now()-interval '60 days' WHERE id=$1`, [unlinked])
    const botId=randomUUID(), directoryOtherBot=randomUUID()
    for (const id of [botId,directoryOtherBot]) await pool.query(`INSERT INTO bots(id,"ownerId","workspaceId",name) VALUES($1::uuid,'owner',$2,$3)`,[id,workspaceId,'QA '+id])
    const historical=Array.from({length:50},()=>randomUUID())
    await pool.query(`INSERT INTO agent_runs(id,"userId","workspaceId","agentId","botId",status,prompt,"createdAt","updatedAt")
      SELECT id,'owner',$2,$3,$4,CASE n WHEN 3 THEN 'waiting_input' WHEN 4 THEN 'running' ELSE 'succeeded' END,
        'sidebar '||n,now()-n*interval '1 day',now()-n*interval '1 day'
      FROM unnest($1::uuid[]) WITH ORDINALITY input(id,n)`,[historical,workspaceId,agentId,botId])
    // The old pin, an explicit question and a live Run outrank newer idle rows.
    await organize(historical[48],'pinned',true)
    await organize(historical[0],'archived',true)
    const sidebar=async()=> (await conversationSidebar(pool,'owner',workspaceId))[botId]
    const firstPage=await sidebar()
    assert.equal(firstPage.items.length,8); assert.equal(firstPage.more,true)
    assert.deepEqual(firstPage.items.slice(0,3).map(row=>row.id),[historical[48],historical[2],historical[3]])
    assert.ok(!firstPage.items.some(row=>row.id===historical[0]))
    const filtered=async(archived=false)=>(await conversationDirectory(pool,'owner',workspaceId,{botId,archived})).items
    assert.ok((await filtered(true)).some(row=>row.id===historical[49]),'a 50-day idle row is automatically archived')
    assert.equal((await conversationOrganization(pool,'owner',workspaceId,historical[49]))?.archived,true)
    await organize(historical[49],'archived',false)
    assert.ok((await filtered()).some(row=>row.id===historical[49]),'restore restarts the idle clock')
    await pool.query(`INSERT INTO user_preferences ("userId","archiveIdleAfterDays") VALUES ('owner',0)
      ON CONFLICT ("userId") DO UPDATE SET "archiveIdleAfterDays"=0`)
    assert.equal((await filtered()).length,49,'off keeps all 49 manually unarchived rows')
    assert.equal((await conversationDirectory(pool,'owner',workspaceId,{botId:directoryOtherBot})).items.length,0)
    assert.deepEqual(await conversationSidebar(pool,'other',workspaceId),{})
    await pool.query(`UPDATE user_preferences SET "archiveIdleAfterDays"=3 WHERE "userId"='owner'`)
    assert.equal((await sidebar()).more,false,'three days hides old idle work but preserves pinned/live/restored rows')
    await pool.query(`UPDATE user_preferences SET "archiveIdleAfterDays"=30 WHERE "userId"='owner'`)
    const search = { search: 'needle' }
    const runUnread = async () => {
      const item = (await conversationDirectory(pool, 'owner', workspaceId, search)).items.find(row => row.id === unlinked)
      return item?.kind === 'run' ? item.unread : undefined
    }
    const directory = await conversationDirectory(pool, 'owner', workspaceId, search)
    assert.deepEqual(directory.items.map(row => [row.id, row.issueId, row.title, row.state]), [[unlinked, null, 'Needle question', 'working']])
    assert.equal((directory.items[0].kind === 'run' ? directory.items[0].unread : undefined), false)
    await pool.query("UPDATE agent_runs SET \"finishedAt\"=now() WHERE id=$1", [unlinked])
    assert.equal(await runUnread(), true)
    await pool.query(`INSERT INTO conversation_reads ("userId","conversationId","runReadAt")
      SELECT 'owner','run:'||id::text,"finishedAt" FROM agent_runs WHERE id=$1`, [unlinked])
    assert.equal(await runUnread(), false)
    await pool.query(`UPDATE conversation_reads SET "manuallyUnread"=true WHERE "userId"='owner' AND "conversationId"='run:'||$1`, [unlinked])
    assert.equal(await runUnread(), true)
    assert.deepEqual((await conversationDirectory(pool, 'other', workspaceId, search)).items, [])
    assert.deepEqual((await conversationDirectory(pool, 'owner', foreignWorkspace, search)).items, [])
    assert.deepEqual((await conversationDirectory(pool, 'owner', workspaceId, { ...search, state: 'failed' })).items, [])
    await pool.query("UPDATE agent_runs SET status='failed' WHERE id=$1", [unlinked])
    assert.equal((await conversationDirectory(pool, 'owner', workspaceId, { ...search, state: 'failed' })).items[0].id, unlinked)
    await organize(unlinked, 'pinned', true)
    assert.equal((await conversationDirectory(pool, 'owner', workspaceId, {})).items[0].id, unlinked)
    await organize(unlinked, 'archived', true)
    assert.deepEqual((await conversationDirectory(pool, 'owner', workspaceId, search)).items, [])
    assert.equal((await conversationDirectory(pool, 'owner', workspaceId, { ...search, archived: true })).items[0].id, unlinked)

    const bot = randomUUID(), secondBot = randomUUID(), foreignBot = randomUUID()
    await pool.query(`INSERT INTO bots (id,"ownerId","workspaceId",name)
      VALUES ($1,'owner',$4,'Coordinator'), ($2,'owner',$4,'Writer'), ($3,'other',$4,'Private')`, [bot, secondBot, foreignBot, workspaceId])
    await pool.query(`INSERT INTO coordinator_bots ("ownerId","workspaceId","botId") VALUES ('owner',$1,$2)`, [workspaceId, bot])
    const authorized = groupDirectory({
      async activeUsers(space, ids) {
        return (await pool.query(`SELECT "userId" AS id FROM mikka_workspace_members WHERE "workspaceId"=$1 AND status='active' AND "userId"=ANY($2)`, [space, ids])).rows.map(row => row.id)
      },
      async ownedAgents() { return [] },
      async ownedBots(space, owner, ids) {
        return (await pool.query('SELECT id FROM bots WHERE "workspaceId"=$1 AND "ownerId"=$2 AND id=ANY($3)', [space, owner, ids])).rows.map(row => row.id)
      },
    })
    const groupApi = (request: Partial<GroupRequest>) => handleGroup(pool, authorized, {
      userId: 'owner', workspaceId, method: 'POST', resource: 'conversations', host: 'fixture.local', origin: null, ...request,
    }, true)
    const createChat = (ids: string[], space = workspaceId) => groupApi({ body: JSON.stringify({
      purpose: 'conversation', workspaceId: space, title: 'Named independent chat', leadBotId: ids[0],
      members: ids.map(memberId => ({ memberType: 'bot', memberId })),
    }) })
    for (const bad of [await createChat([foreignBot]), await createChat([bot], foreignWorkspace)]) assert.equal(bad.status, 404)
    const simple = await createChat([bot]), multi = await createChat([bot, secondBot])
    assert.equal(simple.status, 201)
    assert.equal(multi.status, 201)
    const id = (simple.body as { id: string }).id, multiId = (multi.body as { id: string }).id
    assert.notEqual(id, multiId)
    assert.equal((await groupApi({ id, method: 'POST', resource: 'members', body: JSON.stringify({ memberType: 'user', memberId: 'other' }) })).status, 422)
    assert.equal((await groupApi({ id, resource: 'messages', body: JSON.stringify({ body: 'Keep this first message', requestId: randomUUID(), expectedOwnerId: 'owner', expectedWorkspaceId: workspaceId }) })).status, 201)
    const history = await groupApi({ id, method: 'GET', resource: 'messages' })
    assert.equal(history.status, 200)
    assert.deepEqual((history.body as { messages: { body: string }[] }).messages.map(row => row.body), ['Keep this first message'])
    assert.equal((await groupApi({ id, method: 'GET', resource: 'messages', userId: 'other' })).status, 404)
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM group_turns WHERE "conversationId"=$1 AND status='queued'`, [id])).rows[0].count, 1)
    const named = { search: 'independent chat' }
    const namedPage = await conversationDirectory(pool, 'owner', workspaceId, named)
    assert.deepEqual(new Set(namedPage.items.map(row => row.id)), new Set([id, multiId]))
    assert.ok(namedPage.items.every(row => row.kind === 'chat' && row.issueId === null))
    assert.deepEqual((await conversationDirectory(pool, 'owner', workspaceId, { ...named, botId: secondBot })).items.map(row => row.id), [multiId])
    assert.deepEqual((await conversationSidebar(pool, 'owner', workspaceId))[secondBot].items.map(row => [row.kind, row.id]), [['chat', multiId]])
    assert.equal((await conversationSidebar(pool, 'other', workspaceId))[bot], undefined)
    assert.deepEqual((await conversationDirectory(pool, 'other', workspaceId, named)).items, [])
    assert.deepEqual((await conversationDirectory(pool, 'owner', foreignWorkspace, named)).items, [])
    const { standaloneOrganization, renameStandalone, regenerateStandalone } = await import('@/lib/standalone-chat-controls')
    const change = (field: 'pinned' | 'archived', value: boolean) => standaloneOrganization(pool, id, 'owner', workspaceId, { field, value })
    assert.deepEqual(await change('pinned', true), { pinned: true, archived: false })
    assert.equal((await conversationDirectory(pool, 'owner', workspaceId, named)).items[0].id, id)
    assert.deepEqual(await change('archived', true), { pinned: true, archived: true })
    assert.deepEqual((await conversationDirectory(pool, 'owner', workspaceId, named)).items.map(row => row.id), [multiId])
    assert.deepEqual((await conversationDirectory(pool, 'owner', workspaceId, { ...named, archived: true })).items.map(row => row.id), [id])
    assert.deepEqual(await change('archived', false), { pinned: true, archived: false })
    assert.deepEqual(await change('pinned', false), { pinned: false, archived: false })
    assert.equal(await renameStandalone(pool, id, 'other', workspaceId, 'unowned'), undefined)
    assert.equal(await standaloneOrganization(pool, id, 'owner', foreignWorkspace), null)
    const revised = await regenerateStandalone(pool, id, 'owner', workspaceId, async (actor, body, scope) => {
      assert.equal(actor, 'owner')
      assert.equal(scope, workspaceId)
      assert.equal(body.body, 'Keep this first message')
      return 'Generated chat'
    })
    assert.deepEqual(revised, { title: 'Generated chat', regenerated: true })
    await regenerateStandalone(pool, id, 'owner', workspaceId, async () => {
      await renameStandalone(pool, id, 'owner', workspaceId, 'Manual chat')
      return 'Stale answer'
    })
    assert.deepEqual(await regenerateStandalone(pool, id, 'owner', workspaceId, async () => null), { title: 'Manual chat', regenerated: false })
    assert.equal(await regenerateStandalone(pool, id, 'other', workspaceId, async () => { throw Error('unauthorized model call') }), null)

    // A member's existing group receipt and explicit unread mark also appear in both conversation surfaces.
    const chatUnread = async () => (await conversationDirectory(pool, 'owner', workspaceId, {search: 'Manual chat'})).items[0].unread
    assert.equal(await chatUnread(), false, 'the owner authored the only message')
    await pool.query(`INSERT INTO chat_preferences ("userId","chatKey","markedUnread") VALUES ('owner',$1,true)`, [id])
    assert.equal(await chatUnread(), true)
    assert.equal((await conversationSidebar(pool,'owner',workspaceId))[bot].items.find(row => row.id === id)?.unread, true)
    await pool.query(`UPDATE chat_preferences SET "markedUnread"=false WHERE "userId"='owner' AND "chatKey"=$1`, [id])

    // Both storage kinds use one page boundary even when activity timestamps coincide.
    const pageRun = await run({prompt:'Mixed page boundary'})
    const mixed = await pool.query(`WITH created AS (
      INSERT INTO conversations (id,"workspaceId",kind,title,"createdBy","creationPurpose","createdAt")
      SELECT gen_random_uuid(), $1, 'group', 'Mixed page boundary ' || n, 'owner', 'conversation', '2026-01-01T00:00:00Z'
      FROM generate_series(1,100) n RETURNING id
    ) INSERT INTO conversation_members ("conversationId","memberType","memberId",role)
      SELECT id,'user','owner','owner' FROM created RETURNING "conversationId" AS id`, [workspaceId])
    await pool.query(`UPDATE agent_runs SET "createdAt"='2026-01-01T00:00:00Z',"updatedAt"='2026-01-01T00:00:00Z' WHERE id=$1`, [pageRun])
    const mixedInput = {search:'mixed page boundary',archived:'any' as const}
    const firstMixed = await conversationDirectory(pool,'owner',workspaceId,mixedInput)
    assert.equal(firstMixed.items.length, 100)
    assert.ok(firstMixed.cursor)
    const remaining = await conversationDirectory(pool,'owner',workspaceId,{...mixedInput,cursor:firstMixed.cursor})
    assert.equal(remaining.cursor, null)
    assert.equal(remaining.items.length, 1)
    assert.deepEqual(new Set([...firstMixed.items,...remaining.items].map(row => row.id)),new Set([pageRun,...mixed.rows.map(row=>row.id)]))
    // The sidebar, header and archive filter use the same idle clock for a named chat.
    await pool.query(`UPDATE user_preferences SET "archiveIdleAfterDays"=3 WHERE "userId"='owner'`)
    await pool.query(`UPDATE conversations SET "createdAt"=now()-interval '10 days',"conversationRestoredAt"=NULL WHERE id=$1`, [id])
    await pool.query(`UPDATE conversation_messages SET "createdAt"=now()-interval '10 days' WHERE "conversationId"=$1`, [id])
    await pool.query(`UPDATE group_turns SET status='complete' WHERE "conversationId"=$1`, [id])
    const visibleInSidebar = async () => (await conversationSidebar(pool,'owner',workspaceId))[bot]?.items.some(row => row.id === id) ?? false
    assert.deepEqual(await standaloneOrganization(pool,id,'owner',workspaceId), {archived:true,pinned:false})
    assert.equal(await visibleInSidebar(), false)
    assert.deepEqual(await change('pinned',true), {archived:false,pinned:true})
    assert.equal(await visibleInSidebar(), true)
    assert.deepEqual(await change('archived',true), {archived:true,pinned:true})
    assert.equal(await visibleInSidebar(), false)
    assert.deepEqual(await change('archived',false), {archived:false,pinned:true})
    assert.deepEqual(await change('pinned',false), {archived:false,pinned:false})
    assert.equal(await visibleInSidebar(), true)


    assert.deepEqual((await pool.query(`SELECT "botId" FROM coordinator_bots WHERE "ownerId"='owner' AND "workspaceId"=$1`, [workspaceId])).rows, [{ botId: bot }])
    // The publication on the second attempt resolves to the root. Counts and state come from the webhook store.
    const delivered = () => conversationDirectory(pool, 'owner', workspaceId, { archived: 'any', pullState: 'linked' })
    const published = (await delivered()).items.find(item => item.id === first)
    assert.equal(published?.pulls[0].state, 'open')
    await pool.query(`UPDATE run_publications SET "pullRequest"="pullRequest" || '{"state":"merged","additions":12,"deletions":4}'::jsonb WHERE "runId"=$1`, [second])
    assert.deepEqual((await conversationDirectory(pool, 'owner', workspaceId, { pullState: 'open' })).items, [])
    assert.deepEqual((await delivered()).items[0].pulls, [{
      title: 'Keep the workspace prefix after sign-in', url: 'https://github.com/o/r/pull/7', state: 'merged', additions: 12, deletions: 4,
    }])
    await organize(first, 'archived', true)
    assert.equal((await delivered()).items[0].id, first, 'the PR destination includes archived conversations')
    for (const [reader, space] of [['other', workspaceId], ['owner', foreignWorkspace]]) {
      assert.deepEqual((await conversationDirectory(pool, reader, space, { archived: 'any', pullState: 'merged' })).items, [])
    }

    // Regenerate is the person asking for a generated title again.
    assert.equal(await nameConversation(pool, first, 'owner', 'regenerate', model('登录回调与前缀')), '登录回调与前缀')
    assert.deepEqual([await stored(first), await stored(second), await stored(third)], Array(3).fill({ title: '登录回调与前缀', titleSource: 'generated' }))
    assert.equal(await renameConversationTitle(pool, first, 'owner', 'Initial manual', workspaceId), 'Initial manual')
    assert.equal(await nameConversation(pool, first, 'owner', 'regenerate', async () => {
      assert.equal(await renameConversationTitle(pool, first, 'owner', 'Later manual', workspaceId), 'Later manual')
      return 'Stale generated title'
    }), null)
    assert.deepEqual(await stored(first), { title: 'Later manual', titleSource: 'manual' })
    assert.equal(await renameConversationTitle(pool, first, 'owner', 'Later manual', workspaceId), 'Later manual')
    const revoked = await run({ prompt: 'A pending workspace title' })
    const suspend = () => pool.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"='owner'`, [workspaceId])
    assert.equal(await nameConversation(pool, revoked, 'owner', 'created', async () => {
      await suspend()
      return 'Late workspace reply'
    }), null, 'membership revoked while the model was answering')
    assert.equal(await nameConversation(pool, revoked, 'owner', 'created', async () => {
      assert.fail('revoked workspace must not invoke the model')
    }), null)
    assert.equal(await renameConversationTitle(pool, revoked, 'owner', 'No access', workspaceId), null)
    assert.deepEqual(await stored(revoked), { title: null, titleSource: null })
  } finally {
    await dropTestDatabase(adminPool, name, pool)
    await adminPool.end()
  }
})
