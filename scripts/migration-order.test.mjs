import { readdirSync, readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { APPLICATION_BASELINE, ARTIFACT_COMPATIBILITY, orderMigrations, alreadyApplied } from './migration-order.mjs'
import { checkMigrations } from './check-migrations.mjs'

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

test('publication migration keeps the exact historical SQL receipt', () => {
  const name = '20261029024124_run_publications.sql'
  const old = '20261028030036_run_publications.sql'
  const sql = readFileSync(new URL('../drizzle/' + name, import.meta.url), 'utf8')
  assert.equal(alreadyApplied(name, new Set([old]), sql), true)
  assert.equal(alreadyApplied(name, new Set(), sql), false)
  assert.throws(() => alreadyApplied(name, new Set([old]), sql + ' '), /content changed/)
})

test('credential vault migration recognizes the exact previously applied Preview SQL', () => {
  const name = '20261029012027_account_credential_vault.sql'
  const sql = readFileSync(new URL('../drizzle/' + name, import.meta.url), 'utf8')
  assert.equal(alreadyApplied(name, new Set(['20261027221500_account_credential_vault.sql']), sql), true)
  assert.equal(alreadyApplied(name, new Set(['20261028174823_account_credential_vault.sql']), sql), true)
  assert.equal(alreadyApplied(name, new Set(), sql), false)
  assert.throws(() => alreadyApplied(name, new Set(['20261027221500_account_credential_vault.sql']), sql + '-- changed'), /content changed/)
})

// These filenames were present in the fixed batch candidate before P0 merged.
// Look up the one canonical file by suffix so the test checks actual ordering,
// not a second hard-coded copy of the newly assigned timestamps.
const batchHistory = [
  "20261108120200_task_workspace_ownership.sql",
  "20261108120201_linear_workspace_policy.sql",
  "20261108120202_phone_push_session.sql",
  "20261108120203_account_task_history.sql",
  "20261108120300_project_v2.sql",
  "20261108120301_task_identity.sql",
  "20261108120302_task_identity_aliases.sql",
  "20261108120303_team_lifecycle.sql",
  "20261108120304_project_resources.sql",
  "20261108120305_project_lifecycle.sql",
  "20261108120306_project_history_retention.sql",
  "20261108120307_task_alias_tenant.sql",
  "20261108120308_project_writer_fence.sql",
  "20261108230400_coding_review_sessions.sql",
  "20261108230500_coding_review_task_workspace.sql",
  "20261108230600_coding_review_task_thread.sql"
]
const migrationDirectory = new URL('../drizzle/', import.meta.url)
const batchSources = () => {
  const names = readdirSync(migrationDirectory).filter(name => name.endsWith('.sql'))
  const records = batchHistory.map(previous => {
    const matches = names.filter(name => name.endsWith(previous.slice(14)))
    assert.equal(matches.length, 1, `one SQL identity for ${previous}`)
    return { previous, name: matches[0], sql: readFileSync(new URL(matches[0], migrationDirectory), 'utf8') }
  })
  return { names, records }
}

test('published workspace ownership precedes Task identity and Coding review on an empty database', () => {
  const { names, records } = batchSources()
  const ordered = orderMigrations(names)
  const p0 = records.slice(0, 4), dependents = records.slice(4)
  assert.deepEqual(p0.map(record => record.name), [
    '20261109035000_task_workspace_ownership.sql',
    '20261109035001_linear_workspace_policy.sql',
    '20261109035002_phone_push_session.sql',
    '20261109035003_account_task_history.sql',
  ], 'retain main migration identities')
  const lastPrerequisite = Math.max(...p0.map(record => ordered.indexOf(record.name)))
  for (const record of dependents)
    assert.ok(ordered.indexOf(record.name) > lastPrerequisite, `${record.name} must follow published P0 columns and triggers`)
  assert.deepEqual(dependents.map(record => record.name), ordered.filter(name => dependents.some(record => record.name === name)),
    'Task alias and Coding review refinements retain their original relative order')
})

test('batch migrations satisfy the unchanged main timestamp gate', () => {
  const { names, records } = batchSources()
  const additions = new Set(records.slice(4).map(record => record.name))
  const main = names.filter(name => !additions.has(name))
  const files = names.map(name => ({ name, content: readFileSync(new URL(name, migrationDirectory), 'utf8') }))
  assert.deepEqual(checkMigrations(files, main), [])
})

test('the previous complete candidate ledger skips every identical P0, Project and Coding migration', () => {
  const { records } = batchSources()
  const applied = new Set(records.map(record => record.previous))
  const before = [...applied]
  const pending = records.filter(record => !alreadyApplied(record.name, applied, record.sql))
  assert.deepEqual(pending.map(record => record.name), [], 'never replay CREATEs or older trigger definitions under a renamed file')
  assert.deepEqual([...applied], before, 'do not insert replacement ledger identities')
  for (const record of records)
    assert.throws(() => alreadyApplied(record.name, applied, record.sql + '\n-- changed'), /content changed/)
})

test('a published main ledger applies only the twelve new migrations and preserves its receipts', () => {
  const { names, records } = batchSources()
  const additions = new Set(records.slice(4).map(record => record.name))
  const applied = new Set(names.filter(name => !additions.has(name)))
  const before = [...applied]
  const pending = orderMigrations(names).filter(name => !alreadyApplied(name, applied,
    readFileSync(new URL(name, migrationDirectory), 'utf8')))
  assert.deepEqual(pending, records.slice(4).map(record => record.name))
  assert.deepEqual([...applied], before)
})
