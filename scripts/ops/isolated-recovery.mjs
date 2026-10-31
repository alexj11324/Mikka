import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { lstat, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Pool } from 'pg'

const exec = promisify(execFile), hash = bytes => createHash('sha256').update(bytes).digest('hex')
const ident = value => '"' + value.replaceAll('"', '""') + '"'
const dockerArgs = ['--host=unix:///var/run/docker.sock']
const dockerEnv = () => { const env = { ...process.env }; delete env.DOCKER_HOST; delete env.DOCKER_CONTEXT; return env }

/** Deliberately a loopback, existing-container drill driver; never a production restore command. */
export async function isolatedTarget(raw, container) {
  const url = new URL(raw), database = decodeURIComponent(url.pathname.slice(1))
  if (url.protocol !== 'postgresql:' || url.hostname !== '127.0.0.1' || url.username !== 'postgres' || url.password || url.search ||
      !/^[a-z][a-z0-9_]{0,54}_e2e$/.test(database)) throw Error('recoveryIsolatedTargetRequired')
  const { stdout } = await exec('docker', [...dockerArgs, 'inspect', container, '--format', '{{json .NetworkSettings.Ports}}'], { env: dockerEnv() })
  const ports = JSON.parse(stdout)['5432/tcp']
  if (!ports?.some(port => port.HostIp === '127.0.0.1' && port.HostPort === url.port)) throw Error('recoveryContainerBindingMismatch')
  return { database, url: raw, container }
}

async function validateBoundPair(targets) {
  if (!Array.isArray(targets) || targets.length !== 2 || !targets[0] || !targets[1] ||
      targets[0].container !== targets[1].container || new URL(targets[0].url).host !== new URL(targets[1].url).host) throw Error('recoverySourceRolesRequired')
  for (const target of targets) {
    const checked = await isolatedTarget(target.url, target.container)
    if (checked.database !== target.database) throw Error('recoveryIsolatedTargetRequired')
  }
}

async function validateBackupSources(sources) {
  // The two existing logical roles may share a single authorized database.
  // Both aliases still undergo the same loopback/container/database binding.
  await validateBoundPair(sources)
  return { kind: sources[0].database === sources[1].database ? 'co-located' : 'separate', databases: sources.map(source => source.database) }
}

async function validateRestoreTargets(targets) {
  if (!Array.isArray(targets) || targets.length !== 2 || targets[0]?.database === targets[1]?.database) throw Error('recoveryDistinctDatabasesRequired')
  await validateBoundPair(targets)
}

function manifestTopology(manifest) {
  // Earlier version-1 backups could only have separate physical sources.
  if (manifest.sourceTopology === undefined) return { kind: 'separate', databases: [] }
  const topology = manifest.sourceTopology
  if (!topology || !['co-located', 'separate'].includes(topology.kind) || !Array.isArray(topology.databases) || topology.databases.length !== 2 ||
      !topology.databases.every(name => typeof name === 'string' && /^[a-z][a-z0-9_]{0,54}_e2e$/.test(name)) ||
      (topology.databases[0] === topology.databases[1]) !== (topology.kind === 'co-located')) throw Error('recoveryManifestInvalid')
  return topology
}

async function pgTool(target, command, args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile('docker', [...dockerArgs, 'exec', '-i', target.container, command, '-U', 'postgres', '-d', target.database, ...args],
      { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, env: dockerEnv() }, (error, stdout) => error ? reject(Error('recoveryPostgresToolFailed')) : resolve(stdout))
    // No database URL, password or tool stderr is copied to reports.
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

export async function databaseInventory(client) {
  const { rows } = await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")
  const inventory = []
  for (const { tablename } of rows) {
    const { rows: content } = await client.query(`SELECT row_to_json(t)::text AS row FROM ${ident(tablename)} t ORDER BY row_to_json(t)::text`)
    inventory.push({ table: tablename, count: content.length, sha256: hash(content.map(value => value.row).join('\n')) })
  }
  return inventory
}

export async function migrationDigest(directory) {
  const names = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()
  return hash((await Promise.all(names.map(async name => `${name}:${hash(await readFile(join(directory, name)))}`))).join('\n'))
}

async function objectFiles(directory, prefix = '') {
  const files = []
  if (!(await lstat(directory)).isDirectory()) throw Error('recoveryObjectDirectoryInvalid')
  for (const name of (await readdir(directory)).sort()) {
    if (!/^[a-zA-Z0-9._-]+$/.test(name) || name === '.' || name === '..') throw Error('recoveryObjectPathInvalid')
    const key = prefix ? `${prefix}/${name}` : name, path = join(directory, name), stat = await lstat(path)
    if (stat.isSymbolicLink()) throw Error('recoveryObjectSymlinkRejected')
    if (stat.isDirectory()) files.push(...await objectFiles(path, key))
    else if (stat.isFile()) files.push({ key, bytes: await readFile(path) })
    else throw Error('recoveryObjectTypeInvalid')
  }
  return files
}

function encrypt(bytes, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw Error('recoveryKeyRequired')
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv)
  return Buffer.concat([iv, cipher.update(bytes), cipher.final(), cipher.getAuthTag()])
}
function decrypt(bytes, key) {
  try {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw Error('key')
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
    decipher.setAuthTag(bytes.subarray(-16))
    return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()])
  } catch { throw Error('recoveryPayloadAuthenticationFailed') }
}

