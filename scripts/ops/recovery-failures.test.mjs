import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { backupIsolated, restoreIsolated, migrationDigest } from './isolated-recovery.mjs'
import { notifyAlerts } from './monitor.mjs'

test('a blocked restore emits a safe real internal alert; receiver failure is visible without replacing the recovery failure', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mikka-recovery-failure-')), received = [], logs = []
  const original = console.error
  console.error = line => logs.push(JSON.parse(line))
  t.after(() => { console.error = original })
  let refuse = false
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk
    received.push(JSON.parse(body)); response.writeHead(refuse ? 503 : 204); response.end()
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const sink = `http://127.0.0.1:${server.address().port}/internal-alerts`
  const onFailure = async notice => (await notifyAlerts([notice], { sink })).healthy
  const missing = join(root, 'private-tenant-path-never-in-alert')
  await assert.rejects(restoreIsolated({ backupDirectory: missing, onFailure }), { code: 'ENOENT' })
  assert.equal(received.at(-1).id, 'restore-blocked:recoveryPayloadMissing')
  assert.equal(logs.at(-1).notificationStatus, 'delivered')
  assert.equal(received.at(-1).owner, 'repository-maintainers')
  refuse = true
  await assert.rejects(restoreIsolated({ backupDirectory: missing, onFailure }), { code: 'ENOENT' })
  assert.equal(logs.at(-1).notificationStatus, 'failed')
  refuse = false
  await writeFile(join(root, 'manifest.json'), '{}')
  await assert.rejects(restoreIsolated({ backupDirectory: root, expectedManifestSha256: '0'.repeat(64), onFailure }), /recoveryManifestMismatch/)
  assert.equal(received.at(-1).code, 'recoveryManifestMismatch')
  await assert.rejects(restoreIsolated({ backupDirectory: missing }), { code: 'ENOENT' })
  assert.equal(logs.at(-1).notificationStatus, 'not_configured')
  await assert.rejects(backupIsolated({ quiesced: {}, onFailure: async () => { throw Error('SECRET adapter exception') } }), /recoveryQuiescenceRequired/)
  assert.equal(logs.at(-1).notificationStatus, 'failed')
  assert.equal(logs.at(-1).id, 'backup-blocked:recoveryQuiescenceRequired')
  assert.ok(!JSON.stringify({ received, logs }).includes('private-tenant-path-never-in-alert'))
  assert.ok(!JSON.stringify({ received, logs }).includes('SECRET'))
  console.log(JSON.stringify({ internalFailureEvents: received.length, primaryFailurePreserved: true, notificationFailureVisible: true, databasesCreated: 0 }))
})

test('source topology is hash-bound while co-located and legacy backups still require distinct restore targets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mikka-recovery-topology-'))
  const manifest = { format: 'mikka-isolated-recovery', version: 1,
    sourceTopology: { kind: 'co-located', databases: ['mikka_owned_e2e', 'mikka_owned_e2e'] },
    databases: [{ role: 'main', inventory: [] }, { role: 'workspace', inventory: [] }],
    files: ['database-0.enc', 'database-1.enc', 'objects.enc'].map(name => ({ name })),
    migrationSha256: await migrationDigest('drizzle') }
  const target = { database: 'mikka_restore_e2e' }
  async function attempt(value, pattern, anchor) {
    const bytes = JSON.stringify(value)
    await writeFile(join(root, 'manifest.json'), bytes, { mode: 0o600 })
    const expectedManifestSha256 = anchor ?? createHash('sha256').update(bytes).digest('hex')
    await assert.rejects(restoreIsolated({ backupDirectory: root, expectedManifestSha256, migrationsDirectory: 'drizzle', targets: [target, target] }), pattern)
  }
  // Source aliases never authorize destination aliases, before any Docker/SQL work.
  await attempt(manifest, /recoveryDistinctDatabasesRequired/)
  const { sourceTopology: _topology, ...legacy } = manifest
  await attempt(legacy, /recoveryDistinctDatabasesRequired/)
  await attempt({ ...manifest, sourceTopology: { ...manifest.sourceTopology, kind: 'separate' } }, /recoveryManifestInvalid/)
  await attempt({ ...manifest, sourceTopology: { kind: 'co-located', databases: ['mikka_owned_e2e', 'mikka_other_e2e'] } }, /recoveryManifestInvalid/)
  await attempt({ ...manifest, databases: [...manifest.databases].reverse() }, /recoveryManifestInvalid/)
  await attempt(manifest, /recoveryManifestMismatch/, '0'.repeat(64))
})
