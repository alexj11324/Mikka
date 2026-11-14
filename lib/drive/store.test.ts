import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MANIFEST_FIELD_SEPARATOR, manifestCanonicalText, type DriveManifestEntry, type DriveWrite } from './contract.ts'
import { DriveError, applyDriveWrite, driveRequestDigest, manifestDigestOf, readDriveHistory, restoreDriveVersion } from './store.ts'

/**
 * The CAS path against an in-memory stand-in for the volume, driven through the
 * same SQL the store issues. The point of these tests is the invariant, not the
 * SQL text: a write whose `expectedDigest` is not the head digest must be
 * refused, must name the paths to re-read, and must leave the tree, the version
 * history and the mutation receipts exactly as they were.
 *
 * A real PostgreSQL run of the same store is `lib/drive/store.db.test.ts`,
 * which CI runs against an ephemeral PG17 (see `scripts/run-db-tests.mjs`).
 */

const hex = (character: string) => character.repeat(64)

interface FakeVolume {
  id: string
  ownerId: string
  driveScope: string
  headVersionId: string
  headDigest: string
  entryCount: number
  totalBytes: number
}
interface FakeState {
  volumes: FakeVolume[]
  entries: Array<DriveManifestEntry & { volumeId: string }>
  versions: Array<{ id: string; volumeId: string; seq: number; kind: string; fileCount: number; totalBytes: number; digest: string; manifest: DriveManifestEntry[]; threadId: string | null; threadTitle: string | null; authorName: string }>
  mutations: Array<{ volumeId: string; mutationId: string; requestDigest: string; versionId: string; expectedDigest: string | null; resultDigest: string }>
  blobs: Map<string, number>
  /** Every statement the store issued, so a test can prove a refusal wrote nothing. */
  statements: string[]
}

const entry = (path: string, over: Partial<DriveManifestEntry> = {}): DriveManifestEntry =>
  ({ path, mode: 0o644, sizeBytes: 3, sha256: hex('a'), ...over })

