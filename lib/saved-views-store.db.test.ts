import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { isE2eTarget } from '../tests/helpers/e2e-target.mjs'
import { deleteSavedView, listSavedViews, saveView } from './saved-views-store'
import { listPullPins, MAX_PULL_PINS, setPullPins } from './pull-pins'
import { MAX_SAVED_VIEWS } from './saved-views'

// drizzle/20261120045013: a person's saved list views and PR pins, against the migrated
// isolated database. Each row belongs to one person in one workspace; nothing crosses.
const target = process.env.E2E_DATABASE_URL
const valid = isE2eTarget(target) && target === process.env.MIKKA_DATABASE_URL
if (process.env.REQUIRE_DB === '1' && !valid) throw new Error('Saved view tests require a matching isolated loopback _e2e URL')

test('saved views and PR pins stay with their owner and workspace, replace by name and stop at their limits', { skip: !valid }, async t => {
  const pool = new Pool({ connectionString: target, max: 5 })
  const alex = `views-alex-${randomUUID()}`, dana = `views-dana-${randomUUID()}`
  const here = randomUUID(), there = randomUUID()
  try {
    await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,'A',$2,true,now(),now()),($3,'D',$4,true,now(),now())`,
      [alex, `${alex}@example.invalid`, dana, `${dana}@example.invalid`])

    await t.test('a view is saved, replaced by its name, listed per scope and deleted only by its owner', async () => {
      const first = await saveView(pool, alex, { workspaceId: here, scope: 'pulls', name: ' Mine ', filters: { view: 'open', author: 'alex' } })
      assert.ok(first)
      assert.equal(first.name, 'Mine')
      const again = await saveView(pool, alex, { workspaceId: here, scope: 'pulls', name: 'Mine', filters: { view: 'merged' } })
      assert.equal(again?.id, first.id, 'the same name replaces the view rather than adding one')
      assert.deepEqual(again?.filters, { view: 'merged' })
      await saveView(pool, alex, { workspaceId: here, scope: 'threads', name: 'Mine', filters: { automation: randomUUID() } })
      assert.deepEqual((await listSavedViews(pool, alex, here, 'pulls')).map(view => [view.name, view.filters]), [['Mine', { view: 'merged' }]])
      assert.equal((await listSavedViews(pool, alex, here, 'threads')).length, 1)
      assert.deepEqual(await listSavedViews(pool, alex, there, 'pulls'), [], 'another workspace sees none of them')
      assert.deepEqual(await listSavedViews(pool, dana, here, 'pulls'), [], 'another person sees none of them')
      assert.equal(await deleteSavedView(pool, dana, here, first.id), false)
      assert.equal(await deleteSavedView(pool, alex, there, first.id), false)
      assert.equal(await deleteSavedView(pool, alex, here, first.id), true)
      assert.equal(await deleteSavedView(pool, alex, here, first.id), false)
    })

    await t.test('the database refuses a scope or name the reader would not accept', async () => {
      await assert.rejects(pool.query(`INSERT INTO saved_views(id,"ownerId","workspaceId",scope,name,filters) VALUES($1,$2,$3,'bots','x','{}')`, [randomUUID(), alex, here]), /check/i)
      await assert.rejects(pool.query(`INSERT INTO saved_views(id,"ownerId","workspaceId",scope,name,filters) VALUES($1,$2,$3,'pulls','  ','{}')`, [randomUUID(), alex, here]), /check/i)
      await assert.rejects(pool.query(`INSERT INTO saved_views(id,"ownerId","workspaceId",scope,name,filters) VALUES($1,$2,$3,'pulls','x','[]')`, [randomUUID(), alex, here]), /check/i)
      await assert.rejects(saveView(pool, alex, { workspaceId: here, scope: 'pulls', name: 'big', filters: { text: 'x'.repeat(5000) } }))
    })

    await t.test('a list holds at most MAX_SAVED_VIEWS views; renaming an existing one still works when full', async () => {
      for (let index = 0; index < MAX_SAVED_VIEWS; index++)
        assert.ok(await saveView(pool, dana, { workspaceId: here, scope: 'tasks', name: `v${index}`, filters: { index } }))
      assert.equal(await saveView(pool, dana, { workspaceId: here, scope: 'tasks', name: 'one more', filters: {} }), null)
      assert.deepEqual((await saveView(pool, dana, { workspaceId: here, scope: 'tasks', name: 'v0', filters: { index: -1 } }))?.filters, { index: -1 })
      assert.equal((await listSavedViews(pool, dana, here, 'tasks')).length, MAX_SAVED_VIEWS)
    })

    await t.test('pins are stored by PR key, toggled per person and workspace, and stop at MAX_PULL_PINS', async () => {
      const url = 'https://github.com/Acme/App/pull/7'
      assert.deepEqual(await setPullPins(pool, alex, { workspaceId: here, urls: [url, url + '/'], pinned: true }), ['https://github.com/acme/app/pull/7'])
      assert.deepEqual(await setPullPins(pool, alex, { workspaceId: here, urls: [url], pinned: true }), ['https://github.com/acme/app/pull/7'], 'pinning twice changes nothing')
      assert.deepEqual(await listPullPins(pool, dana, here), [])
      assert.deepEqual(await listPullPins(pool, alex, there), [])
      assert.deepEqual(await setPullPins(pool, alex, { workspaceId: here, urls: [url], pinned: false }), [])
      await assert.rejects(setPullPins(pool, alex, { workspaceId: here, urls: ['https://example.com/a/b/pull/1'], pinned: true }))
      const many = Array.from({ length: MAX_PULL_PINS }, (_, index) => `https://github.com/acme/app/pull/${index + 1}`)
      for (let index = 0; index < many.length; index += 100)
        assert.notEqual(await setPullPins(pool, alex, { workspaceId: there, urls: many.slice(index, index + 100), pinned: true }), 'pinLimit')
      assert.equal(await setPullPins(pool, alex, { workspaceId: there, urls: ['https://github.com/acme/app/pull/999'], pinned: true }), 'pinLimit')
      assert.equal((await listPullPins(pool, alex, there)).length, MAX_PULL_PINS)
      assert.notEqual(await setPullPins(pool, alex, { workspaceId: there, urls: [many[0]], pinned: true }), 'pinLimit', 'an existing pin is not over the limit')
    })

    await t.test('concurrent writes at the edge of a limit: exactly one passes it', async () => {
      const space = randomUUID()
      const filled = Array.from({ length: MAX_PULL_PINS - 1 }, (_, index) => `https://github.com/acme/edge/pull/${index + 1}`)
      for (let index = 0; index < filled.length; index += 100)
        await setPullPins(pool, alex, { workspaceId: space, urls: filled.slice(index, index + 100), pinned: true })
      const racing = await Promise.all([1001, 1002, 1003].map(n =>
        setPullPins(pool, alex, { workspaceId: space, urls: [`https://github.com/acme/edge/pull/${n}`], pinned: true })))
      assert.equal(racing.filter(result => result !== 'pinLimit').length, 1)
      assert.equal((await listPullPins(pool, alex, space)).length, MAX_PULL_PINS)
      for (let index = 0; index < MAX_SAVED_VIEWS - 1; index++)
        await saveView(pool, alex, { workspaceId: space, scope: 'threads', name: `edge ${index}`, filters: {} })
      const saves = await Promise.all(['a', 'b', 'c'].map(name => saveView(pool, alex, { workspaceId: space, scope: 'threads', name, filters: {} })))
      assert.equal(saves.filter(Boolean).length, 1)
      assert.equal((await listSavedViews(pool, alex, space, 'threads')).length, MAX_SAVED_VIEWS)
    })

    await t.test('deleting the person removes their rows', async () => {
      await pool.query('DELETE FROM "user" WHERE id=$1', [dana])
      assert.equal((await pool.query('SELECT 1 FROM saved_views WHERE "ownerId"=$1', [dana])).rowCount, 0)
    })
  } finally {
    await pool.query('DELETE FROM "user" WHERE id = ANY($1)', [[alex, dana]])
    await pool.end()
  }
})