async function backupIsolatedVerified({ targets, objectsDirectory, outputDirectory, key, sourceSha, migrationsDirectory, vaultProbe, quiesced }) {
  if (quiesced?.writersStopped !== true || quiesced?.workersStopped !== true || !/^[a-f0-9]{40}$/.test(sourceSha)) throw Error('recoveryQuiescenceRequired')
  const sourceTopology = await validateBackupSources(targets)
  if (!await vaultProbe()) throw Error('recoveryVaultUnavailable')
  await mkdir(outputDirectory, { mode: 0o700 })
  const pools = targets.map(target => new Pool({ connectionString: target.url, max: 1 })), clients = []
  const startedAt = new Date().toISOString(), payloads = [], databases = []
  try {
    for (const pool of pools) {
      const client = await pool.connect(); clients.push(client)
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ; SET LOCAL lock_timeout='5s'; SET LOCAL TIME ZONE 'UTC'")
      const { rows } = await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")
      if (rows.length) await client.query(`LOCK TABLE ${rows.map(row => ident(row.tablename)).join(',')} IN SHARE MODE`)
    }
    const capturedAt = new Date().toISOString()
    for (const [index, target] of targets.entries()) {
      const client = clients[index], snapshot = (await client.query('SELECT pg_export_snapshot() AS snapshot')).rows[0].snapshot
      databases.push({ role: index === 0 ? 'main' : 'workspace', inventory: await databaseInventory(client) })
      payloads.push({ name: `database-${index}.enc`, bytes: await pgTool(target, 'pg_dump', ['--format=custom', '--no-owner', '--no-acl', `--snapshot=${snapshot}`]) })
    }
    const objects = await objectFiles(objectsDirectory)
    payloads.push({ name: 'objects.enc', bytes: Buffer.from(JSON.stringify(objects.map(file => ({ key: file.key, data: file.bytes.toString('base64') })))) })
    const files = []
    for (const payload of payloads) {
      const encrypted = encrypt(payload.bytes, key)
      await writeFile(join(outputDirectory, payload.name), encrypted, { mode: 0o600, flag: 'wx' })
      files.push({ name: payload.name, size: encrypted.length, sha256: hash(encrypted) })
    }
    const manifest = { format: 'mikka-isolated-recovery', version: 1, sourceSha, sourceTopology, startedAt, capturedAt, completedAt: new Date().toISOString(),
      migrationSha256: await migrationDigest(migrationsDirectory), databases, files,
      objects: objects.map(file => ({ key: file.key, size: file.bytes.length, sha256: hash(file.bytes) })),
      consistency: sourceTopology.kind === 'co-located'
        ? 'quiesced-co-located-data-domains; two isolated restore copies; no cloud PITR claim'
        : 'quiesced-dual-database; no distributed snapshot or cloud PITR claim' }
    const bytes = JSON.stringify(manifest, null, 2) + '\n'
    await writeFile(join(outputDirectory, 'manifest.json'), bytes, { mode: 0o600, flag: 'wx' })
    return { manifest, manifestSha256: hash(bytes) }
  } finally {
    for (const client of clients) { await client.query('ROLLBACK').catch(() => {}); client.release() }
    await Promise.all(pools.map(pool => pool.end()))
  }
}

