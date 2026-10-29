import assert from 'node:assert/strict'
import { readdirSync,readFileSync } from 'node:fs'
import test from 'node:test'
import { orderMigrations } from '../scripts/migration-order.mjs'
import { createHash } from 'node:crypto'
const manifest=JSON.parse(readFileSync(new URL('../docs/integration/migration-manifest-20261029.json',import.meta.url)))
const dir=new URL('../drizzle/',import.meta.url)
const names=readdirSync(dir).filter(n=>n.endsWith('.sql'))
test('one canonical Factory migration per component, after main and before consumers, with unchanged shared SQL',()=>{
  const ordered=orderMigrations(names)
  let previous=ordered.indexOf(manifest.mainLatestMigration)
  // The refreshed main migration need not be imported with unrelated main code.
  for (const entry of manifest.shared) assert.ok(entry.file > manifest.mainLatestMigration)
  for(const entry of manifest.shared){
    for(const old of entry.obsolete)assert.ok(!names.includes(old),`Duplicate/obsolete migration: ${old}`)
    const pattern=entry.issue===191?/_run_dispatch_keys\.sql$/:/_factory_192_stages\.sql$/
    assert.deepEqual(names.filter(n=>pattern.test(n)),[entry.file])
    assert.ok(ordered.indexOf(entry.file)>previous)
    previous=ordered.indexOf(entry.file)
    assert.equal(createHash('sha256').update(readFileSync(new URL(entry.file,dir))).digest('hex'),entry.sha256)
  }
  for(const entry of manifest.downstream){
    for(const old of entry.obsolete ?? []) assert.ok(!names.includes(old))
    if(entry.from)assert.ok(!names.includes(entry.from),`Use the coordinator's canonical rename for #${entry.issue}`)
    if(entry.migration && names.includes(entry.migration)){
      assert.ok(entry.migration > manifest.mainLatestMigration)
      assert.equal(names.filter(n=>n.endsWith(entry.migration.slice(14))).length,1)
      assert.equal(createHash('sha256').update(readFileSync(new URL(entry.migration,dir))).digest('hex'),entry.sha256)
      assert.ok(ordered.indexOf(entry.migration)>previous)
      previous=ordered.indexOf(entry.migration)
    }
  }
})

test('Skill assignment migration follows its proposal table and immutable trigger prerequisites',()=>{
  const ordered=orderMigrations(names)
  const base=names.filter(name=>name.endsWith('_self_improvement.sql'))
  const assignments=names.filter(name=>name.endsWith('_improvement_skill_assignments.sql'))
  assert.equal(base.length,1)
  assert.equal(assignments.length,1)
  assert.ok(ordered.indexOf(assignments[0])>ordered.indexOf(base[0]))
})
