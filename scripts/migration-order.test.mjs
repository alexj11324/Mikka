import {readFileSync} from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { APPLICATION_BASELINE, ARTIFACT_COMPATIBILITY, orderMigrations, alreadyApplied } from './migration-order.mjs'
import { planMigration } from './migration-steps.mjs'
import { createHash } from 'node:crypto'

test('only the explicit baseline precedes legacy migrations, without changing their IDs', () => {
  const names = ['20261024000000_future.sql', '0004_b.sql', APPLICATION_BASELINE, '0001_a.sql', '0004_a.sql']
  assert.deepEqual(orderMigrations(names), [APPLICATION_BASELINE, '0001_a.sql', '0004_a.sql', '0004_b.sql', '20261024000000_future.sql'])
  assert.equal(names[0], '20261024000000_future.sql', 'does not mutate caller input')
})
test('missing baseline fails before connecting to any database', () => {
  assert.throws(() => orderMigrations(['0001_a.sql']), /missing required baseline/)
})

test('an unrecorded migration older than the largest applied ID is still pending', () => {
  const older = '20261110000000_independent_older.sql', newer = '20261111000000_newer.sql'
  const applied = new Set([APPLICATION_BASELINE, newer])
  assert.deepEqual(orderMigrations([newer, older, APPLICATION_BASELINE]).filter(name => !alreadyApplied(name, applied, 'SELECT 1;')), [older])
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

test('task creation receipts retain their exact recorded filename without confusing the colliding attachment ID', () => {
  const name = '20261112030505_task_creation_receipts.sql'
  const old = '20261112030502_task_creation_receipts.sql'
  const attachment = '20261112030502_task_attachments.sql'
  const sql = readFileSync(new URL('../drizzle/' + name, import.meta.url), 'utf8')
  assert.equal(createHash('sha256').update(sql).digest('hex'), 'd9d0692cb505330c864b70c3a2f6cec69da1ca6090d44f619874f034902f60da')
  for (const [recorded, expected] of [[[], false], [[old], true], [[name], true], [[attachment], false], [[old, attachment], true]]) {
    const applied = new Set(recorded)
    const before = [...applied]
    assert.equal(alreadyApplied(name, applied, sql), expected, recorded.join(',') || 'fresh database')
    assert.deepEqual([...applied], before, 'historical ledger entries are never rewritten')
  }
  const attachmentSql = readFileSync(new URL('../drizzle/' + attachment, import.meta.url), 'utf8')
  assert.equal(alreadyApplied(attachment, new Set([old]), attachmentSql), false)
  for (const changed of [sql + '\n-- modified', attachmentSql, sql.replace('-- target: MIKKA_DATABASE_URL', '-- target: DATABASE_URL')]) {
    assert.throws(() => alreadyApplied(name, new Set([old]), changed), /content changed/)
  }
})

test('receipt history is resolved only against its existing application database target', () => {
  const name = '20261112030505_task_creation_receipts.sql'
  const old = '20261112030502_task_creation_receipts.sql'
  const sql = readFileSync(new URL('../drizzle/' + name, import.meta.url), 'utf8')
  const plan = planMigration(name, sql)
  assert.equal(plan.target, 'MIKKA_DATABASE_URL')
  const ledgers = new Map([['MIKKA_DATABASE_URL', new Set()], ['DATABASE_URL', new Set([old])]])
  assert.equal(alreadyApplied(name, ledgers.get(plan.target), sql), false, 'workspace history cannot hide pending application SQL')
  ledgers.get('MIKKA_DATABASE_URL').add(old)
  assert.equal(alreadyApplied(name, ledgers.get(plan.target), sql), true)
  assert.deepEqual([...ledgers.get('MIKKA_DATABASE_URL')], [old])
  assert.deepEqual([...ledgers.get('DATABASE_URL')], [old])
})

const driveHistory = [
  ['20261112030506_drive_blob_workspace_admission.sql', '20261112030502_drive_blob_workspace_admission.sql', '556a765112dafd61fdaf922d4ff78a2fb133d02d47ece04fd9fc5d9847c42b53'],
  ['20261112030507_scope_personal_drive_names_by_workspace.sql', '20261112030505_scope_personal_drive_names_by_workspace.sql', 'c46c75385e55cf5cca5770330c1da2ba763955efe8596e96b6d7dd3abd95c21d'],
]

test('Drive history aliases keep exact SQL and application ledgers without matching other migrations at the old timestamps', () => {
  const unrelated = ['20261112030502_task_attachments.sql', '20261112030502_task_creation_receipts.sql', '20261112030505_task_creation_receipts.sql', '20261112030505_workspace_service_identities.sql']
  for (const [name, old, hash] of driveHistory) {
    const sql = readFileSync(new URL('../drizzle/' + name, import.meta.url), 'utf8')
    assert.equal(createHash('sha256').update(sql).digest('hex'), hash)
    assert.equal(planMigration(name, sql).target, 'MIKKA_DATABASE_URL')
    assert.equal(alreadyApplied(name, new Set(), sql), false)
    assert.equal(alreadyApplied(name, new Set([name]), sql), true)
    const applied = new Set([old])
    assert.equal(alreadyApplied(name, applied, sql), true)
    assert.deepEqual([...applied], [old], 'retain the original filename in the executed ledger')
    for (const foreign of [...unrelated, ...driveHistory.map(row => row[1]).filter(value => value !== old)]) {
      assert.equal(alreadyApplied(name, new Set([foreign]), sql), false, foreign)
    }
    for (const changed of [sql + '\n-- modified', sql.replace('-- target: MIKKA_DATABASE_URL', '-- target: DATABASE_URL')]) {
      assert.throws(() => alreadyApplied(name, applied, changed), /content changed/)
    }
    const ledgers = new Map([['MIKKA_DATABASE_URL', new Set()], ['DATABASE_URL', new Set([old])]])
    assert.equal(alreadyApplied(name, ledgers.get(planMigration(name, sql).target), sql), false)
    assert.deepEqual([...ledgers.get('DATABASE_URL')], [old])
  }
})

test('the Drive admission migration remains before its folder namespace migration', () => {
  const [admission, folderNames] = driveHistory.map(row => row[0])
  const ordered = orderMigrations([folderNames, '20261112030505_task_creation_receipts.sql', admission, APPLICATION_BASELINE])
  assert.ok(ordered.indexOf(admission) < ordered.indexOf(folderNames))
})
