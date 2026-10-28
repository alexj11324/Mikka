import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'
import { MIGRATION_HISTORY, alreadyApplied } from './migration-history.mjs'

const directory = new URL('../drizzle/', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('../docs/factory/migration-manifest-dd6d8d4.json', import.meta.url)))

test('canonical SQL is byte-identical to both audited historical names; historical manifest remains available', () => {
  const entries = [...manifest.shared, ...manifest.downstream]
  assert.equal(entries.length, 7)
  assert.equal(Object.keys(MIGRATION_HISTORY).length, 7)
  const names = readdirSync(directory)
  for (const entry of entries) {
    const sql = readFileSync(new URL(entry.file, directory), 'utf8')
    assert.deepEqual(MIGRATION_HISTORY[entry.file], { aliases: entry.aliases, sha256: entry.sha256 })
    assert.equal(createHash('sha256').update(sql).digest('hex'), entry.sha256)
    assert.equal(names.filter(name => name.endsWith(entry.file.slice(14))).length, 1)
    assert.ok(entry.aliases.every(name => !names.includes(name)))
  }
  assert.ok(JSON.parse(readFileSync(new URL('../docs/factory/migration-manifest-7251bf2.json', import.meta.url))).shared.length)
})

test('only actual name records with pinned SQL count; ledger names are never mutated', () => {
  for (const [name, entry] of Object.entries(MIGRATION_HISTORY)) {
    const sql = readFileSync(new URL(name, directory), 'utf8')
    assert.equal(alreadyApplied(name, new Set(), sql), false)
    assert.equal(alreadyApplied(name, new Set(['unrelated_migration.sql']), sql), false)
    for (const recorded of [name, ...entry.aliases]) {
      const applied = new Set([recorded])
      assert.equal(alreadyApplied(name, applied, sql), true)
      assert.deepEqual([...applied], [recorded])
      assert.throws(() => alreadyApplied(name, applied, sql + '\n-- drift'), /content changed/)
      assert.throws(() => alreadyApplied(name, applied), /content changed/)
    }
    assert.throws(() => alreadyApplied(name, new Set(), sql + '\n-- drift'), /content changed/)
  }
  assert.equal(alreadyApplied('unrelated.sql', new Set(['unrelated.sql']), 'unrelated'), true)
  assert.equal(alreadyApplied('unrelated.sql', new Set(), 'unrelated'), false)
})