function volume(entries: DriveManifestEntry[], over: Partial<FakeVolume> = {}): { state: FakeState; id: string; digest: string } {
  const digest = manifestDigestOf(entries)!
  const id = 'vol_01ARZ3NDEKTSV4RRFFQ69G5FAV'
  const state: FakeState = {
    volumes: [{ id, ownerId: 'owner', driveScope: 'user', headVersionId: 'vver_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      headDigest: digest, entryCount: entries.length, totalBytes: entries.reduce((n, e) => n + e.sizeBytes, 0), ...over }],
    entries: entries.map(e => ({ ...e, volumeId: id })),
    versions: [{ id: 'vver_01ARZ3NDEKTSV4RRFFQ69G5FAV', volumeId: id, seq: 1, kind: 'autosave', fileCount: entries.length,
      totalBytes: entries.reduce((n, e) => n + e.sizeBytes, 0), digest, manifest: entries, threadId: null, threadTitle: null, authorName: 'seed' }],
    mutations: [], blobs: new Map([[hex('a'), 3], [hex('b'), 5]]), statements: [],
  }
  return { state, id, digest }
}

/** A `pg` Pool stand-in: one client whose query() answers the store's SQL. */
function poolFor(state: FakeState) {
  const client = {
    async query(text: string, values: unknown[] = []) {
      state.statements.push(text.replace(/\s+/g, ' ').trim())
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 }
      if (text.includes('FROM drive_volumes WHERE id=$1') && text.endsWith('FOR UPDATE')) {
        const found = state.volumes.filter(v => v.id === values[0])
        return { rows: found.map(v => ({ ...v, totalBytes: String(v.totalBytes) })), rowCount: found.length }
      }
      if (text.includes('FROM drive_mutations WHERE "volumeId"=$1 AND "mutationId"=$2')) {
        const found = state.mutations.filter(m => m.volumeId === values[0] && m.mutationId === values[1])
        return { rows: found, rowCount: found.length }
      }
      if (text.includes('FROM drive_volume_versions WHERE id=$1')) {
        const found = state.versions.filter(v => v.id === values[0])
        return { rows: found.map(v => ({ ...v, totalBytes: String(v.totalBytes) })), rowCount: found.length }
      }
      if (text.includes('FROM drive_volume_entries WHERE "volumeId"=$1 ORDER BY path')) {
        const found = state.entries.filter(e => e.volumeId === values[0]).sort((a, b) => (a.path < b.path ? -1 : 1))
        return { rows: found.map(e => ({ path: e.path, mode: e.mode, sizeBytes: e.sizeBytes, sha256: e.sha256 })), rowCount: found.length }
      }
      if (text.includes('FROM drive_blobs WHERE "ownerId"=$1 AND sha256 = ANY')) {
        // Another owner's digest is invisible, so a put naming it is unknown.
        const owned = values[0] === 'owner' ? state.blobs : new Map<string, number>()
        const digests = values[1] as string[]
        const rows = digests.filter(d => owned.has(d)).map(d => ({ sha256: d, sizeBytes: owned.get(d)! }))
        return { rows, rowCount: rows.length }
      }
      if (text.includes('SELECT "ownerId" FROM drive_volumes WHERE id=$1')) {
        const found = state.volumes.filter(v => v.id === values[0])
        return { rows: found.map(v => ({ ownerId: v.ownerId })), rowCount: found.length }
      }
      if (text.includes('FROM drive_volume_versions') && text.includes('ORDER BY id DESC')) {
        const found = state.versions.filter(v => v.volumeId === values[0] && (!values[1] || v.id < (values[1] as string)))
          .sort((a, b) => (a.id < b.id ? 1 : -1)).slice(0, values[2] as number)
        return { rows: found.map(v => ({ ...v, totalBytes: String(v.totalBytes) })), rowCount: found.length }
      }
      if (text.includes('coalesce(max(seq),0)+1')) {
        const scoped = state.versions.filter(v => v.volumeId === values[0])
        return { rows: [{ seq: Math.max(0, ...scoped.map(v => v.seq)) + 1 }], rowCount: 1 }
      }
      if (text.startsWith('DELETE FROM drive_volume_entries')) {
        const paths = new Set(values[1] as string[])
        const before = state.entries.length
        state.entries = state.entries.filter(e => !(e.volumeId === values[0] && paths.has(e.path)))
        return { rows: [], rowCount: before - state.entries.length }
      }
      if (text.includes('INSERT INTO drive_volume_entries')) {
        const rows = JSON.parse(values[1] as string) as DriveManifestEntry[]
        for (const row of rows) {
          const index = state.entries.findIndex(e => e.volumeId === values[0] && e.path === row.path)
          const stored = { ...row, volumeId: values[0] as string }
          if (index >= 0) state.entries[index] = stored
          else state.entries.push(stored)
        }
        return { rows: [], rowCount: rows.length }
      }
      if (text.includes('INSERT INTO drive_volume_versions')) {
        state.versions.push({ id: values[0] as string, volumeId: values[1] as string, seq: values[3] as number,
          kind: values[4] as string, fileCount: values[5] as number, totalBytes: values[6] as number,
          digest: values[7] as string, manifest: JSON.parse(values[8] as string), threadId: values[9] as string | null,
          threadTitle: values[10] as string | null, authorName: values[11] as string })
        return { rows: [], rowCount: 1 }
      }
      if (text.startsWith('UPDATE drive_volumes SET "headVersionId"')) {
        const target = state.volumes.find(v => v.id === values[0])
        if (target) Object.assign(target, { headVersionId: values[1], headDigest: values[2], entryCount: values[3], totalBytes: values[4] })
        return { rows: [], rowCount: target ? 1 : 0 }
      }
      if (text.includes('INSERT INTO drive_mutations')) {
        state.mutations.push({ volumeId: values[0] as string, mutationId: values[1] as string, requestDigest: values[2] as string,
          versionId: values[3] as string, expectedDigest: values[4] as string | null, resultDigest: values[5] as string })
        return { rows: [], rowCount: 1 }
      }
      throw new Error(`unexpected SQL: ${text}`)
    },
    release() {},
  }
  // Reads go straight to a pool query, so the stand-in offers both shapes.
  return { connect: async () => client, query: (text: string, values?: unknown[]) => client.query(text, values ?? []) } as never
}

const actor = { ownerId: 'owner', authorName: 'Alex' }
const put = (path: string, over: Partial<{ mode: 0o644 | 0o755; sha256: string; sizeBytes: number }> = {}) =>
  ({ op: 'put' as const, path, mode: 0o644 as const, sha256: hex('b'), sizeBytes: 5, ...over })

/** Everything a refused write must not have touched. */
function snapshot(state: FakeState) {
  return {
    volumes: structuredClone(state.volumes),
    entries: structuredClone(state.entries),
    versions: structuredClone(state.versions),
    mutations: structuredClone(state.mutations),
  }
}

test('a stale expectedDigest is refused with 409, and says which paths to re-read', async () => {
  const { state, id, digest } = volume([entry('a.txt', { sha256: hex('a') }), entry('b.txt', { sha256: hex('c'), sizeBytes: 7 })])
  const before = snapshot(state)
  const stale = hex('0') // a digest that is nobody's head
  await assert.rejects(
    () => applyDriveWrite(poolFor(state), { ownerId: 'owner', volumeId: id }, actor,
      { expectedDigest: stale, mutationId: 'mut_conflict_1', changes: [put('a.txt')] }),
    (error: unknown) => {
      assert.ok(error instanceof DriveError)
      assert.equal(error.code, 'drive_version_conflict')
      assert.equal(error.status, 409)
      // The client is told the tree to re-read and which of its paths disagree,
      // not merely that it lost the race.
      assert.equal(error.detail?.headDigest, digest)
      assert.equal(error.detail?.headVersionId, 'vver_01ARZ3NDEKTSV4RRFFQ69G5FAV')
      assert.deepEqual(error.detail?.paths, ['a.txt'])
      return true
    })
  // Zero side effects: the tree, its history and the receipts are untouched.
  assert.deepEqual(snapshot(state), before)
  // A refusal rolls back rather than committing anything partial.
  assert.ok(state.statements.includes('ROLLBACK'))
  assert.ok(!state.statements.includes('COMMIT'))
})

test('a conflict names only the paths that differ, so a retry re-reads little', async () => {
  const { state, id } = volume([entry('same.txt', { sha256: hex('a') }), entry('theirs.txt', { sha256: hex('c'), sizeBytes: 7 })])
  await assert.rejects(
    () => applyDriveWrite(poolFor(state), { ownerId: 'owner', volumeId: id }, actor, {
      expectedDigest: hex('0'), mutationId: 'mut_conflict_2',
      changes: [
        put('same.txt', { sha256: hex('a'), sizeBytes: 3 }),   // already what they asked for
        put('theirs.txt'),                                      // they changed it
        put('mine.txt'),                                        // only they have it
        { op: 'delete', path: 'absent.txt' },                   // already gone
      ],
    }),
    (error: unknown) => {
      assert.ok(error instanceof DriveError)
      assert.deepEqual(error.detail?.paths, ['theirs.txt'])
      return true
    })
})

test('a matching expectedDigest lands once, and the same mutationId replays without a second write', async () => {
  const { state, id, digest } = volume([entry('a.txt', { sha256: hex('a') })])
  const write: DriveWrite = { expectedDigest: digest, mutationId: 'mut_landed_1', changes: [put('b.txt')] }
  const first = await applyDriveWrite(poolFor(state), { ownerId: 'owner', volumeId: id }, actor, write)
  assert.equal(first.replayed, false)
  assert.equal(first.seq, 2)
  assert.equal(first.entryCount, 2)
  assert.equal(first.totalBytes, 8)
  assert.equal(state.statements.filter(sql => sql.includes('FROM drive_volume_entries')).length, 1,
    'one locked tree read supplies both CAS validation and the committed entry diff')
  const afterFirst = snapshot(state)

  // Ten replays of the same write: one version, one receipt, one tree.
  const replays = await Promise.all(Array.from({ length: 10 }, () =>
    applyDriveWrite(poolFor(state), { ownerId: 'owner', volumeId: id }, actor, write)))
  for (const replay of replays) {
    assert.equal(replay.replayed, true)
    assert.equal(replay.headVersionId, first.headVersionId)
    assert.equal(replay.headDigest, first.headDigest)
  }
  assert.deepEqual(snapshot(state), afterFirst, 'a replay writes nothing at all')
  assert.equal(afterFirst.versions.length, 2)
  assert.equal(afterFirst.mutations.length, 1)
})

test('the same mutationId with a different body is refused instead of silently applying', async () => {
  const { state, id, digest } = volume([entry('a.txt', { sha256: hex('a') })])
  await applyDriveWrite(poolFor(state), { ownerId: 'owner', volumeId: id }, actor,
    { expectedDigest: digest, mutationId: 'mut_reused_1', changes: [put('b.txt')] })
  const afterFirst = snapshot(state)
  await assert.rejects(
    () => applyDriveWrite(poolFor(state), { ownerId: 'owner', volumeId: id }, actor,
      { expectedDigest: digest, mutationId: 'mut_reused_1', changes: [put('c.txt')] }),
    (error: unknown) => error instanceof DriveError && error.code === 'drive_replay_mismatch')
  assert.deepEqual(snapshot(state), afterFirst)
})

test('a put naming bytes the store never received is refused, and nothing is written', async () => {
  const { state, id, digest } = volume([entry('a.txt', { sha256: hex('a') })])
  const before = snapshot(state)
  await assert.rejects(
    () => applyDriveWrite(poolFor(state), { ownerId: 'owner', volumeId: id }, actor,
      { expectedDigest: digest, mutationId: 'mut_unknown_blob', changes: [put('x.txt', { sha256: hex('e') })] }),
    (error: unknown) => error instanceof DriveError && error.code === 'drive_blob_unknown')
  assert.deepEqual(snapshot(state), before)

  // A stated size that disagrees with the stored bytes is refused too.
  await assert.rejects(
    () => applyDriveWrite(poolFor(state), { ownerId: 'owner', volumeId: id }, actor,
      { expectedDigest: digest, mutationId: 'mut_bad_size', changes: [put('x.txt', { sha256: hex('b'), sizeBytes: 99 })] }),
    (error: unknown) => error instanceof DriveError && error.code === 'drive_blob_size_mismatch')
  assert.deepEqual(snapshot(state), before)
})

test("another owner's blob is invisible even when its digest is known", async () => {
  // A digest is public to anyone who can address a volume, so the store must
  // never resolve it across owners: the other person's bytes stay theirs.
  const { state, id, digest } = volume([entry('a.txt', { sha256: hex('a') })])
  const before = snapshot(state)
  await assert.rejects(
    () => applyDriveWrite(poolFor(state), { ownerId: 'owner', volumeId: id }, actor,
      { expectedDigest: digest, mutationId: 'mut_foreign_blob', changes: [put('steal.txt', { sha256: hex('c'), sizeBytes: 7 })] }),
    (error: unknown) => {
      // hex('c') IS in the store, but under someone else's ownership.
      assert.ok(error instanceof DriveError)
      assert.equal(error.code, 'drive_blob_unknown')
      return true
    })
  assert.deepEqual(snapshot(state), before)
})

test('a volume of another owner looks absent, and a wrong scope does too', async () => {
  const { state, id, digest } = volume([entry('a.txt', { sha256: hex('a') })])
  const write: DriveWrite = { expectedDigest: digest, mutationId: 'mut_foreign', changes: [put('b.txt')] }
  await assert.rejects(() => applyDriveWrite(poolFor(state), { ownerId: 'someone', volumeId: id }, actor, write),
    (error: unknown) => error instanceof DriveError && error.code === 'drive_not_found' && error.status === 404)
  await assert.rejects(() => applyDriveWrite(poolFor(state), { ownerId: 'owner', volumeId: id, driveScope: 'project' }, actor, write),
    (error: unknown) => error instanceof DriveError && error.code === 'drive_not_found')
  assert.equal(state.versions.length, 1, 'no version was added')
})

test('a request digest separates the same id used for different changes', () => {
  const base: DriveWrite = { expectedDigest: hex('a'), mutationId: 'mut_x', changes: [put('p')] }
  assert.equal(driveRequestDigest(base), driveRequestDigest({ ...base, changes: [put('p')] }))
  assert.notEqual(driveRequestDigest(base), driveRequestDigest({ ...base, changes: [put('q')] }))
  assert.notEqual(driveRequestDigest(base), driveRequestDigest({ ...base, expectedDigest: hex('b') }))
  assert.notEqual(driveRequestDigest(base), driveRequestDigest({ ...base, changes: [put('p', { mode: 0o755 })] }))
  assert.notEqual(driveRequestDigest(base), driveRequestDigest({ ...base, changes: [put('p', { sha256: hex('c') })] }))
  assert.notEqual(driveRequestDigest(base), driveRequestDigest({ ...base, changes: [{ op: 'delete', path: 'p' }] }))
})

test('the entry count limit refuses a write that would pass 100 000 entries', async () => {
  // A volume already at the ceiling: one more put must be refused as a limit,
  // not stored and then discovered.
  const seeded = Array.from({ length: 100_000 }, (_, i) => entry(`f${i}`, { sha256: hex('a') }))
  const { state, id, digest } = volume(seeded)
  const before = snapshot(state)
  await assert.rejects(
    () => applyDriveWrite(poolFor(state), { ownerId: 'owner', volumeId: id }, actor,
      { expectedDigest: digest, mutationId: 'mut_over_limit', changes: [put('one-more.txt')] }),
    (error: unknown) => error instanceof DriveError && error.code === 'drive_limit_exceeded')
  assert.deepEqual(snapshot(state), before)
})


test('a restore writes the old tree FORWARD as a new version, never back', async () => {
  // Three versions: empty seed, then a.txt, then a.txt + b.txt.
  const { state, id, digest } = volume([entry('a.txt', { sha256: hex('a') })])
  const second = await applyDriveWrite(poolFor(state), { ownerId: 'owner', volumeId: id }, actor,
    { expectedDigest: digest, mutationId: 'mut_restore_seed', changes: [put('b.txt', { sha256: hex('b'), sizeBytes: 5 })] })
  const seed = state.versions[0]!
  const before = snapshot(state)

  const restored = await restoreDriveVersion(poolFor(state), { ownerId: 'owner', volumeId: id }, actor,
    { versionId: seed.id, expectedDigest: second.headDigest, mutationId: 'mut_restore_0001' })

  // The old tree is back...
  assert.deepEqual(state.entries.map(e => e.path).sort(), ['a.txt'])
  assert.equal(restored.headDigest, seed.digest)
  // ...as a NEW version that names where it came from. Nothing is deleted.
  assert.equal(state.versions.length, before.versions.length + 1, 'history grew, it did not move')
  const written = state.versions.at(-1)!
  assert.equal(written.kind, 'restore')
  assert.equal(written.manifest.length, 1)
  // The version it restored from is still there, byte for byte.
  assert.deepEqual(state.versions.find(v => v.id === seed.id), seed)
  assert.equal(state.versions.find(v => v.id === second.headVersionId)!.manifest.length, 2, 'the tree it replaced is kept too')
})

test('a restore with a stale expectedDigest is refused and changes nothing', async () => {
  const { state, id, digest } = volume([entry('kept'), entry('changed-mode'), entry('changed-bytes'), entry('added')])
  state.versions[0]!.manifest = [
    entry('kept'), entry('changed-bytes', { sha256: hex('b') }), entry('removed'), entry('changed-mode', { mode: 0o755 }),
  ]
  const before = snapshot(state)
  await assert.rejects(
    () => restoreDriveVersion(poolFor(state), { ownerId: 'owner', volumeId: id }, actor,
      { versionId: state.versions[0]!.id, expectedDigest: hex('0'), mutationId: 'mut_restore_stale' }),
    (error: unknown) => {
      assert.ok(error instanceof DriveError)
      assert.equal(error.code, 'drive_version_conflict')
      assert.equal(error.detail?.headDigest, digest)
      assert.deepEqual(error.detail?.paths, ['added', 'changed-bytes', 'changed-mode', 'removed'])
      return true
    })
  assert.deepEqual(snapshot(state), before)
})

test('a restore of a version from another volume is not found', async () => {
  const { state, id, digest } = volume([entry('a.txt', { sha256: hex('a') })])
  const before = snapshot(state)
  await assert.rejects(
    () => restoreDriveVersion(poolFor(state), { ownerId: 'owner', volumeId: id }, actor,
      { versionId: 'vver_01ARZ3NDEKTSV4RRFFQ69G5FAZ', expectedDigest: digest, mutationId: 'mut_restore_other' }),
    (error: unknown) => error instanceof DriveError && error.code === 'drive_not_found')
  assert.deepEqual(snapshot(state), before)
})

test('the history carries the thread and author each version came from', async () => {
  const { state, id, digest } = volume([entry('a.txt', { sha256: hex('a') })])
  await applyDriveWrite(poolFor(state), { ownerId: 'owner', volumeId: id }, { ...actor, threadId: 'MIKK-4', threadTitle: 'Drive' },
    { expectedDigest: digest, mutationId: 'mut_history_01', changes: [put('b.txt', { sha256: hex('b'), sizeBytes: 5 })] })
  const history = await readDriveHistory(poolFor(state) as never, { ownerId: 'owner' }, id)
  assert.equal(history.length, 2)
  assert.equal(history[0]!.threadId, 'MIKK-4')
  assert.equal(history[0]!.threadTitle, 'Drive')
  assert.equal(history[0]!.authorName, 'Alex')
  assert.equal(history[1]!.authorName, 'seed')
})

test('the canonical manifest text is what the digest covers', () => {
  const entries = [entry('b.txt', { sha256: hex('c'), sizeBytes: 7 }), entry('a.txt')]
  const sep = MANIFEST_FIELD_SEPARATOR
  assert.equal(manifestCanonicalText(entries).split('\n')[0], `a.txt${sep}420${sep}3${sep}${hex('a')}`)
})
