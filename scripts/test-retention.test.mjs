import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { MIGRATION_HISTORY } from './migration-history.mjs'
import { assertRetainOnlySql, blockDestructiveFixture } from './test-retention.mjs'

test('retention preflight blocks destructive fixtures and gives no deletion grant', () => {
  for (const sql of ['DROP TABLE x','DELETE FROM x','TRUNCATE x','DO $$ BEGIN EXECUTE \'drop table x\'; END $$'])
    assert.throws(() => assertRetainOnlySql(sql), /Test pending/)
  assert.throws(() => blockDestructiveFixture('historical replay'), /Resources must be retained/)
  assert.doesNotThrow(() => assertRetainOnlySql('SELECT 1'))
  for (const name of Object.keys(MIGRATION_HISTORY)) {
    const sql=readFileSync(new URL('../drizzle/'+name,import.meta.url),'utf8')
    assert.doesNotThrow(()=>assertRetainOnlySql(sql,name))
  }
})
