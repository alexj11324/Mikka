import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { Pool, PoolClient } from 'pg'
import { CodingWorkspaceError } from '@mikka/protocol/coding-workspace'
import type { DiffFileMetadata, DiffFilePatch, DiffRevision, DiffSnapshot, DiffSourceAccess } from '@mikka/protocol/coding-workspace-review'
import { runSecretMasker, secretMaskerFor, workspaceSecretMasker } from '../../secrets/runtime'
import { reviewBoardId, type ReviewActor, type ReviewScope } from './authority'
import { buildDiffFilePatch, diffDigest, diffFileVersion, gitBlobHash } from './patch'
import { buildGitHubFilePatch } from './github-patch'
import { diffFile, diffPage, type DiffDependencies } from './service'
import { manifestRevision, retainDiffSnapshot } from './store'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

const result = <T>(rows: T[], command = 'SELECT') => ({ rows, rowCount: rows.length, command, fields: [], oid: 0 })
type Query = (sql: string, values?: unknown[]) => Promise<ReturnType<typeof result<unknown>>>

/** This double controls only authority timing and retained storage. The real
 * service, scope checks, transaction wrapper and patch/store functions run.
 * PostgreSQL locking itself is covered by the separately gated DB suite. */
class Client extends EventEmitter {
  constructor(readonly execute: Query) { super() }
  query(sql: string, values: unknown[] = []) { return this.execute(sql, values) }
  release() { this.removeAllListeners() }
}

async function fixture(source: 'commit' | 'pull_request' = 'pull_request', origin: 'local' | 'github' = 'github') {
  const runId = randomUUID(), repoId = randomUUID(), workspaceId = randomUUID()
  const actor: ReviewActor = { userId: 'diff-service-owner', workspaceId, credential: { kind: 'session', id: randomUUID() } }
  const identity = { version: 1 as const, runId, repoId, workspaceId, ownerId: actor.userId,
    repositoryKey: 'v2/github.com/mikka-fixtures/review-race' }
  const scope: ReviewScope = { identity, taskId: null, boardId: reviewBoardId(identity, null), status: 'stopped', stopped: true }
  const state = { member: true, session: true, membershipChecks: 0, protectedReads: 0 }
  let snapshot: DiffSnapshot | undefined
  let stored: (Record<string, unknown> & { path: string; position: number; metadata: DiffFileMetadata; patch: DiffFilePatch | null }) | undefined
  const query: Query = async (sql, values = []) => {
    const text = sql.replace(/\s+/g, ' ').trim()
    if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)\b/i.test(text)) return result([], text.split(' ')[0]!.toUpperCase())
    if (text === 'SELECT 1' || text.includes('pg_advisory_xact_lock')) return result([{}])
    if (text.includes('FROM mikka_workspaces') || text.includes('FROM mikka_workspace_members')) {
      state.membershipChecks++
      return result(state.member ? [{ id: workspaceId, userId: actor.userId }] : [])
    }
    if (text.includes('FROM "session"')) return result(state.session ? [{ id: actor.credential.id }] : [])
    if (text.includes('FROM workspace_deletions')) return result([])
    if (text.startsWith('SELECT "issueId" FROM agent_runs')) return result([{ issueId: null }])
    if (text.includes('FROM coding_workspace_bindings b JOIN agent_runs')) return result([{
      ...identity, userId: actor.userId, issueId: null, status: scope.status, stopped: true,
      frozenWorkspace: workspaceId, admissionWorkspace: workspaceId, frozenKey: identity.repositoryKey, publicationKey: null,
    }])
    if (text.startsWith('SELECT snapshot FROM coding_workspace_snapshots')) return result(snapshot ? [{ snapshot }] : [])
    if (text.startsWith('SELECT count(*)::int AS count FROM coding_workspace_snapshots')) return result([{ count: snapshot ? 1 : 0 }])
    if (text.includes('coalesce(sum(octet_length(f.patch::text)),0)')) return result([{ bytes: 0 }])
    if (text.startsWith('INSERT INTO coding_workspace_snapshots')) {
      snapshot = values.at(-1) as DiffSnapshot
      return result([], 'INSERT')
    }
    if (text.startsWith('INSERT INTO coding_workspace_snapshot_files')) {
      const rows = JSON.parse(String(values[1]))
      assert.equal(rows.length, 1)
      stored = rows[0]
      return result([], 'INSERT')
    }
    if (text.startsWith('INSERT INTO coding_workspace_review_boards')) return result([], 'INSERT')
    if (text.startsWith('SELECT s.snapshot,count(f.path)')) {
      assert.ok(snapshot && stored)
      return result([{ snapshot, files: 1, additions: stored.patch?.file.additions ?? 0,
        deletions: stored.patch?.file.deletions ?? 0, complete: Boolean(stored.patch) }])
    }
    if (text.startsWith('SELECT f.metadata,f.patch')) {
      assert.ok(stored)
      state.protectedReads++
      return result([{ ...stored }])
    }
    if (text.startsWith('WITH entries AS')) {
      assert.ok(stored)
      state.protectedReads++
      return result([{ revision: 0, files: [{ metadata: stored.patch?.file ?? stored.metadata,
        position: stored.position, reviewedAt: null }] }])
    }
    throw new Error(`Unexpected fixture query: ${text}`)
  }
  const database = { query, connect: async () => new Client(query) } as unknown as Pool
  const mask = await secretMaskerFor({ workspaceId, ownerId: actor.userId })
  const before = Buffer.from('before\n'), after = Buffer.from('retained visible source\n')
  const initial: DiffRevision = { source, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40),
    treeSha: 'c'.repeat(40), version: '0'.repeat(64) }
  const sourceAccess: DiffSourceAccess | undefined = origin === 'github' ? { kind: 'github', repositoryId: '61393725',
    ...(source === 'pull_request' ? { pullRequestNumber: 1 } : {}), manifestComplete: true } : undefined
  const nativePatch = '@@ -1 +1 @@\n-before\n+retained visible source\n'
  const file: DiffFileMetadata = { path: 'demo.txt', previousPath: null, status: 'modified',
    oldBlob: gitBlobHash(before, initial.baseSha!), newBlob: gitBlobHash(after, initial.headSha!), oldMode: '100644', newMode: '100644',
    oldSize: before.length, newSize: after.length, additions: 0, deletions: 0, binary: false, fileVersion: '0'.repeat(64),
    ...(sourceAccess ? { github: { repositoryId: sourceAccess.repositoryId,
      patchSha256: source === 'pull_request' ? diffDigest(nativePatch) : null, page: source === 'pull_request' ? 1 : null } } : {}) }
  file.fileVersion = diffFileVersion(repoId, initial, file)
  const revision = manifestRevision(initial.source, initial.baseSha, initial.headSha, initial.treeSha, [file], sourceAccess)
  const patchInput = { snapshotId: randomUUID(), sourceVersion: revision.version, file, before, after }
  const patch = source === 'pull_request' ? buildGitHubFilePatch({ ...patchInput, nativePatch }, mask) : buildDiffFilePatch(patchInput, mask)
  const saved = await retainDiffSnapshot(new Client(query) as unknown as PoolClient, scope, { revision, files: [file],
    sourceAccess, patches: new Map([[file.path, patch]]), pullRequest: source === 'pull_request'
      ? { number: 1, url: 'https://github.com/mikka-fixtures/review-race/pull/1', headSha: revision.headSha!, state: 'open' } : null }, mask)
  const entered = deferred(), release = deferred()
  const deps: DiffDependencies = { database, membership: database, external: {
    async verify() { entered.resolve(); await release.promise },
    async capture() { throw new Error('A retained read must not recapture source') },
    async file() { throw new Error('A retained read must not fetch new source') },
  } }
  return { actor, runId, repoId, snapshot: saved, state, deps, entered, release }
}