async function restoreIsolatedVerified({ targets, backupDirectory, objectsDirectory, key, expectedManifestSha256, migrationsDirectory,
  deletionManifest, deletionManifestSha256, deletionObservedAt, applyDeletions, vaultProbe, now = new Date() }) {
  const started = performance.now(), manifestBytes = await readFile(join(backupDirectory, 'manifest.json'))
  if (!/^[a-f0-9]{64}$/.test(expectedManifestSha256 ?? '') || hash(manifestBytes) !== expectedManifestSha256) throw Error('recoveryManifestMismatch')
  const manifest = JSON.parse(String(manifestBytes))
  if (manifest.format !== 'mikka-isolated-recovery' || manifest.version !== 1 || !Array.isArray(manifest.databases) || JSON.stringify(manifest.databases.map(database => database?.role)) !== JSON.stringify(['main', 'workspace']) ||
      JSON.stringify(manifest.files?.map(file => file.name)) !== JSON.stringify(['database-0.enc', 'database-1.enc', 'objects.enc'])) throw Error('recoveryManifestInvalid')
  const sourceTopology = manifestTopology(manifest)
  if (manifest.migrationSha256 !== await migrationDigest(migrationsDirectory)) throw Error('recoverySchemaMismatch')
  await validateRestoreTargets(targets)
  if (targets.some(target => sourceTopology.databases.includes(target.database))) throw Error('recoveryTargetIsSource')
  const observed = Date.parse(deletionObservedAt), created = Date.parse(deletionManifest?.createdAt)
  if (!Number.isFinite(observed) || !Number.isFinite(created) || now.getTime() - observed > 5 * 60_000 || observed > now.getTime() ||
      Math.abs(observed - created) > 5 * 60_000 || hash(Buffer.from(JSON.stringify(deletionManifest))) !== deletionManifestSha256) throw Error('recoveryCurrentDeletionJournalRequired')
  if (!await vaultProbe()) throw Error('recoveryVaultUnavailable')
  const payloads = []
  for (const file of manifest.files) {
    const bytes = await readFile(join(backupDirectory, file.name))
    if (bytes.length !== file.size || hash(bytes) !== file.sha256) throw Error('recoveryPayloadMismatch')
    payloads.push(decrypt(bytes, key))
  }
  const objects = JSON.parse(String(payloads[2]))
  if (!Array.isArray(objects) || JSON.stringify(objects.map(file => ({ key: file.key, size: Buffer.from(file.data, 'base64').length, sha256: hash(Buffer.from(file.data, 'base64')) }))) !== JSON.stringify(manifest.objects)) throw Error('recoveryObjectMismatch')
  // Targets must be brand-new databases, not merely empty schemas. Refuse reuse.
  const adminUrl = new URL(targets[0].url); adminUrl.pathname = '/postgres'
  const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 }), pools = []
  try {
    for (const target of targets) {
      if ((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [target.database])).rowCount) throw Error('recoveryTargetExists')
    }
    await mkdir(objectsDirectory, { mode: 0o700 })
    for (const [index, target] of targets.entries()) {
      await admin.query(`CREATE DATABASE ${ident(target.database)}`)
      await admin.query(`REVOKE CONNECT ON DATABASE ${ident(target.database)} FROM PUBLIC`)
      await pgTool(target, 'pg_restore', ['--exit-on-error', '--no-owner', '--no-acl'], payloads[index])
      const pool = new Pool({ connectionString: target.url, max: 5 }); pools.push(pool)
      if (JSON.stringify(await databaseInventory(pool)) !== JSON.stringify(manifest.databases[index].inventory)) throw Error('recoveryDatabaseMismatch')
    }
    for (const object of objects) {
      if (!/^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*$/.test(object.key) || object.key.split('/').some(part => part === '.' || part === '..')) throw Error('recoveryObjectPathInvalid')
      const parts = object.key.split('/'); parts.pop()
      if (parts.length) await mkdir(join(objectsDirectory, ...parts), { recursive: true, mode: 0o700 })
      await writeFile(join(objectsDirectory, object.key), Buffer.from(object.data, 'base64'), { mode: 0o600, flag: 'wx' })
    }
    const deleteObject = async key => {
      if (typeof key !== 'string' || !/^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*$/.test(key) || key.split('/').some(part => part === '.' || part === '..')) throw Error('recoveryObjectPathInvalid')
      try { await unlink(join(objectsDirectory, key)) } catch (error) { if (error.code !== 'ENOENT') throw Error('recoveryObjectCleanupFailed') }
    }
    await applyDeletions(deletionManifest, { mainPool: pools[0], workspacePool: pools[1], deleteObject })
    // A co-located source is copied into both isolated role targets. Reconcile
    // both domains in both copies; a shadow copy must not resurrect deleted data.
    if (sourceTopology.kind === 'co-located') await applyDeletions(deletionManifest, { mainPool: pools[1], workspacePool: pools[0], deleteObject })
    // Explicit quarantine: no restored credential, lease or approval authorizes an external replay.
    for (const main of sourceTopology.kind === 'co-located' ? pools : [pools[0]]) await main.query(`BEGIN;
      DELETE FROM session; DELETE FROM verification; DELETE FROM "deviceCode"; DELETE FROM desktop_auth_requests;
      DELETE FROM "oauthAccessToken"; DELETE FROM "oauthRefreshToken"; DELETE FROM "oauthConsent";
      UPDATE device_tokens SET "revokedAt"=COALESCE("revokedAt",now()),"revokedBy"=COALESCE("revokedBy",'isolated-recovery');
      UPDATE run_tokens SET "revokedAt"=COALESCE("revokedAt",now());
      UPDATE personal_access_tokens SET "revokedAt"=COALESCE("revokedAt",now());
      UPDATE account SET "accessToken"=NULL,"refreshToken"=NULL,"idToken"=NULL;
      DELETE FROM credential_challenges; DELETE FROM credential_fill_leases; DELETE FROM browser_sessions;
      UPDATE credentials SET revoked_at=COALESCE(revoked_at,now());
      UPDATE pending_actions SET status='declined',"decidedAt"=now() WHERE status IN ('pending','running');
      UPDATE user_schedules SET status='paused',updated_at=now() WHERE status='active';
      UPDATE operation_ledger SET status='uncertain',"updatedAt"=now() WHERE status='executing';
      COMMIT`)
    return { sourceSha: manifest.sourceSha, sourceTopology: sourceTopology.kind, backupCapturedAt: manifest.capturedAt, restoredAt: new Date().toISOString(),
      restoreDurationMs: Math.round(performance.now() - started), databasesVerified: 2, objectsVerified: objects.length,
      state: 'quarantined', releaseConditions: ['application and workers remain stopped', 'reconcile durable outboxes and uncertain effects', 'freshly authenticate and reauthorize', 'check current deletion/revocation journal again before exposure'] }
  } finally { await Promise.all(pools.map(pool => pool.end())); await admin.end() }
}

