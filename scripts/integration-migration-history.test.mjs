import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { alreadyApplied, MIGRATION_EQUIVALENTS } from './migration-order.mjs'
import { INTEGRATION_MIGRATION_IDENTITIES as identities } from './integration-migration-history.mjs'

test('consolidated migration aliases preserve immutable SQL and refuse ambiguous old receipts', () => {
  for (const identity of identities) {
    const sql = readFileSync(new URL(`../drizzle/${identity.name}`, import.meta.url), 'utf8')
    assert.equal(createHash('sha256').update(sql).digest('hex'), identity.sha256)
    assert.equal(alreadyApplied(identity.name, new Set(), sql), false)
    assert.equal(alreadyApplied(identity.name, new Set([identity.name]), sql), true)
    assert.equal(alreadyApplied(identity.name, new Set(['unrelated.sql']), sql), false)
    if (identity.ambiguousPreviousHashes) {
      assert.ok(identity.ambiguousPreviousHashes.length > 1)
      assert.ok(identity.ambiguousPreviousHashes.includes(identity.sha256))
      assert.equal(MIGRATION_EQUIVALENTS[identity.name], undefined)
      assert.throws(() => alreadyApplied(identity.name, new Set([identity.previous]), sql), /ambiguous integration migration history/)
      assert.equal(alreadyApplied(identity.name, new Set([identity.previous, identity.name]), sql), true)
    } else {
      assert.deepEqual(MIGRATION_EQUIVALENTS[identity.name], [identity.previous])
      assert.equal(alreadyApplied(identity.name, new Set([identity.previous]), sql), true)
    }
    for (const ledger of [new Set(), new Set([identity.previous]), new Set([identity.name])]) {
      assert.throws(() => alreadyApplied(identity.name, ledger, `${sql}\n-- altered`), /content changed/)
    }
  }
})
