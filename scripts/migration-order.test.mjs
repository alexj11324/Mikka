import {readFileSync} from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { APPLICATION_BASELINE, ARTIFACT_COMPATIBILITY, orderMigrations, alreadyApplied } from './migration-order.mjs'

test('only the explicit baseline precedes legacy migrations, without changing their IDs', () => {
  const names = ['20261024000000_future.sql', '0004_b.sql', APPLICATION_BASELINE, '0001_a.sql', '0004_a.sql']
  assert.deepEqual(orderMigrations(names), [APPLICATION_BASELINE, '0001_a.sql', '0004_a.sql', '0004_b.sql', '20261024000000_future.sql'])
  assert.equal(names[0], '20261024000000_future.sql', 'does not mutate caller input')
})
test('missing baseline fails before connecting to any database', () => {
  assert.throws(() => orderMigrations(['0001_a.sql']), /missing required baseline/)
})

test('known legacy artifact compatibility runs before mainline artifact creation', () => {
  const names = [APPLICATION_BASELINE, '0001_a.sql', '20261027010100_artifacts.sql', ARTIFACT_COMPATIBILITY, '20261027164501_cloud_computers.sql']
  assert.deepEqual(orderMigrations(names), [APPLICATION_BASELINE, '0001_a.sql', ARTIFACT_COMPATIBILITY, '20261027010100_artifacts.sql', '20261027164501_cloud_computers.sql'])
})

test('BYOS migration aliases recognize both recorded branch histories without replay', async () => {
  const { alreadyApplied, MIGRATION_EQUIVALENTS } = await import('./migration-order.mjs')
  const { readFileSync } = await import('node:fs')
  for (const [canonical, historical] of Object.entries(MIGRATION_EQUIVALENTS)) {
    const sql = readFileSync(new URL(`../drizzle/${canonical}`, import.meta.url), 'utf8')
    assert.equal(alreadyApplied(canonical, new Set(), sql), false)
    assert.equal(alreadyApplied(canonical, new Set([canonical]), sql), true)
    for (const name of historical) assert.equal(alreadyApplied(canonical, new Set([name]), sql), true)
    assert.equal(alreadyApplied(canonical, new Set(['unrelated.sql']), sql), false)
    assert.throws(() => alreadyApplied(canonical, new Set([historical[0]]), sql + ' '), /content changed/)
  }
})


test('Agent Kit migration alias requires its original exact SQL', () => {
  const name='20261027181000_agent_kit.sql'
  const sql=readFileSync(new URL('../drizzle/'+name,import.meta.url),'utf8')
  assert.equal(alreadyApplied(name,new Set(['20261027040500_agent_kit.sql']),sql),true)
  assert.throws(()=>alreadyApplied(name,new Set(['20261027040500_agent_kit.sql']),sql+'-- changed'),/content changed/)
})

test('local repository defaults only accepts the exact SQL under its historical name', () => {
  const name = '20261029022353_local_repository_defaults.sql'
  const old = '20261028020000_local_repository_defaults.sql'
  const previous = '20261028143922_local_repository_defaults.sql'
  const sql = readFileSync(new URL('../drizzle/' + name, import.meta.url), 'utf8')
  assert.equal(alreadyApplied(name, new Set(), sql), false)
  assert.equal(alreadyApplied(name, new Set([old]), sql), true)
  assert.equal(alreadyApplied(name, new Set([previous]), sql), true)
  assert.equal(alreadyApplied(name, new Set([name]), sql), true)
  assert.throws(() => alreadyApplied(name, new Set([old]), sql + '\n-- modified'), /content changed/)
})

test('device authorization recognizes its historical name only for identical SQL', () => {
  const name = '20261029023121_device_authorization.sql'
  const old = '20261028022909_device_authorization.sql'
  const sql = readFileSync(new URL('../drizzle/' + name, import.meta.url), 'utf8')
  assert.equal(alreadyApplied(name, new Set(), sql), false)
  assert.equal(alreadyApplied(name, new Set([old]), sql), true)
  assert.equal(alreadyApplied(name, new Set([name]), sql), true)
  assert.throws(() => alreadyApplied(name, new Set([old]), sql + '\n-- modified'), /content changed/)
})