const denied = (error: unknown) => error instanceof CodingWorkspaceError && error.code === 'workspace_not_found'

test('retained Diff responses recheck authority after provider verification', { timeout: 10_000 }, async t => {
  // No saved secrets or database connections are needed for these timing tests.
  // The real runtime masker and the real retained-store policy still execute.
  const previous = process.env.WORKSPACE_SECRETS_KEY
  delete process.env.WORKSPACE_SECRETS_KEY
  try {
    await t.test('Run, workspace and owner maskers retain the same no-secret source policy', async () => {
      const workspaceId = randomUUID()
      const masks = await Promise.all([
        runSecretMasker(randomUUID(), {}), workspaceSecretMasker(workspaceId, {}),
        secretMaskerFor({ workspaceId, ownerId: 'diff-service-owner' }, {}),
      ])
      assert.ok(masks[0]!.sourcePolicy, 'a deployment without saved-secret configuration still certifies the default rules')
      assert.ok(masks.every(mask => mask.sourcePolicy === masks[0]!.sourcePolicy))
      const token = `ghp_${'A'.repeat(36)}`
      assert.ok(masks.every(mask => !mask(token).includes(token)), 'the no-secret policy still applies default credential detection')
    })
    for (const source of ['commit', 'pull_request'] as const) for (const kind of ['file', 'page'] as const) {
      const read = (f: Awaited<ReturnType<typeof fixture>>) => kind === 'file'
        ? diffFile(f.deps, f.actor, f.runId, f.repoId, f.snapshot.id, 'demo.txt')
        : diffPage(f.deps, f.actor, f.runId, f.repoId, { snapshotId: f.snapshot.id })
      await t.test(`${source} ${kind}: an unchanged authority returns the real retained projection`, async () => {
        const f = await fixture(source), pending = read(f)
        await f.entered.promise
        f.release.resolve()
        const value = await pending
        const publicResult = JSON.stringify(value)
        assert.ok(publicResult.includes('demo.txt'))
        assert.ok(!publicResult.includes('maskPolicy') && !publicResult.includes('sourcePolicy'), 'private mask state does not become response content')
        assert.ok(f.state.protectedReads > 0)
      })
      for (const revoked of ['member', 'session'] as const) {
        await t.test(`${source} ${kind}: ${revoked} revoked while verify waits cannot receive retained source`, async () => {
          const f = await fixture(source), pending = read(f)
          const rejection = assert.rejects(pending, denied)
          await f.entered.promise
          f.state[revoked] = false
          f.release.resolve()
          await rejection
          assert.equal(f.state.protectedReads, 0, 'protected rows are not read under revoked authority')
        })
      }
    }
    for (const kind of ['file', 'page'] as const) await t.test(`local ${kind}: retained authority does not require a GitHub provider`, async () => {
      const f = await fixture('commit', 'local'), deps = { ...f.deps, external: undefined }
      assert.equal(f.snapshot.sourceAccess, undefined)
      const value = kind === 'file' ? await diffFile(deps, f.actor, f.runId, f.repoId, f.snapshot.id, 'demo.txt')
        : await diffPage(deps, f.actor, f.runId, f.repoId, { snapshotId: f.snapshot.id })
      assert.ok(JSON.stringify(value).includes('demo.txt'))
      assert.ok(f.state.protectedReads > 0)
    })
  } finally {
    if (previous === undefined) delete process.env.WORKSPACE_SECRETS_KEY
    else process.env.WORKSPACE_SECRETS_KEY = previous
  }
})
