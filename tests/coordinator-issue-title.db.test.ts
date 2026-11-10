import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { disposableDatabase } from './helpers/e2e-target.mjs'
import { seedCoordinator } from './support/coordinator-bot'

const connection = process.env.E2E_DATABASE_URL
const required = process.env.REQUIRE_DB === '1'
const enabled = disposableDatabase()
if (required && !enabled) throw new Error('Coordinator task title requires a loopback *_e2e database')
if (enabled) {
  assert.equal(process.env.MIKKA_DATABASE_URL, connection)
  assert.equal(process.env.DATABASE_URL, connection)
}

test('a typed title stays full while its derived short title obeys the navigation limit, whatever the model passes', { skip: !enabled }, async () => {
  const { db, pool } = await import('../lib/db')
  const { eq } = await import('drizzle-orm')
  const { issues, coordinatorEvents } = await import('../lib/db/schema')
  const { createIssueFromRequest } = await import('../lib/coordinator/issue-create')
  const owner = `coordinator-title-${randomUUID()}`
  await pool.query('insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,$1,$2,false,now(),now())', [owner, `${owner}@example.invalid`])
  const bot = await seedCoordinator(owner)
  const event = async (payload: Record<string, unknown>) => {
    const id = randomUUID()
    await db.insert(coordinatorEvents).values({ id, userId: owner, botId: bot.botId, kind: 'user_message', dedupeKey: id, payload: { text: 'Please fix the redirect.', ...payload } })
    return id
  }
  const read = async (issueId: string) => (await db.select({ title: issues.title, shortTitle: issues.shortTitle, shortTitleFrom: issues.shortTitleFrom }).from(issues).where(eq(issues.id, issueId)))[0]
  try {
    // The person typed a title: it wins over the model's, and lists show it as typed.
    const typed = await event({ taskTitle: '修复登录后回跳丢前缀' })
    const first = await createIssueFromRequest(owner, { sourceEventId: typed, title: 'The model\'s own longer title for this task' })
    assert.equal(first.title, '修复登录后回跳丢前缀')
    assert.deepEqual(await read(first.issueId), { title: '修复登录后回跳丢前缀', shortTitle: '修复登录后回跳丢前缀', shortTitleFrom: '修复登录后回跳丢前缀' })
    // A replay returns the same task and cannot rename it.
    assert.deepEqual(await createIssueFromRequest(owner, { sourceEventId: typed, title: 'Replay cannot rename' }), first)

    const longTitle = '修复登录后回跳丢前缀并保留工作区路径和查询参数'
    const longEvent = await event({ taskTitle: longTitle })
    const long = await createIssueFromRequest(owner, { sourceEventId: longEvent, title: 'Ignore this model title' })
    assert.equal(long.title, longTitle)
    assert.deepEqual(await read(long.issueId), { title: longTitle, shortTitle: [...longTitle].slice(0, 12).join(''), shortTitleFrom: longTitle })

    // No title typed: the model's title is used and no short title is set here (the short-title job writes it).
    const untitled = await event({})
    const second = await createIssueFromRequest(owner, { sourceEventId: untitled, title: '  Implement requested change  ' })
    assert.equal(second.title, 'Implement requested change')
    assert.deepEqual(await read(second.issueId), { title: 'Implement requested change', shortTitle: null, shortTitleFrom: null })

    // A title in the event that is not valid (too long, several lines) is ignored; the model's title is used.
    for (const invalid of ['x'.repeat(61), 'two\nlines', '   ', 7]) {
      const bad = await event({ taskTitle: invalid })
      const created = await createIssueFromRequest(owner, { sourceEventId: bad, title: 'Model title' })
      assert.equal(created.title, 'Model title', `ignores ${JSON.stringify(invalid)}`)
      assert.equal((await read(created.issueId)).shortTitle, null)
    }
  } finally {
    await pool.query('delete from issues where "userId"=$1', [owner])
    await pool.query('delete from coordinator_events where "userId"=$1', [owner])
  }
})