const failureCodes = new Set([
  'recoveryManifestMismatch', 'recoveryManifestInvalid', 'recoverySchemaMismatch', 'recoveryVaultUnavailable',
  'recoveryCurrentDeletionJournalRequired', 'recoveryPayloadMismatch', 'recoveryPayloadAuthenticationFailed',
  'recoveryObjectMismatch', 'recoveryObjectPathInvalid', 'recoveryObjectCleanupFailed', 'recoveryTargetExists',
  'recoveryDatabaseMismatch', 'recoveryPostgresToolFailed', 'recoveryIsolatedTargetRequired',
  'recoveryContainerBindingMismatch', 'recoveryQuiescenceRequired', 'recoveryDistinctDatabasesRequired', 'recoverySourceRolesRequired', 'recoveryTargetIsSource',
  'accountDeletionManifestInvalid', 'accountDeletionManifestHasPendingJobs', 'accountDeletionRestoreCleanupPending',
])
/** A blocked recovery always remains a failure. Notification cannot authorize exposure or hide that failure. */
async function withFailureNotice(phase, options, work) {
  try { return await work(options) }
  catch (error) {
    const code = failureCodes.has(error?.message) ? error.message : error?.code === 'ENOENT' ? 'recoveryPayloadMissing' : 'recoveryFailed'
    const notice = { version: 1, id: `${phase}-blocked:${code}`, state: 'firing', observedAt: new Date().toISOString(),
      code, value: 1, owner: 'repository-maintainers', runbook: 'docs/operations/safe-recovery.md',
      action: 'Keep the recovery target isolated. Check the independent manifest, schema, object payloads, vault and current deletion journal before a new attempt.' }
    let notificationStatus = 'not_configured'
    if (options.onFailure) {
      try { notificationStatus = await options.onFailure(notice) === true ? 'delivered' : 'failed' }
      catch { notificationStatus = 'failed' }
    }
    // Only fixed reason codes, never database URLs, rows, object paths, keys or original exception text.
    console.error(JSON.stringify({ ...notice, notificationStatus }))
    throw error
  }
}
export const backupIsolated = options => withFailureNotice('backup', options, backupIsolatedVerified)
export const restoreIsolated = options => withFailureNotice('restore', options, restoreIsolatedVerified)
