import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { applyDriveWrite, DriveError, readDriveHistory, readDriveVersion, restoreDriveVersion, type DriveActor } from './store'
import { createDriveVolume, listDriveVolumes, readDriveVolume } from './volumes'
import { manifestDigest, type DriveChange, type DriveManifestEntry } from './contract'

/**
 * The Drive CAS against a real PostgreSQL, in a schema of its own.
 *
 * The fake-pool suite (lib/drive/store.test.ts) proves the control flow; this
 * one proves the parts only a database can: the volume row lock really does
 * serialize two writers, the unique indexes really do refuse a duplicate, and a
 * refused write really leaves no row behind once the transaction ends.
 *
 * CI runs it through `scripts/run-db-tests.mjs` against its ephemeral PG17.
 */

const url = process.env.E2E_DATABASE_URL
const usable = Boolean(url) && disposableDatabase(process.env, url!)
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const actor: DriveActor = { ownerId: 'drive-owner', authorName: 'Drive Fixture' }

/** Just the tables these tests touch, from the migrations that create them. */
const DDL = [
  `CREATE TABLE drive_volumes (
    id text PRIMARY KEY, "driveScope" text NOT NULL, "scopeId" text NOT NULL, "scopeUserId" text,
    "ownerId" text NOT NULL, "workspaceId" uuid, name text NOT NULL,
    "headVersionId" text NOT NULL, "headDigest" text NOT NULL, "entryCount" integer NOT NULL DEFAULT 0,
    "totalBytes" bigint NOT NULL DEFAULT 0,
    "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT drive_volumes_scope_shape CHECK (("driveScope" <> 'project-user') = ("scopeUserId" IS NULL)))`,
  `CREATE UNIQUE INDEX drive_volumes_scope_name_key
    ON drive_volumes ("driveScope","scopeId",coalesce("scopeUserId",''),name)`,
  `CREATE TABLE drive_volume_entries (
    "volumeId" text NOT NULL REFERENCES drive_volumes(id) ON DELETE CASCADE, "ownerId" text NOT NULL,
    path text NOT NULL, mode integer NOT NULL CHECK (mode IN (420,493)), "sizeBytes" integer NOT NULL,
    sha256 text NOT NULL, PRIMARY KEY ("volumeId",path))`,
  `CREATE TABLE drive_blobs (
    "ownerId" text NOT NULL, sha256 text NOT NULL, "sizeBytes" integer NOT NULL,
    "storageKey" text, "inlineContent" bytea, PRIMARY KEY ("ownerId",sha256),
    CONSTRAINT drive_blobs_home CHECK (("storageKey" IS NULL) <> ("inlineContent" IS NULL)))`,
  `CREATE UNIQUE INDEX drive_blobs_storage_key ON drive_blobs ("storageKey") WHERE "storageKey" IS NOT NULL`,
  `CREATE TABLE drive_volume_versions (
    id text PRIMARY KEY, "volumeId" text NOT NULL REFERENCES drive_volumes(id) ON DELETE CASCADE,
    "ownerId" text NOT NULL, seq integer NOT NULL, kind text NOT NULL, "fileCount" integer NOT NULL,
    "totalBytes" bigint NOT NULL, digest text NOT NULL, manifest jsonb NOT NULL,
    "threadId" text, "threadTitle" text, "authorName" text NOT NULL,
    "restoredFromVersionId" text, "createdAt" timestamptz NOT NULL DEFAULT now())`,
  `CREATE UNIQUE INDEX drive_volume_versions_seq_key ON drive_volume_versions ("volumeId",seq)`,
  `CREATE TABLE drive_mutations (
    "volumeId" text NOT NULL REFERENCES drive_volumes(id) ON DELETE CASCADE, "mutationId" text NOT NULL,
    "requestDigest" text NOT NULL, "versionId" text NOT NULL, "expectedDigest" text, "resultDigest" text NOT NULL,
    "createdAt" timestamptz NOT NULL DEFAULT now(), PRIMARY KEY ("volumeId","mutationId"))`,
]

