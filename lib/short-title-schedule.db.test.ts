import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { sql } from 'drizzle-orm'
import { disposableDatabase } from '../tests/helpers/e2e-target.mjs'
import { compactTaskTitle } from './short-title'

// Production, 2026-11-06: the Coordinator created a task inside its transaction, and the short-title job, run after the
// COMMIT, still saw that transaction as its ambient database. Its first read went to the released writer and failed.
const url = process.env.E2E_DATABASE_URL
if (process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true') assert.ok(url, 'CI requires real isolated PostgreSQL')
if (url) assert.ok(disposableDatabase(process.env, url), 'loopback *_e2e only')
if (process.env.REQUIRE_DB === '1' && !url) throw new Error('Short-title storage requires a loopback *_e2e database')

let seen: { inTransaction: boolean; read: boolean } | null = null
let finish!: () => void
const finished = new Promise<void>(resolve => { finish = resolve })
mock.module(new URL('./short-title-server.ts', import.meta.url).href, { namedExports: { writeShortTitle: async () => {
  const { db, inDatabaseTransaction } = await import('./db/request-scope')
  const inTransaction = inDatabaseTransaction()
  let read = true
  try { await db.execute(sql`select 1`) } catch { read = false }
  seen = { inTransaction, read }
  finish()
} } })

test('the short-title job runs after COMMIT on its own connection, not on the released writer', { skip: !url, timeout: 30_000 }, async () => {
  const { db, pool, withDatabaseClient } = await import('./db/request-scope')
  const { scheduleShortTitle } = await import('./short-title-schedule')
  const tx = await pool.connect()
  try {
    await tx.query('BEGIN')
    await withDatabaseClient(tx, async () => {
      scheduleShortTitle(db, randomUUID(), 'short-title-fixture')
      await tx.query('COMMIT')
    })
  } finally { tx.release() }
  await finished
  assert.deepEqual(seen, { inTransaction: false, read: true })
})

test('PG17 compact short-title storage keeps full tasks and accepts old writers', { skip: !url }, async t => {
  const { Client } = await import('pg')
  const client = new Client({ connectionString: url })
  await client.connect()
  const schema = `short_title_${randomUUID().replaceAll('-', '')}`
  t.after(async () => {
    await client.query('ROLLBACK')
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await client.end()
  })
  const version = Number((await client.query('show server_version_num')).rows[0].server_version_num)
  assert.ok(version >= 170000 && version < 180000, 'requires PostgreSQL 17')
  await client.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`)
  await client.query('CREATE TABLE issues (id text PRIMARY KEY,title varchar(200) NOT NULL,content jsonb NOT NULL,"shortTitle" varchar(60),"shortTitleFrom" varchar(200))')
  const migration = readFileSync(new URL('../drizzle/20261110140000_issue_short_title_bounds.sql', import.meta.url), 'utf8')
  const title = '完整标题 ' + '保持完整'.repeat(35)
  const content = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Keep every detail. '.repeat(50) }] }] }
  const insert = (id: string, short: string | null, full = title) => client.query('INSERT INTO issues VALUES ($1,$2,$3,$4,$2)', [id, full, JSON.stringify(content), short])
  const read = async (id: string) => (await client.query('SELECT title,content,"shortTitle","shortTitleFrom" FROM issues WHERE id=$1', [id])).rows[0]

  await insert('legacy-bad', '界'.repeat(13))
  await insert('legacy-good', 'Keep the full task')
  await insert('legacy-null', null)
  assert.equal((await read('legacy-bad')).shortTitle, '界'.repeat(13), 'the previous schema really stores the bad derived cache')
  await client.query(migration)

  await t.test('migration clears only bad derived caches and safely reruns', async () => {
    assert.deepEqual(await read('legacy-bad'), { title, content, shortTitle: null, shortTitleFrom: null })
    assert.deepEqual(await read('legacy-good'), { title, content, shortTitle: 'Keep the full task', shortTitleFrom: title })
    assert.deepEqual(await read('legacy-null'), { title, content, shortTitle: null, shortTitleFrom: title })
    const before = (await client.query('SELECT * FROM issues ORDER BY id')).rows
    await client.query(migration)
    assert.deepEqual((await client.query('SELECT * FROM issues ORDER BY id')).rows, before)
    const constraint = (await client.query("SELECT convalidated FROM pg_constraint WHERE conrelid='issues'::regclass AND conname='issues_short_title_compact'")).rows
    assert.deepEqual(constraint, [{ convalidated: true }])
  })

  await t.test('exact word, CJK and Unicode-codepoint boundaries remain valid', async () => {
    const valid = ['one two three four five six', 'a'.repeat(60), '😀'.repeat(60), '界'.repeat(12), '界' + '😀'.repeat(11)]
    for (const codepoint of [0x3040, 0x30ff, 0x3400, 0x9fff, 0xf900, 0xfaff, 0xac00, 0xd7af]) valid.push(String.fromCodePoint(codepoint).repeat(12))
    for (const [index, short] of valid.entries()) {
      await insert(`valid-${index}`, short)
      assert.deepEqual(await read(`valid-${index}`), { title, content, shortTitle: short, shortTitleFrom: title })
    }
  })

  await t.test('all JS whitespace outside single ASCII separators is rejected as a cache', async () => {
    const whitespace = [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0xa0, 0x1680, ...Array.from({ length: 11 }, (_, i) => 0x2000 + i), 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]
    const invalid = ['', ' ', ' leading', 'trailing ', 'two  spaces', 'one two three four five six seven', '界'.repeat(13), '界' + '😀'.repeat(12), ...whitespace.map(codepoint => `one${String.fromCodePoint(codepoint)}two`)]
    for (const codepoint of [0x3040, 0x30ff, 0x3400, 0x9fff, 0xf900, 0xfaff, 0xac00, 0xd7af]) invalid.push(String.fromCodePoint(codepoint).repeat(13))
    for (const [index, short] of invalid.entries()) {
      const id = `invalid-${index}`
      await insert(id, short)
      assert.deepEqual(await read(id), { title, content, shortTitle: null, shortTitleFrom: null }, `invalid cache ${JSON.stringify(short)}`)
      const normalized = compactTaskTitle({ title: short })
      if (normalized) {
        const valid = (await client.query('SELECT mikka_issue_short_title_valid($1) AS valid', [normalized])).rows[0].valid
        assert.equal(valid, true, `the database accepts the application normalizer's ${JSON.stringify(normalized)}`)
      }
    }
  })

  await t.test('UPDATE clears only the derived cache, and a legacy typed writer still commits', async () => {
    await client.query('UPDATE issues SET "shortTitle"=$2,"shortTitleFrom"=$3 WHERE id=$1', ['legacy-good', '界'.repeat(13), title])
    assert.deepEqual(await read('legacy-good'), { title, content, shortTitle: null, shortTitleFrom: null })
    const legacyTyped = '修复登录后的回跳并保留所有完整描述'.repeat(2)
    assert.ok([...legacyTyped].length > 12 && [...legacyTyped].length <= 60)
    await client.query('BEGIN')
    await insert('old-writer', legacyTyped, legacyTyped)
    await insert('same-transaction', 'Committed')
    await client.query('COMMIT')
    assert.deepEqual(await read('old-writer'), { title: legacyTyped, content, shortTitle: null, shortTitleFrom: null })
    assert.equal((await read('same-transaction')).shortTitle, 'Committed')
  })

  await t.test('the CHECK rejects a bad cache even with its compatibility trigger disabled', async () => {
    await client.query('ALTER TABLE issues DISABLE TRIGGER issues_short_title_normalize')
    try {
      await assert.rejects(insert('check-refused', '界'.repeat(13)), { code: '23514', constraint: 'issues_short_title_compact' })
    } finally { await client.query('ALTER TABLE issues ENABLE TRIGGER issues_short_title_normalize') }
  })

  await t.test('native varchar hard limits remain 60 and 200, without truncating full titles', async () => {
    assert.equal((await client.query('SELECT mikka_issue_short_title_valid($1) AS valid', ['a'.repeat(61)])).rows[0].valid, false)
    // PostgreSQL applies typemod before BEFORE triggers. Old writers were already
    // limited to 60; values over that cap retain the native error, not silent truncation.
    await assert.rejects(insert('varchar-61', 'a'.repeat(61)), { code: '22001' })
    await assert.rejects(client.query('INSERT INTO issues VALUES ($1,$2,$3,$4,$5)', ['source-201', title, JSON.stringify(content), 'Valid', 's'.repeat(201)]), { code: '22001' })
    const full = 'f'.repeat(200)
    await insert('full-title-200', 'Full task', full)
    assert.deepEqual(await read('full-title-200'), { title: full, content, shortTitle: 'Full task', shortTitleFrom: full })
  })
})
