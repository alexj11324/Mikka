import { seedFixtureWorkspace } from './helpers/task-workspace'
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { Pool } from 'pg'
import { orderMigrations } from '../scripts/migration-order.mjs'
import { dropTestDatabase } from './support/drop-test-database'
import { conversationDirectory } from '../lib/conversation-directory'
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
  await adminPool.query(`CREATE DATABASE ${name} TEMPLATE template0`)
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
    const model = (answer: string | null) => async (_owner: string, text: { title: string; body: string }) => { calls.push(text); return answer }

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
    const search = { search: 'needle' }
    const directory = await conversationDirectory(pool, 'owner', workspaceId, search)
    assert.deepEqual(directory.items.map(row => [row.id, row.issueId, row.title, row.state]), [[unlinked, null, 'Needle question', 'working']])
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

    // Regenerate is the person asking for a generated title again.
    assert.equal(await nameConversation(pool, first, 'owner', 'regenerate', model('登录回调与前缀')), '登录回调与前缀')
    assert.deepEqual([await stored(first), await stored(second), await stored(third)], Array(3).fill({ title: '登录回调与前缀', titleSource: 'generated' }))
  } finally {
    await dropTestDatabase(adminPool, name, pool)
    await adminPool.end()
  }
})