/** Every row of the volume, for a before/after comparison. */
async function snapshot(pool: Pool, volumeId: string) {
  const q = async (sql: string) => (await pool.query(sql, [volumeId])).rows
  return {
    volume: await q('SELECT "headVersionId","headDigest","entryCount","totalBytes" FROM drive_volumes WHERE id=$1'),
    entries: await q('SELECT path,mode,"sizeBytes",sha256 FROM drive_volume_entries WHERE "volumeId"=$1 ORDER BY path'),
    versions: await q('SELECT id,seq,kind,digest,"fileCount" FROM drive_volume_versions WHERE "volumeId"=$1 ORDER BY seq'),
    mutations: await q('SELECT "mutationId","versionId" FROM drive_mutations WHERE "volumeId"=$1 ORDER BY "mutationId"'),
  }
}

test('Drive CAS on PG17: conflicts refuse with zero side effects, replays land once', { skip: !usable, timeout: 120_000 }, async t => {
  const schema = `drive_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url!, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  t.after(async () => { await admin.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => {}); await admin.end() })
  const pool = new Pool({ connectionString: url!, max: 6, options: `-c search_path=${schema}` })
  t.after(async () => { await pool.end() })
  for (const sql of DDL) await pool.query(sql)

  // Bytes a `put` may reference. The store takes the size from here, never from the client.
  const blobB = 'seven!!', blobC = 'three'
  await pool.query(`INSERT INTO drive_blobs ("ownerId",sha256,"sizeBytes","storageKey") VALUES ($1,$2,$3,$4),($1,$5,$6,$4)`,
    [actor.ownerId, sha256(blobB), blobB.length, 'drive/fixture', sha256(blobC), blobC.length])

  const volume = await createDriveVolume(pool as never, actor, { driveScope: 'user', scopeId: 'drive-owner', name: 'notes' }, sha256)
  assert.match(volume.id, /^vol_[0-9A-HJKMNP-TV-Z]{26}$/)
  assert.equal(volume.entryCount, 0)
  // A new volume has a real head: the empty tree's digest, with version 1 naming it.
  assert.equal(volume.headDigest, sha256(''))
  await assert.rejects(() => createDriveVolume(pool as never, actor, { driveScope: 'user', scopeId: 'drive-owner', name: 'notes' }, sha256),
    (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'drive_volume_exists')

  const put = (path: string, sha: string, sizeBytes: number, mode: 0o644 | 0o755 = 0o644): DriveChange =>
    ({ op: 'put', path, mode, sha256: sha, sizeBytes })
  const first = await applyDriveWrite(pool as never, { ownerId: actor.ownerId, volumeId: volume.id }, actor,
    { expectedDigest: volume.headDigest, mutationId: 'mut_first_0001', changes: [put('a.txt', sha256(blobB), blobB.length)] })
  assert.equal(first.replayed, false)
  assert.equal(first.seq, 2)
  assert.equal(first.entryCount, 1)

  const head = await readDriveVolume(pool as never, actor, volume.id)
  assert.equal(head.headDigest, first.headDigest)

  // A stale digest is refused, names the paths to re-read, and writes nothing.
  const before = await snapshot(pool, volume.id)
  await assert.rejects(
    () => applyDriveWrite(pool as never, { ownerId: actor.ownerId, volumeId: volume.id }, actor,
      { expectedDigest: sha256('stale'), mutationId: 'mut_stale_0001', changes: [put('a.txt', sha256(blobC), blobC.length)] }),
    (error: unknown) => error instanceof DriveError && error.code === 'drive_version_conflict'
      && error.status === 409 && error.detail?.headDigest === first.headDigest
      && JSON.stringify(error.detail?.paths) === JSON.stringify(['a.txt']))
  assert.deepEqual(await snapshot(pool, volume.id), before, 'a refused write leaves no row behind')

  // Ten concurrent identical writes: one version, one receipt, one tree.
  const write = { expectedDigest: first.headDigest, mutationId: 'mut_race_00001', changes: [put('b.txt', sha256(blobC), blobC.length)] }
  const settled = await Promise.allSettled(Array.from({ length: 10 }, () =>
    applyDriveWrite(pool as never, { ownerId: actor.ownerId, volumeId: volume.id }, actor, write)))
  const fulfilled = settled.filter(r => r.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof applyDriveWrite>>>[]
  assert.equal(fulfilled.length, 10, 'every caller succeeds: one applies, nine replay')
  assert.equal(fulfilled.filter(r => !r.value.replayed).length, 1, 'exactly one applied')
  assert.equal(new Set(fulfilled.map(r => r.value.headVersionId)).size, 1, 'all agree on the version')

  const afterRace = await snapshot(pool, volume.id)
  assert.equal(afterRace.versions.length, 3, 'seed + first + race')
  assert.equal(afterRace.mutations.length, 2)
  assert.deepEqual(afterRace.entries.map((e: { path: string }) => e.path), ['a.txt', 'b.txt'])

  // The head digest equals the digest of the entries the tree really holds.
  const entries = afterRace.entries as DriveManifestEntry[]
  assert.equal(afterRace.volume[0].headDigest, manifestDigest(entries, sha256))
  assert.equal(afterRace.volume[0].entryCount, 2)

  // A restore brings an earlier version back as a NEW version: history grows,
  // and the version it replaced is still readable (ALE-35).
  const history = await readDriveHistory(pool as never, actor, volume.id)
  assert.equal(history[0]!.threadId, null, 'the fixture wrote without a thread')
  assert.equal(history[0]!.authorName, actor.authorName)
  const seedVersion = history.at(-1)!
  const expectedHead = afterRace.volume[0].headDigest as string
  const restored = await restoreDriveVersion(pool as never, { ownerId: actor.ownerId, volumeId: volume.id }, actor,
    { versionId: seedVersion.id, expectedDigest: expectedHead, mutationId: 'mut_restore_01' })
  assert.equal(restored.replayed, false)
  const afterRestore = await snapshot(pool, volume.id)
  assert.equal(afterRestore.versions.length, afterRace.versions.length + 1, 'a restore adds a version')
  assert.deepEqual(afterRestore.entries, [], 'the seed tree was empty')
  assert.equal(afterRestore.volume[0].headDigest, seedVersion.digest)
  // The version it replaced is untouched: nothing was rolled back or deleted.
  const replaced = await readDriveVersion(pool as never, actor, volume.id, (history[0]!).id)
  assert.equal(replaced.manifest.length, 2)
  const restoreVersion = await readDriveVersion(pool as never, actor, volume.id, restored.headVersionId)
  assert.equal(restoreVersion.kind, 'restore')
  assert.equal(restoreVersion.restoredFromVersionId, seedVersion.id)

  // A restore with a stale digest is refused with the paths a retry must re-read.
  await assert.rejects(
    () => restoreDriveVersion(pool as never, { ownerId: actor.ownerId, volumeId: volume.id }, actor,
      { versionId: history[0]!.id, expectedDigest: sha256('stale'), mutationId: 'mut_restore_02' }),
    (error: unknown) => error instanceof DriveError && error.code === 'drive_version_conflict' && Boolean(error.detail?.headDigest))

  // A second volume with the same name in another scope is allowed, and one of
  // another owner is never listed.
  const project = await createDriveVolume(pool as never, actor, { driveScope: 'project', scopeId: 'proj-1', name: 'notes' }, sha256)
  assert.equal((await listDriveVolumes(pool as never, actor, { driveScope: 'user', scopeId: 'drive-owner' })).length, 1)
  assert.equal((await listDriveVolumes(pool as never, { ownerId: 'someone-else' }, { driveScope: 'project', scopeId: 'proj-1' })).length, 0)
  await assert.rejects(() => readDriveVolume(pool as never, { ownerId: 'someone' }, project.id),
    (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'drive_not_found')
})
