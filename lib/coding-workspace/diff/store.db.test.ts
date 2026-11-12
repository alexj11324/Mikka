import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { gunzipSync } from 'node:zlib'
import { Pool } from 'pg'
import { observePoolCommits } from '../../db/commit-effects'
import { runAssignmentSchema } from '@mikka/protocol'
import { runCheckpointReceiptSchema, SOURCE_DAEMON_VERSION, type RunCheckpoint } from '@mikka/protocol/device'
import { CLIENT_VERSION_HEADER } from '@mikka/protocol/version'
import { remoteKey } from '@mikka/protocol/repository'
import { CodingWorkspaceError, workspaceReadReceipt, type WorkspaceReadCommand } from '@mikka/protocol/coding-workspace'
import { CHECKPOINT_REVIEW_MAX_PROOF_BYTES, checkpointReviewEvidence, WorkspaceReviewError,
  type DiffFileMetadata, type DiffFilePatch, type DiffSnapshot, type DiffSourceAccess } from '@mikka/protocol/coding-workspace-review'
import { readWorkspaceDiffReceipt } from '../../../packages/daemon/src/coding-workspace/diff'
import { takeCheckpoint } from '../../../packages/daemon/src/agents/checkpoint'
import type { JournalEntry } from '../../../packages/daemon/src/runs/journal'
import { orderMigrations } from '../../../scripts/migration-order.mjs'
import { disposableDatabase, E2E_DB_RULE } from '../../../tests/helpers/e2e-target.mjs'
import { dropTestDatabase } from '../../../tests/support/drop-test-database'
import type { ReviewActor } from './authority'

const url = process.env.E2E_DATABASE_URL
if (url) assert.ok(disposableDatabase(process.env, url), E2E_DB_RULE)
else if (process.env.REQUIRE_DB === '1') assert.fail('REQUIRE_DB=1 needs an isolated E2E_DATABASE_URL')
const execute = promisify(execFile)
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const code = (expected: string) => (error: unknown) =>
  (error instanceof CodingWorkspaceError || error instanceof WorkspaceReviewError) && error.code === expected
const sqlCode = (expected: string) => (error: unknown) => error !== null && typeof error === 'object' && 'code' in error && error.code === expected
const remote = 'https://github.com/mikka-fixtures/diff-store.git'

/** Real PostgreSQL and real Git receipts. Only framework request context is
 * supplied; authority, credentials, schema constraints and storage stay real. */
test('retained Diff snapshots, review authority and deletion on PostgreSQL 17', { skip: !url, timeout: 240_000 }, async t => {
  const admin = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000 })
  const database = `coding_workspace_diff_${randomUUID().replaceAll('-', '')}_e2e`
  const version = Number((await admin.query('SHOW server_version_num')).rows[0].server_version_num)
  assert.ok(version >= 170000 && version < 180000, 'Diff storage acceptance requires PostgreSQL 17')
  await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`)
  const target = new URL(url!); target.pathname = `/${database}`
  const pool = new Pool({ connectionString: target.toString(), max: 8, connectionTimeoutMillis: 5000 })
  observePoolCommits(pool)
  const root = await mkdtemp(join(tmpdir(), 'mikka-diff-store-db-'))
  const environment = {
    MIKKA_DATABASE_URL: target.toString(), DATABASE_URL: target.toString(), ORVILO_DATABASE_URL: target.toString(), E2E_DATABASE_URL: target.toString(),
    BETTER_AUTH_SECRET: randomBytes(32).toString('hex'), BETTER_AUTH_URL: 'http://127.0.0.1:3199', WORKSPACE_SECRETS_KEY: randomBytes(32).toString('hex'),
  }
  const previous = Object.fromEntries(Object.keys(environment).map(name => [name, process.env[name]]))
  Object.assign(process.env, environment)
  let appPool: Pool | undefined, workspacePool: Pool | undefined
  try {
    const directory = new URL('../../../drizzle/', import.meta.url)
    for (const name of orderMigrations((await readdir(directory)).filter(name => name.endsWith('.sql'))))
      await pool.query(await readFile(new URL(name, directory), 'utf8'))
    const next = await import('next/server')
    mock.module('next/server', { namedExports: { ...next, after() {} } })
    mock.module('next/headers', { namedExports: { headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set() {}, delete() {} }) } })
    mock.module('next-intl/server', { namedExports: { getLocale: async () => 'en', getTranslations: async () => Object.assign((key: string) => key, { has: () => true }) } })
    const { resolveRunWorktree } = await import('../identity')
    const { resolveReviewScope, withReviewTransaction } = await import('./authority')
    const { manifestRevision, retainDiffSnapshot, readDiffSnapshot, latestDiffSnapshot, readDiffFilePage, readStoredDiffFile, retainDiffFilePatch } = await import('./store')
    const { validateDiffReceipt } = await import('./receipt')
    const { diffFileVersion, validateReviewAnchor } = await import('./patch')
    const { secretMaskerFor } = await import('../../secrets/runtime')
    const { newDeviceToken, hashDeviceToken, issueDeviceToken } = await import('../../device-link')
    const { POST: checkpointPOST } = await import('../../../app/v1/runs/[runId]/checkpoint/route')
    const { prepareCheckpointReview, retainCheckpointReview } = await import('./checkpoint')
    const { diffPage, diffFile, ensureReviewScope } = await import('./service')
    appPool = (await import('../../db')).pool; workspacePool = (await import('../../workspace-db')).workspacePool

    async function session(userId: string) {
      const id = randomUUID()
      await pool.query('INSERT INTO "session"(id,token,"userId","expiresAt","createdAt","updatedAt") VALUES($1,$2,$3,now()+interval \'1 hour\',now(),now())',
        [id, randomUUID(), userId])
      return id
    }
    async function user() {
      const id = `diff-store-${randomUUID()}`
      await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())', [id, `${id}@example.invalid`])
      return { id, sessionId: await session(id) }
    }
    const owner = await user(), member = await user(), stranger = await user()
    type User = Awaited<ReturnType<typeof user>>
    async function workspace(person: User = owner, others: User[] = [member]) {
      const id = randomUUID(), teamId = randomUUID(), name = `Diff workspace ${id}`
      await pool.query('INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,$2,$3)', [id, person.id, name])
      for (const who of [person, ...others].filter((value, index, all) => all.findIndex(other => other.id === value.id) === index))
        await pool.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$3,$4,\'active\')',
          [id, who.id, `${who.id}@example.invalid`, who.id === person.id ? 'admin' : 'member'])
      await pool.query('INSERT INTO mikka_teams(id,"workspaceId","userId",name,identifier) VALUES($1,$2,$3,\'Diff fixture\',$4)',
        [teamId, id, person.id, `D${randomUUID().replaceAll('-', '').slice(0, 7).toUpperCase()}`])
      await pool.query('INSERT INTO mikka_team_members("teamId","userId",role) VALUES($1,$2,\'owner\')', [teamId, person.id])
      return { id, teamId, name }
    }
    const firstWorkspace = await workspace(), otherWorkspace = await workspace()
    type Workspace = Awaited<ReturnType<typeof workspace>>
    const actor = (person: User, where: Workspace): ReviewActor => ({ userId: person.id, workspaceId: where.id,
      credential: { kind: 'session', id: person.sessionId } })
    const git = async (cwd: string, ...args: string[]) => (await execute('git', ['-C', cwd, '-c', 'user.name=Diff store fixture',
      '-c', 'user.email=diff-store@example.invalid', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args])).stdout.trim()

    async function fixture(options: { task?: boolean; person?: User; where?: Workspace; bot?: boolean } = {}) {
      const person = options.person ?? owner, where = options.where ?? firstWorkspace
      const runId = randomUUID(), repoId = randomUUID(), deviceId = randomUUID(), tokenId = randomUUID(), agentId = randomUUID()
      const repository = join(root, runId, 'repository'), worktree = join(root, runId, 'checkout')
      await mkdir(repository, { recursive: true })
      await git(repository, 'init', '--initial-branch=main')
      await git(repository, 'config', 'core.autocrlf', 'false')
      await git(repository, 'remote', 'add', 'origin', remote)
      for (const path of ['alpha.txt', 'beta.txt', 'gamma.txt']) await writeFile(join(repository, path), `before ${path}\n`)
      await git(repository, 'add', '--all'); await git(repository, 'commit', '-qm', 'frozen base')
      await git(repository, 'worktree', 'add', '-q', '--detach', worktree, 'HEAD')
      const baseSha = await git(worktree, 'rev-parse', 'HEAD')
      const taskId = options.task === false ? null : randomUUID(), botId = options.bot ? randomUUID() : null
      if (taskId) {
        await pool.query(`INSERT INTO issues(id,"userId","workspaceId",title,content,status,priority,scope)
          VALUES($1,$2,$3,'Diff fixture','{"type":"doc","content":[]}','doing','normal','workspace')`, [taskId, person.id, where.id])
        await pool.query('INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId") VALUES($1,$2,$3,$4)', [taskId, where.teamId, where.id, person.id])
      }
      if (botId) await pool.query('INSERT INTO bots(id,"workspaceId","ownerId",name) VALUES($1,$2,$3,$4)', [botId, where.id, person.id, `Diff bot ${botId}`])
      await pool.query('INSERT INTO devices(id,"ownerId",name,kind) VALUES($1,$2,\'Diff fixture\',\'local\')', [deviceId, person.id])
      await pool.query('INSERT INTO agents(id,"userId",name,harness,"deviceId") VALUES($1,$2,$3,\'codex\',$4)', [agentId, person.id, `Diff ${runId}`, deviceId])
      await pool.query('INSERT INTO device_repos(id,"userId","deviceId","repoPath","remoteUrl") VALUES($1,$2,$3,$4,$5)', [repoId, person.id, deviceId, remoteKey(remote), remote])
      await pool.query('INSERT INTO device_tokens(id,"userId","tokenHash","expiresAt") VALUES($1,$2,$3,now()+interval \'1 hour\')', [tokenId, person.id, hash(randomUUID())])
      await pool.query(`INSERT INTO agent_runs(id,"userId","issueId","botId","agentId","deviceId","deviceRepoId","deviceTokenId",status,"worktreePath","leaseExpiresAt","agentDefinition")
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'running',$9,now()+interval '10 minutes',$10)`,
      [runId, person.id, taskId, botId, agentId, deviceId, repoId, tokenId, worktree,
        { executionIdentity: { workspaceId: where.id }, repositoryAdmission: { workspaceId: where.id, remoteKey: remoteKey(remote) } }])
      const who = actor(person, where), identity = (await resolveRunWorktree(pool, pool, who, runId, repoId)).identity
      const entry: JournalEntry = { assignment: runAssignmentSchema.parse({ runId, issueId: taskId ?? randomUUID(), repoId, deviceId,
        remoteUrl: remote, baseBranch: 'main', harness: 'codex', prompt: 'Diff fixture', kind: 'implement' }),
      state: 'running', sessionId: null, worktree, baseCommit: baseSha, lastSeq: 0, error: null, updatedAt: new Date().toISOString() }
      const write = (path: string, text: string) => writeFile(join(worktree, path), text)
      for (const path of ['alpha.txt', 'beta.txt', 'gamma.txt']) await write(path, `after ${path}\n`)
      return { runId, repoId, deviceId, tokenId, taskId, botId, person, where, who, identity, entry, repository, worktree, write }
    }
    type Fixture = Awaited<ReturnType<typeof fixture>>
    const maskFor = (f: Fixture) => secretMaskerFor({ workspaceId: f.where.id, ownerId: f.person.id })
    const command = (f: Fixture, request: WorkspaceReadCommand['request']): WorkspaceReadCommand => ({
      id: randomUUID(), identity: f.identity, request, expiresAt: new Date(Date.now() + 15_000).toISOString(),
    })
    async function filePatch(f: Fixture, snapshot: Pick<DiffSnapshot, 'id' | 'revision'>, file: DiffFileMetadata) {
      const request = { kind: 'diff_file' as const, snapshotId: snapshot.id, revision: snapshot.revision, file }
      const proof = workspaceReadReceipt.parse(await readWorkspaceDiffReceipt(command(f, request), f.entry, f.repository))
      const result = validateDiffReceipt(request, proof, await maskFor(f))
      assert.ok(result?.ok && result.kind === 'diff_file')
      const patch: DiffFilePatch = { snapshotId: result.snapshotId, sourceVersion: result.sourceVersion, file: result.file,
        format: result.format, patch: result.patch, hunks: result.hunks }
      return { patch, proof }
    }
    async function capture(f: Fixture, eager = false) {
      const request = { kind: 'diff_snapshot' as const, source: 'working' as const }
      const proof = workspaceReadReceipt.parse(await readWorkspaceDiffReceipt(command(f, request), f.entry, f.repository))
      const mask = await maskFor(f), result = validateDiffReceipt(request, proof, mask)
      assert.ok(result?.ok && result.kind === 'diff_snapshot')
      const patches = new Map<string, DiffFilePatch>()
      if (eager) for (const file of result.files) patches.set(file.path, (await filePatch(f, { id: randomUUID(), revision: result.revision }, file)).patch)
      const snapshot = await withReviewTransaction(pool, pool, f.who, f.runId, f.repoId,
        (client, scope) => retainDiffSnapshot(client, scope, { revision: result.revision, files: result.files, patches,
          observedAt: result.observedAt }, mask), { live: f.identity })
      return { snapshot, files: result.files }
    }
    const scopeFor = (f: Fixture, who = f.who) => resolveReviewScope(pool, pool, who, f.runId, f.repoId)
    const ensureScope = (f: Fixture, who = f.who, repoId = f.repoId) => ensureReviewScope(
      { database: pool, membership: pool }, who, f.runId, repoId)
    async function assertUnbound(f: Fixture) {
      assert.equal((await pool.query('SELECT 1 FROM coding_workspace_bindings WHERE "runId"=$1', [f.runId])).rowCount, 0)
      assert.equal((await pool.query('SELECT 1 FROM coding_workspace_review_boards WHERE "runId"=$1 OR "taskId"=$2',
        [f.runId, f.taskId])).rowCount, 0)
    }
    async function stopWithoutLiveToken(f: Fixture) {
      await pool.query(`UPDATE agent_runs SET status='stopped',"stopRequestedAt"=now(),"finishedAt"=now(),
        "leaseExpiresAt"=now()-interval '1 minute' WHERE id=$1`, [f.runId])
      await pool.query(`UPDATE device_tokens SET "revokedAt"=now(),"expiresAt"=now()-interval '1 minute' WHERE id=$1`, [f.tokenId])
    }
    const read = (f: Fixture, id: string, who = f.who) => withReviewTransaction(pool, pool, who, f.runId, f.repoId,
      (client, scope) => readDiffSnapshot(client, scope, id))
    async function retire(f: Fixture) {
      await pool.query('UPDATE agent_runs SET status=\'stopped\',"stopRequestedAt"=now(),"finishedAt"=now() WHERE id=$1', [f.runId])
      await pool.query('DELETE FROM devices WHERE id=$1', [f.deviceId])
      assert.deepEqual((await pool.query('SELECT "deviceId","deviceRepoId" FROM agent_runs WHERE id=$1', [f.runId])).rows,
        [{ deviceId: null, deviceRepoId: null }])
      assert.equal((await pool.query('SELECT 1 FROM device_repos WHERE id=$1', [f.repoId])).rowCount, 0)
    }
    async function comment(f: Fixture, snapshot: DiffSnapshot, userId: string, body = 'Review fixture') {
      const id = randomUUID(), scope = await scopeFor(f)
      const { patch } = await readStoredDiffFile(pool, scope, snapshot, 'alpha.txt', await maskFor(f))
      assert.ok(patch?.hunks[0], 'the fixture comment anchors a real, retained, verified hunk')
      const anchor = validateReviewAnchor({ snapshotId: snapshot.id, sourceVersion: snapshot.revision.version,
        path: 'alpha.txt', side: 'RIGHT', lineStart: 1, lineEnd: 1, hunkFingerprint: patch.hunks[0].fingerprint }, patch)
      await pool.query(`INSERT INTO coding_workspace_review_comments(id,"threadId","boardId","snapshotId","userId",anchor,body,draft)
        VALUES($1,$1,$2,$3,$4,$5,$6,false)`, [id, scope.boardId, snapshot.id, userId, anchor, body])
      return id
    }
    async function reviewRows(f: Fixture, snapshot: DiffSnapshot, userId: string) {
      const scope = await scopeFor(f), commentId = await comment(f, snapshot, userId)
      const { file } = await readStoredDiffFile(pool, scope, snapshot, 'alpha.txt', await maskFor(f))
      await pool.query('INSERT INTO coding_workspace_reviewed_files("boardId","userId",path,"fileVersion") VALUES($1,$2,$3,$4)',
        [scope.boardId, userId, file.path, file.fileVersion])
      await pool.query(`INSERT INTO coding_workspace_review_receipts("boardId","userId","requestId",fingerprint,action,response)
        VALUES($1,$2,$3,$4,'create',$5)`, [scope.boardId, userId, randomUUID(), hash(commentId), { commentId }])
      await pool.query(`INSERT INTO coding_workspace_review_batches(id,"boardId","snapshotId","userId",fingerprint,destination,state,input)
        VALUES($1,$2,$3,$4,$5,'agent','prepared',$6)`, [randomUUID(), scope.boardId, snapshot.id, userId, hash(commentId), { commentIds: [commentId] }])
      return { scope, commentId }
    }

    async function checkpointFixture() {
      const f = await fixture(), token = newDeviceToken()
      await pool.query('UPDATE device_tokens SET "tokenHash"=$2 WHERE id=$1', [f.tokenId, hashDeviceToken(token)])
      return { ...f, token }
    }
    type CheckpointFixture = Awaited<ReturnType<typeof checkpointFixture>>
    async function nativeCheckpoint(f: Fixture) {
      assert.ok(f.entry.baseCommit)
      const captured = await takeCheckpoint({ repoPath: f.repository, worktree: f.worktree,
        baseCommit: f.entry.baseCommit, repoId: f.repoId })
      assert.ok(captured, 'a capture without a previous tree returns the current real Git checkpoint')
      return captured.checkpoint
    }
    const checkpointState = async (f: Fixture) => ({
      recovery: (await pool.query('SELECT "baseCommit",patch,files,"takenAt","unavailableReason" FROM run_checkpoints WHERE "runId"=$1', [f.runId])).rows[0],
      review: (await pool.query('SELECT "snapshotId","baseSha","headSha","treeSha",reason,"capturedAt" FROM coding_workspace_checkpoint_reviews WHERE "runId"=$1', [f.runId])).rows[0],
    })
    const checkpointPage = (f: Fixture) => diffPage({ database: pool, membership: pool }, f.who, f.runId, f.repoId,
      { selection: { source: 'checkpoint' } })
    const postCheckpoint = (f: CheckpointFixture, checkpoint: RunCheckpoint, token: string | null = f.token) => checkpointPOST(
      new Request(`http://127.0.0.1:3199/v1/runs/${f.runId}/checkpoint`, { method: 'POST',
        headers: { 'content-type': 'application/json', [CLIENT_VERSION_HEADER]: SOURCE_DAEMON_VERSION,
          ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(checkpoint) }),
      { params: Promise.resolve({ runId: f.runId }) })
    async function acknowledgeCheckpoint(f: CheckpointFixture, checkpoint: RunCheckpoint, token = f.token) {
      const response = await postCheckpoint(f, checkpoint, token)
      assert.equal(response.status, 200, 'the real authenticated checkpoint route accepts the recovery point')
      const body = await response.json()
      assert.deepEqual(Object.keys(body).sort(), ['runId', 'takenAt'], 'the recovery ACK contract must not grow review fields')
      const receipt = runCheckpointReceiptSchema.parse(body), state = await checkpointState(f)
      assert.ok(state.recovery, 'the ACK follows a committed recovery record')
      assert.ok(state.review, 'the admitted live Run also commits its latest review observation')
      assert.equal(receipt.runId, f.runId)
      assert.equal(receipt.takenAt, state.recovery.takenAt.toISOString(), 'ACK names the committed server timestamp')
      assert.equal(receipt.takenAt, state.review.capturedAt.toISOString(), 'review pointer and recovery share one committed observation')
      return { receipt, ...state }
    }

    await t.test('a native checkpoint retains verified patches, discards private proofs and remains readable after Stop and device deletion', async () => {
      const f = await checkpointFixture(), checkpoint = await nativeCheckpoint(f)
      const proof = checkpointReviewEvidence.parse(checkpoint.review), mask = await maskFor(f)
      assert.equal(proof.reason, null)
      assert.equal(proof.files.length, 3)
      assert.equal(proof.blobs.length, 6, 'both full Git blobs of each modified file are present')
      for (const blob of proof.blobs) {
        const bytes = Buffer.from(blob.base64, 'base64')
        assert.equal(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), blob.sha)
      }
      const prepared = prepareCheckpointReview(checkpoint, f.repoId, mask)
      assert.equal(prepared.reason, null)
      assert.equal(prepared.input?.patches?.size, 3)
      const saved = await acknowledgeCheckpoint(f, { ...checkpoint, takenAt: '2099-01-01T00:00:00.000Z' })
      assert.notEqual(saved.receipt.takenAt, '2099-01-01T00:00:00.000Z', 'device clock never becomes recovery authority')
      assert.deepEqual(gunzipSync(saved.recovery.patch), gunzipSync(Buffer.from(checkpoint.patch, 'base64')))
      assert.equal(saved.review.reason, null)
      assert.ok(saved.review.snapshotId)
      const before = await checkpointPage(f)
      assert.equal(before.snapshot.id, saved.review.snapshotId)
      assert.equal(before.snapshot.revision.source, 'checkpoint')
      assert.deepEqual(before.snapshot.counts, { files: 3, additions: 3, deletions: 3, complete: true })
      const persisted = (await pool.query(`SELECT s.snapshot,f.metadata,f.patch FROM coding_workspace_snapshots s
        JOIN coding_workspace_snapshot_files f ON f."snapshotId"=s.id WHERE s.id=$1 ORDER BY f.path`, [saved.review.snapshotId])).rows
      assert.equal(persisted.length, 3)
      assert.ok(persisted.every(row => row.patch.format === 'text' && row.patch.hunks.length === 1))
      const serialized = JSON.stringify(persisted)
      for (const name of ['blobs', 'base64', 'review']) assert.ok(!serialized.includes(`"${name}":`), 'private checkpoint proof is not stored in review JSON')
      for (const blob of proof.blobs) assert.ok(!serialized.includes(blob.base64), 'full source encodings never become retained patch data')
      await retire(f)
      const history = await checkpointPage(f)
      assert.equal(history.snapshot.id, before.snapshot.id)
      assert.equal(history.snapshot.observedAt, saved.receipt.takenAt)
      assert.equal(history.snapshot.isStale, true)
      assert.equal(history.files.length, 3)
      const patch = await diffFile({ database: pool, membership: pool }, f.who, f.runId, f.repoId, history.snapshot.id, 'alpha.txt')
      assert.ok(patch.patch?.includes('+after alpha.txt'))
      assert.equal((await pool.query('SELECT 1 FROM coding_workspace_requests WHERE "runId"=$1', [f.runId])).rowCount, 0,
        'checkpoint history never queues a live daemon read')
    })

    await t.test('malformed full-source evidence still ACKs recovery and replaces the latest good review with an honest unavailable observation', async () => {
      const f = await checkpointFixture(), first = await acknowledgeCheckpoint(f, await nativeCheckpoint(f))
      await f.write('alpha.txt', 'second recovery remains intact\n')
      const checkpoint = await nativeCheckpoint(f), proof = checkpointReviewEvidence.parse(checkpoint.review)
      assert.ok(proof.blobs[0])
      proof.blobs[0].base64 = Buffer.from('not the claimed Git object').toString('base64')
      const malformed = { ...checkpoint, review: proof }
      assert.equal(prepareCheckpointReview(malformed, f.repoId, await maskFor(f)).reason, 'missing_evidence')
      const current = await acknowledgeCheckpoint(f, malformed)
      assert.deepEqual(gunzipSync(current.recovery.patch), gunzipSync(Buffer.from(checkpoint.patch, 'base64')))
      assert.equal(current.review.snapshotId, null)
      assert.equal(current.review.reason, 'missing_evidence')
      assert.ok(Date.parse(current.receipt.takenAt) > Date.parse(first.receipt.takenAt))
      const page = await checkpointPage(f)
      assert.equal(page.snapshot.availability, 'unavailable')
      assert.equal(page.snapshot.reason, 'missing_evidence')
      assert.equal(page.snapshot.observedAt, current.receipt.takenAt)
      assert.notEqual(page.snapshot.id, first.review.snapshotId)
      assert.deepEqual(page.files, [])
      assert.equal((await read(f, first.review.snapshotId)).id, first.review.snapshotId, 'old history remains explicitly addressable')
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM coding_workspace_snapshots WHERE "runId"=$1', [f.runId])).rows[0].count, 1)
    })

    await t.test('real Git evidence above the proof budget preserves its smaller recovery patch without serving the old good checkpoint as latest', async () => {
      const f = await checkpointFixture(), first = await acknowledgeCheckpoint(f, await nativeCheckpoint(f))
      const bytesPerFile = Math.ceil(CHECKPOINT_REVIEW_MAX_PROOF_BYTES / 5) + 64
      for (let index = 0; index < 5; index++) await f.write(`budget-${index}.txt`, `${String(index).repeat(bytesPerFile)}\n`)
      const checkpoint = await nativeCheckpoint(f), proof = checkpointReviewEvidence.parse(checkpoint.review)
      assert.equal(proof.reason, 'too_large', 'actual distinct Git blobs exceed the aggregate 4 MiB review budget')
      assert.deepEqual(proof.blobs, [], 'the daemon never sends a partial source proof')
      assert.equal(checkpoint.unavailableReason, undefined, 'the compressible recovery payload is still admissible')
      assert.equal(prepareCheckpointReview(checkpoint, f.repoId, await maskFor(f)).reason, 'too_large')
      const saved = await acknowledgeCheckpoint(f, checkpoint)
      assert.equal(saved.recovery.unavailableReason, null)
      assert.deepEqual(gunzipSync(saved.recovery.patch), gunzipSync(Buffer.from(checkpoint.patch, 'base64')))
      assert.equal(saved.review.snapshotId, null)
      assert.equal(saved.review.reason, 'too_large')
      const page = await checkpointPage(f)
      assert.equal(page.snapshot.availability, 'unavailable')
      assert.equal(page.snapshot.reason, 'too_large')
      assert.equal(page.snapshot.observedAt, saved.receipt.takenAt)
      assert.notEqual(page.snapshot.id, first.review.snapshotId)
      assert.equal((await read(f, first.review.snapshotId)).counts.files, 3)
    })

    await t.test('unchanged checkpoint content refreshes observation time and a new empty tree supersedes the prior nonempty snapshot', async () => {
      const f = await checkpointFixture(), first = await acknowledgeCheckpoint(f, await nativeCheckpoint(f))
      const original = await read(f, first.review.snapshotId)
      const repeated = await acknowledgeCheckpoint(f, { ...await nativeCheckpoint(f), takenAt: '2000-01-01T00:00:00.000Z' })
      assert.equal(repeated.review.snapshotId, first.review.snapshotId, 'same source version deduplicates immutable content')
      assert.ok(Date.parse(repeated.receipt.takenAt) > Date.parse(first.receipt.takenAt))
      assert.equal((await read(f, first.review.snapshotId)).observedAt, original.observedAt, 'stored snapshot time remains immutable')
      assert.equal((await checkpointPage(f)).snapshot.observedAt, repeated.receipt.takenAt, 'latest observation uses the new server receipt')
      await git(f.worktree, 'checkout', f.entry.baseCommit!, '--', 'alpha.txt', 'beta.txt', 'gamma.txt')
      const empty = await nativeCheckpoint(f), proof = checkpointReviewEvidence.parse(empty.review)
      assert.equal(empty.files, 0)
      assert.equal(gunzipSync(Buffer.from(empty.patch, 'base64')).length, 0)
      assert.deepEqual(proof.files, [])
      assert.deepEqual(proof.blobs, [])
      assert.equal(proof.reason, null)
      const saved = await acknowledgeCheckpoint(f, empty), page = await checkpointPage(f)
      assert.ok(saved.review.snapshotId)
      assert.notEqual(saved.review.snapshotId, first.review.snapshotId)
      assert.equal(saved.review.reason, null)
      assert.equal(page.snapshot.id, saved.review.snapshotId)
      assert.equal(page.snapshot.availability, 'empty')
      assert.equal(page.snapshot.observedAt, saved.receipt.takenAt)
      assert.deepEqual(page.snapshot.counts, { files: 0, additions: 0, deletions: 0, complete: true })
      assert.deepEqual(page.files, [])
    })

    await t.test('fresh complete checkpoint proofs cannot mark an immutable snapshot from an older secret policy as latest available', async () => {
      const f = await checkpointFixture(), checkpoint = await nativeCheckpoint(f), oldMask = await maskFor(f)
      const firstProof = checkpointReviewEvidence.parse(checkpoint.review)
      const first = await acknowledgeCheckpoint(f, checkpoint)
      assert.ok(first.review.snapshotId)
      assert.equal(first.review.reason, null)
      const stored = (await pool.query('SELECT path,patch,"maskPolicy" FROM coding_workspace_snapshot_files WHERE "snapshotId"=$1 ORDER BY path',
        [first.review.snapshotId])).rows
      assert.equal(stored.length, 3)
      const { sealSecret, userSecretAad } = await import('../../secrets/crypto')
      const secret = `unrelated-checkpoint-recapture-${randomUUID()}`
      const row = { id: randomUUID(), userId: f.person.id, name: 'DIFF_CHECKPOINT_RECAPTURE_FIXTURE', kind: 'secret' }
      const sealed = sealSecret(secret, userSecretAad(row))
      await pool.query('INSERT INTO user_secrets(id,"userId",name,kind,ciphertext,iv,"keyVersion") VALUES($1,$2,$3,$4,$5,$6,$7)',
        [row.id, row.userId, row.name, row.kind, sealed.ciphertext, sealed.iv, sealed.keyVersion])
      try {
        const freshMask = await maskFor(f), repeated = await nativeCheckpoint(f)
        assert.notEqual(freshMask(secret), secret, 'the new policy decrypts the real encrypted owner secret')
        assert.notEqual(freshMask.sourcePolicy, oldMask.sourcePolicy)
        const freshProof = checkpointReviewEvidence.parse(repeated.review)
        assert.deepEqual(freshProof.revision, firstProof.revision, 'the unchanged real Git content has the identical source version')
        const prepared = prepareCheckpointReview(repeated, f.repoId, freshMask)
        assert.equal(prepared.reason, null, 'the unrelated new secret does not occur in either complete source blob')
        assert.equal(prepared.input?.patches?.size, 3, 'all files have newly validated complete proofs')
        const current = await acknowledgeCheckpoint(f, repeated)
        assert.equal(current.recovery.unavailableReason, null)
        assert.deepEqual(gunzipSync(current.recovery.patch), gunzipSync(Buffer.from(repeated.patch, 'base64')),
          'review deduplication refusal does not change the valid recovery patch')
        assert.ok(Date.parse(current.receipt.takenAt) > Date.parse(first.receipt.takenAt))
        assert.equal(current.review.snapshotId, null, 'the catch path must clear an already assigned deduplicated snapshot')
        assert.equal(current.review.reason, 'missing_evidence')
        const page = await checkpointPage(f)
        assert.equal(page.snapshot.availability, 'unavailable')
        assert.equal(page.snapshot.reason, 'missing_evidence')
        assert.equal(page.snapshot.observedAt, current.receipt.takenAt)
        assert.notEqual(page.snapshot.id, first.review.snapshotId)
        assert.deepEqual(page.files, [])
        assert.deepEqual((await pool.query('SELECT path,patch,"maskPolicy" FROM coding_workspace_snapshot_files WHERE "snapshotId"=$1 ORDER BY path',
          [first.review.snapshotId])).rows, stored, 'old immutable patches and their private validation policy are unchanged')
        assert.equal((await pool.query('SELECT count(*)::int AS count FROM coding_workspace_snapshots WHERE "runId"=$1', [f.runId])).rows[0].count, 1)
        await assert.rejects(() => diffFile({ database: pool, membership: pool }, f.who, f.runId, f.repoId,
          first.review.snapshotId, 'alpha.txt'), code('workspace_path_unavailable'))
      } finally { await pool.query('DELETE FROM user_secrets WHERE id=$1', [row.id]) }
    })

    await t.test('real checkpoint authentication, current claim token, Stop and device takeover reject unauthorized recovery overwrites', async () => {
      const f = await checkpointFixture(), checkpoint = await nativeCheckpoint(f)
      assert.equal((await postCheckpoint(f, checkpoint, null)).status, 401)
      const saved = await acknowledgeCheckpoint(f, checkpoint), original = await checkpointState(f)
      const replacementToken = await issueDeviceToken(f.person.id, 'checkpoint claim fixture')
      const replacementId = (await pool.query('SELECT id FROM device_tokens WHERE "tokenHash"=$1', [hashDeviceToken(replacementToken)])).rows[0].id
      assert.equal((await postCheckpoint(f, checkpoint, replacementToken)).status, 409, 'another valid login has not claimed this Run')
      assert.deepEqual(await checkpointState(f), original)
      await pool.query('UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1', [f.runId])
      assert.equal((await postCheckpoint(f, checkpoint)).status, 409)
      assert.deepEqual(await checkpointState(f), original, 'Stop preserves both the recovery point and review pointer')
      await pool.query('UPDATE agent_runs SET "stopRequestedAt"=NULL,"deviceTokenId"=$2 WHERE id=$1', [f.runId, replacementId])
      assert.equal((await postCheckpoint(f, checkpoint)).status, 409, 'a previous claim token cannot follow a new login')
      assert.deepEqual(await checkpointState(f), original)
      const renewed = await acknowledgeCheckpoint(f, checkpoint, replacementToken)
      assert.equal(renewed.review.snapshotId, saved.review.snapshotId)
      const beforeTakeover = await checkpointState(f), successor = await checkpointFixture()
      await pool.query('UPDATE agent_runs SET "deviceId"=$2,"deviceRepoId"=$3,"deviceTokenId"=$4,"worktreePath"=$5 WHERE id=$1',
        [f.runId, successor.deviceId, successor.repoId, successor.tokenId, successor.worktree])
      for (const token of [f.token, replacementToken]) assert.equal((await postCheckpoint(f, checkpoint, token)).status, 409)
      assert.deepEqual(await checkpointState(f), beforeTakeover, 'old-device credentials cannot overwrite a takeover recovery point')
    })

    await t.test('retaining a prepared checkpoint rechecks the real secret policy and a refused proof does not block a masked recovery ACK', async () => {
      const f = await checkpointFixture(), first = await acknowledgeCheckpoint(f, await nativeCheckpoint(f))
      const secret = `checkpoint-source-secret-${randomUUID()}`
      await f.write('alpha.txt', `after ${secret}\n`)
      const checkpoint = await nativeCheckpoint(f), oldMask = await maskFor(f)
      const prepared = prepareCheckpointReview(checkpoint, f.repoId, oldMask)
      assert.equal(prepared.reason, null, 'source was not registered as a secret during preparation')
      const { sealSecret, userSecretAad } = await import('../../secrets/crypto')
      const row = { id: randomUUID(), userId: owner.id, name: 'DIFF_CHECKPOINT_POLICY_FIXTURE', kind: 'secret' }
      const sealed = sealSecret(secret, userSecretAad(row))
      await pool.query('INSERT INTO user_secrets(id,"userId",name,kind,ciphertext,iv,"keyVersion") VALUES($1,$2,$3,$4,$5,$6,$7)',
        [row.id, row.userId, row.name, row.kind, sealed.ciphertext, sealed.iv, sealed.keyVersion])
      try {
        const freshMask = await maskFor(f)
        assert.notEqual(freshMask.sourcePolicy, oldMask.sourcePolicy)
        await withReviewTransaction(pool, pool, f.who, f.runId, f.repoId, (client, scope) =>
          retainCheckpointReview(client, scope, prepared, new Date(first.receipt.takenAt), freshMask), { live: f.identity })
        assert.equal((await checkpointState(f)).review.snapshotId, null, 'a stale preparation cannot persist its former safe-source proof')
        assert.equal((await checkpointState(f)).review.reason, 'missing_evidence')
        assert.equal(prepareCheckpointReview(checkpoint, f.repoId, freshMask).reason, 'missing_evidence', 'fresh full-source masking rejects the same private bytes')
        const current = await acknowledgeCheckpoint(f, checkpoint)
        assert.equal(current.review.snapshotId, null)
        assert.equal(current.review.reason, 'missing_evidence')
        const recovery = gunzipSync(current.recovery.patch).toString('utf8')
        assert.ok(!recovery.includes(secret), 'valid recovery is admitted only after its plaintext secret is masked')
        assert.ok(recovery.includes('alpha.txt'))
        const page = await checkpointPage(f)
        assert.equal(page.snapshot.reason, 'missing_evidence')
        assert.equal(page.snapshot.observedAt, current.receipt.takenAt)
        const rows = (await pool.query(`SELECT s.snapshot,f.metadata,f.patch FROM coding_workspace_snapshots s
          JOIN coding_workspace_snapshot_files f ON f."snapshotId"=s.id WHERE s."runId"=$1`, [f.runId])).rows
        assert.equal(rows.length, 3, 'neither preparation path persisted the unsafe source version')
        assert.ok(!JSON.stringify(rows).includes(secret))
      } finally { await pool.query('DELETE FROM user_secrets WHERE id=$1', [row.id]) }
    })

    await t.test('a live owner freezes authority; lazy verified patches survive stopped Run and deleted device/repository rows', async () => {
      const f = await fixture(), { snapshot, files } = await capture(f), scope = await scopeFor(f), mask = await maskFor(f)
      assert.deepEqual((await pool.query('SELECT "repoId","ownerId","workspaceId","repositoryKey" FROM coding_workspace_bindings WHERE "runId"=$1', [f.runId])).rows,
        [{ repoId: f.repoId, ownerId: owner.id, workspaceId: f.where.id, repositoryKey: remoteKey(remote) }])
      assert.equal((await read(f, snapshot.id)).counts.complete, false)
      for (const file of files) {
        assert.equal((await readStoredDiffFile(pool, scope, snapshot, file.path, await maskFor(f))).patch, null)
        const { patch, proof } = await filePatch(f, snapshot, file)
        assert.ok(proof.blobs?.length, 'the actual daemon provides full private source proof')
        const stored = await withReviewTransaction(pool, pool, f.who, f.runId, f.repoId,
          (client, current) => retainDiffFilePatch(client, current, snapshot, patch, mask))
        assert.deepEqual(stored, patch)
        const persisted = (await pool.query('SELECT metadata,patch FROM coding_workspace_snapshot_files WHERE "snapshotId"=$1 AND path=$2', [snapshot.id, file.path])).rows[0]
        assert.deepEqual(persisted.patch, patch)
        const serialized = JSON.stringify(persisted)
        assert.ok(!serialized.includes('"base64"') && !serialized.includes('"blobs"'), 'private source proof is never persisted')
      }
      assert.equal((await read(f, snapshot.id)).counts.complete, true)
      await assert.rejects(() => pool.query('UPDATE coding_workspace_snapshot_files SET patch=NULL WHERE "snapshotId"=$1 AND path=\'alpha.txt\'', [snapshot.id]), sqlCode('55000'))
      await retire(f)
      const historical = await read(f, snapshot.id)
      assert.deepEqual(historical.identity, snapshot.identity)
      assert.equal(historical.isStale, true)
      assert.equal((await latestDiffSnapshot(pool, await scopeFor(f)))?.id, snapshot.id)
      assert.ok((await readStoredDiffFile(pool, await scopeFor(f), historical, 'alpha.txt', await maskFor(f))).patch?.patch?.includes('+after alpha.txt'))
      await assert.rejects(() => resolveRunWorktree(pool, pool, f.who, f.runId, f.repoId), code('workspace_not_found'))
    })

    await t.test('identical real Git commits from local and GitHub origins, and distinct PRs, retain separate immutable snapshots', async () => {
      const f = await fixture()
      await git(f.worktree, 'add', '--all'); await git(f.worktree, 'commit', '-qm', 'immutable source provenance fixture')
      const headSha = await git(f.worktree, 'rev-parse', 'HEAD'), baseSha = f.entry.baseCommit!
      const request = { kind: 'diff_snapshot', source: 'commit', baseSha, headSha } as const
      const receipt = workspaceReadReceipt.parse(await readWorkspaceDiffReceipt(command(f, request), f.entry, f.repository))
      const mask = await maskFor(f), result = validateDiffReceipt(request, receipt, mask)
      assert.ok(result?.ok && result.kind === 'diff_snapshot')
      assert.equal(result.revision.source, 'commit'); assert.equal(result.files.length, 3)
      assert.ok(result.files.every(file => file.github === undefined))
      const retain = (input: Parameters<typeof retainDiffSnapshot>[2]) => withReviewTransaction(pool, pool, f.who, f.runId, f.repoId,
        (client, scope) => retainDiffSnapshot(client, scope, input, mask), { live: f.identity })
      const localInput = { revision: result.revision, files: result.files }
      const local = await retain(localInput)
      assert.equal((await retain(localInput)).id, local.id)
      assert.equal(local.sourceAccess, undefined)

      const access: DiffSourceAccess = { kind: 'github', repositoryId: '61393725', manifestComplete: true }
      const githubFiles = result.files.map(file => {
        const metadata: DiffFileMetadata = { ...file, github: { repositoryId: access.repositoryId, patchSha256: null, page: null } }
        metadata.fileVersion = diffFileVersion(f.repoId, result.revision, metadata)
        return metadata
      })
      const githubInput = { revision: manifestRevision('commit', baseSha, headSha, result.revision.treeSha, githubFiles, access),
        files: githubFiles, sourceAccess: access }
      const remote = await retain(githubInput)
      assert.notEqual(remote.id, local.id); assert.notEqual(remote.revision.version, local.revision.version)
      assert.equal((await retain(githubInput)).id, remote.id)
      assert.deepEqual(remote.sourceAccess, access)
      assert.deepEqual([remote.revision.baseSha, remote.revision.headSha, remote.revision.treeSha],
        [local.revision.baseSha, local.revision.headSha, local.revision.treeSha])
      assert.deepEqual(githubFiles.map(file => [file.path, file.oldBlob, file.newBlob]), result.files.map(file => [file.path, file.oldBlob, file.newBlob]))

      const prFiles: DiffFileMetadata[] = []
      for (const file of githubFiles) {
        const native = await git(f.worktree, 'diff', '--no-ext-diff', '--no-textconv', '--unified=3', baseSha, headSha, '--', file.path)
        const start = native.indexOf('@@ ')
        assert.ok(start >= 0, 'the fixture patch comes from these same real immutable Git commits')
        const metadata: DiffFileMetadata = { ...file, github: { repositoryId: access.repositoryId, patchSha256: hash(native.slice(start)), page: 1 } }
        metadata.fileVersion = diffFileVersion(f.repoId, result.revision, metadata)
        prFiles.push(metadata)
      }
      const prInput = (number: number): Parameters<typeof retainDiffSnapshot>[2] => {
        const sourceAccess: DiffSourceAccess = { ...access, pullRequestNumber: number, pullRequestBaseSha: baseSha }
        return { revision: manifestRevision('pull_request', baseSha, headSha, result.revision.treeSha, prFiles, sourceAccess),
          files: prFiles, sourceAccess,
          pullRequest: { number, url: `https://github.com/mikka-fixtures/diff-store/pull/${number}`, baseSha, headSha, state: 'open' } }
      }
      const firstInput = prInput(101), secondInput = prInput(102)
      const first = await retain(firstInput), second = await retain(secondInput)
      assert.notEqual(first.id, second.id); assert.notEqual(first.revision.version, second.revision.version)
      assert.equal((await retain(firstInput)).id, first.id); assert.equal((await retain(secondInput)).id, second.id)
      assert.deepEqual(first.sourceAccess, { ...access, pullRequestNumber: 101, pullRequestBaseSha: baseSha })
      assert.deepEqual(second.sourceAccess, { ...access, pullRequestNumber: 102, pullRequestBaseSha: baseSha })
      assert.deepEqual(firstInput.files, secondInput.files, 'PR provenance separates snapshots even when all file versions are identical')

      for (const forged of [
        { ...githubInput, sourceAccess: undefined },
        { ...githubInput, files: result.files },
        { ...githubInput, revision: local.revision },
        { ...githubInput, sourceAccess: { ...access, repositoryId: '61393726' } },
        { ...firstInput, sourceAccess: undefined },
        { ...firstInput, sourceAccess: { ...access, pullRequestNumber: 102 } },
        { ...firstInput, pullRequest: secondInput.pullRequest },
      ]) await assert.rejects(() => retain(forged), code('workspace_snapshot_unavailable'))
      const rows = (await pool.query('SELECT id,source,version,snapshot FROM coding_workspace_snapshots WHERE "runId"=$1 ORDER BY id', [f.runId])).rows
      assert.equal(rows.length, 4, 'rejected provenance creates no extra artifact or replacement')
      assert.deepEqual(rows.map(row => row.id).sort(), [local.id, remote.id, first.id, second.id].sort())
      for (const snapshot of [local, remote, first, second]) {
        const loaded = await read(f, snapshot.id)
        assert.deepEqual(loaded.sourceAccess, snapshot.sourceAccess)
        assert.equal(loaded.revision.version, snapshot.revision.version)
        assert.equal(loaded.pullRequest?.number, snapshot.pullRequest?.number)
      }
    })

    await t.test('task members read retained artifacts only; a taskless Run and live machine authority remain owner-only', async () => {
      const shared = await fixture(), captured = await capture(shared, true), reviewer = actor(member, shared.where)
      await assert.rejects(() => withReviewTransaction(pool, pool, reviewer, shared.runId, shared.repoId,
        async () => undefined, { live: shared.identity }), code('workspace_not_found'))
      await retire(shared)
      assert.equal((await read(shared, captured.snapshot.id, reviewer)).identity.ownerId, owner.id)
      const personal = await fixture({ task: false }), retained = await capture(personal, true)
      await retire(personal)
      assert.equal((await read(personal, retained.snapshot.id)).id, retained.snapshot.id)
      await assert.rejects(() => read(personal, retained.snapshot.id, actor(member, personal.where)), code('workspace_not_found'))
    })

    await t.test('cross-tenant scope, membership removal, task movement/deletion and changed frozen scope revoke historical reads', async () => {
      const f = await fixture(), { snapshot } = await capture(f, true), reviewer = actor(member, f.where)
      await retire(f)
      await assert.rejects(() => read(f, snapshot.id, actor(member, otherWorkspace)), code('workspace_not_found'))
      await assert.rejects(() => read(f, snapshot.id, actor(stranger, f.where)), code('workspace_not_found'))
      await pool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [f.where.id, member.id])
      await assert.rejects(() => read(f, snapshot.id, reviewer), code('workspace_not_found'))
      await pool.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2', [f.where.id, member.id])
      await pool.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2', [f.where.id, member.id])
      await assert.rejects(() => read(f, snapshot.id, reviewer), code('workspace_not_found'))
      await pool.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$3,\'member\',\'active\')', [f.where.id, member.id, `${member.id}@example.invalid`])
      await pool.query('UPDATE mikka_team_issues SET "teamId"=$2,"workspaceId"=$3 WHERE "issueId"=$1', [f.taskId, otherWorkspace.teamId, otherWorkspace.id])
      for (const where of [f.where, otherWorkspace]) await assert.rejects(() => read(f, snapshot.id, actor(member, where)), code('workspace_not_found'))
      await pool.query('UPDATE mikka_team_issues SET "teamId"=$2,"workspaceId"=$3 WHERE "issueId"=$1', [f.taskId, f.where.teamId, f.where.id])
      await pool.query('UPDATE issues SET content=$2 WHERE id=$1', [f.taskId, { type: 'doc', attrs: { mikka: { deletedAt: new Date().toISOString() } }, content: [] }])
      await assert.rejects(() => read(f, snapshot.id, reviewer), code('workspace_not_found'))
      await pool.query('UPDATE issues SET content=\'{"type":"doc","content":[]}\' WHERE id=$1', [f.taskId])
      // The tenant trigger freezes a Run's workspace at INSERT. Moving its
      // frozen execution identity to another tenant is now rejected by the
      // database before a domain read can observe it.
      await assert.rejects(() => pool.query('UPDATE agent_runs SET "agentDefinition"=jsonb_set("agentDefinition",\'{executionIdentity,workspaceId}\',to_jsonb($2::text)) WHERE id=$1', [f.runId, otherWorkspace.id]),
        (error: unknown) => (error as { code?: string }).code === '23514')
    })

    await t.test('a stopped Run first freezes its original review scope without a checkpoint or usable daemon token', async () => {
      const f = await fixture()
      await assertUnbound(f)
      await stopWithoutLiveToken(f)
      await assert.rejects(() => resolveRunWorktree(pool, pool, f.who, f.runId, f.repoId), code('workspace_not_found'))
      const scope = await ensureScope(f)
      assert.deepEqual(scope.identity, { version: 1, runId: f.runId, repoId: f.repoId, ownerId: f.person.id,
        workspaceId: f.where.id, repositoryKey: remoteKey(remote) })
      assert.equal(scope.taskId, f.taskId); assert.equal(scope.status, 'stopped'); assert.equal(scope.stopped, true)
      assert.deepEqual(await ensureScope(f), scope, 'the first historical binding is reused without another live resolution')
      assert.deepEqual((await pool.query(`SELECT "runId","repoId","ownerId","workspaceId","repositoryKey"
        FROM coding_workspace_bindings WHERE "runId"=$1`, [f.runId])).rows,
      [{ runId: f.runId, repoId: f.repoId, ownerId: f.person.id, workspaceId: f.where.id, repositoryKey: remoteKey(remote) }])
      assert.deepEqual((await pool.query(`SELECT id,"workspaceId","taskId","runId","repositoryKey"
        FROM coding_workspace_review_boards WHERE id=$1`, [scope.boardId])).rows,
      [{ id: scope.boardId, workspaceId: f.where.id, taskId: f.taskId, runId: null, repositoryKey: remoteKey(remote) }])
      for (const table of ['run_checkpoints', 'coding_workspace_checkpoint_reviews', 'coding_workspace_snapshots'])
        assert.equal((await pool.query(`SELECT 1 FROM ${table} WHERE "runId"=$1`, [f.runId])).rowCount, 0,
          'historical scope creation requires no checkpoint and invents no source evidence')
    })

    await t.test('a Task member can first open a soft-removed device history without gaining live or taskless authority', async () => {
      const f = await fixture(), reviewer = actor(member, f.where)
      await assertUnbound(f)
      await stopWithoutLiveToken(f)
      await pool.query('UPDATE agents SET "deviceId"=NULL WHERE "deviceId"=$1', [f.deviceId])
      await pool.query('UPDATE devices SET enabled=false,"removedAt"=now() WHERE id=$1', [f.deviceId])
      const scope = await ensureScope(f, reviewer)
      assert.equal(scope.identity.ownerId, f.person.id); assert.equal(scope.identity.repoId, f.repoId)
      assert.equal(scope.identity.workspaceId, f.where.id); assert.equal(scope.taskId, f.taskId)
      assert.equal(scope.status, 'stopped'); assert.equal(scope.stopped, true)
      assert.deepEqual(await scopeFor(f, reviewer), scope)
      assert.deepEqual((await pool.query('SELECT "deviceId","deviceRepoId" FROM agent_runs WHERE id=$1', [f.runId])).rows,
        [{ deviceId: f.deviceId, deviceRepoId: f.repoId }], 'soft removal retains the original host repository identity')
      for (const who of [f.who, reviewer])
        await assert.rejects(() => resolveRunWorktree(pool, pool, who, f.runId, f.repoId), code('workspace_not_found'))
      const personal = await fixture({ task: false })
      await stopWithoutLiveToken(personal)
      await assert.rejects(() => ensureScope(personal, actor(member, personal.where)), code('workspace_not_found'))
      await assertUnbound(personal)
      assert.equal((await ensureScope(personal)).identity.ownerId, personal.person.id)
    })

    await t.test('only an exact Run publication can supply missing historical repository admission evidence', async () => {
      const f = await fixture(), other = await fixture()
      await stopWithoutLiveToken(f)
      await pool.query('UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=$1', [f.runId,
        { executionIdentity: { workspaceId: f.where.id } }])
      await pool.query(`INSERT INTO run_publications ("runId","userId","issueId","remoteUrl","remoteKey")
        VALUES ($1,$2,$3,$4,$5)`, [f.runId, f.person.id, other.taskId, remote, remoteKey(remote)])
      await assert.rejects(() => ensureScope(f), code('workspace_not_found'))
      await assertUnbound(f)
      await pool.query('UPDATE run_publications SET "issueId"=$2,"userId"=$3 WHERE "runId"=$1', [f.runId, f.taskId, stranger.id])
      await assert.rejects(() => ensureScope(f), code('workspace_not_found'))
      await assertUnbound(f)
      await pool.query('UPDATE run_publications SET "userId"=$2 WHERE "runId"=$1', [f.runId, f.person.id])
      const scope = await ensureScope(f, actor(member, f.where))
      assert.equal(scope.identity.repositoryKey, remoteKey(remote)); assert.equal(scope.identity.ownerId, f.person.id)
      assert.equal(scope.taskId, f.taskId); assert.equal(scope.status, 'stopped')
    })

    await t.test('first historical binding rejects caller-selected repositories, other tenants and conflicting frozen evidence', async () => {
      const f = await fixture(), alternative = await fixture()
      await stopWithoutLiveToken(f)
      for (const [who, repoId] of [[actor(member, otherWorkspace), f.repoId], [actor(stranger, f.where), f.repoId],
        [f.who, alternative.repoId]] as const) {
        await assert.rejects(() => ensureScope(f, who, repoId), code('workspace_not_found'))
        await assertUnbound(f)
      }
      const original = { executionIdentity: { workspaceId: f.where.id },
        repositoryAdmission: { workspaceId: f.where.id, remoteKey: remoteKey(remote) } }
      const definitions = [
        { ...original, repositoryAdmission: { ...original.repositoryAdmission, remoteKey: remoteKey('https://github.com/mikka-fixtures/another.git') } },
        { ...original, repositoryAdmission: { ...original.repositoryAdmission, workspaceId: otherWorkspace.id } },
        { ...original, executionIdentity: { workspaceId: otherWorkspace.id } },
        { repositoryAdmission: { remoteKey: remoteKey(remote) } },
        { executionIdentity: original.executionIdentity },
      ]
      for (const [index, definition] of definitions.entries()) {
        if (index === 2) {
          // A non-null frozen tenant cannot be rewritten to another tenant.
          await assert.rejects(() => pool.query('UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=$1', [f.runId, definition]),
            (error: unknown) => (error as { code?: string }).code === '23514')
          continue
        }
        await pool.query('UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=$1', [f.runId, definition])
        await assert.rejects(() => ensureScope(f), code('workspace_not_found'))
        await assertUnbound(f)
      }
      await pool.query('UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=$1', [f.runId, original])
      await pool.query(`INSERT INTO run_publications ("runId","userId","issueId","remoteUrl","remoteKey")
        VALUES ($1,$2,$3,$4,$5)`, [f.runId, f.person.id, f.taskId, 'https://github.com/mikka-fixtures/another.git',
        remoteKey('https://github.com/mikka-fixtures/another.git')])
      await assert.rejects(() => ensureScope(f), code('workspace_not_found'))
      await assertUnbound(f)
      await pool.query('DELETE FROM run_publications WHERE "runId"=$1', [f.runId])
      await pool.query('UPDATE device_repos SET "remoteUrl"=$2 WHERE id=$1', [f.repoId, 'https://github.com/mikka-fixtures/another.git'])
      await assert.rejects(() => ensureScope(f), code('workspace_not_found'))
      await assertUnbound(f)
      await pool.query('UPDATE device_repos SET "remoteUrl"=$2 WHERE id=$1', [f.repoId, remote])
      await pool.query('UPDATE agent_runs SET "deviceRepoId"=$2 WHERE id=$1', [f.runId, alternative.repoId])
      await assert.rejects(() => ensureScope(f, f.who, alternative.repoId), code('workspace_not_found'))
      await assertUnbound(f)
    })

    await t.test('an unbound Run whose device was physically deleted cannot acquire history from a same-name replacement repository', async () => {
      const f = await fixture()
      await assertUnbound(f)
      await retire(f)
      await assert.rejects(() => scopeFor(f), code('workspace_not_found'))
      await assert.rejects(() => withReviewTransaction(pool, pool, f.who, f.runId, f.repoId,
        async () => undefined, { live: f.identity }), code('workspace_not_found'))
      const replacement = await fixture()
      for (const who of [f.who, actor(member, f.where)]) for (const repoId of [f.repoId, replacement.repoId])
        await assert.rejects(() => ensureScope(f, who, repoId), code('workspace_not_found'))
      await assertUnbound(f)
    })

    await t.test('snapshot identity is immutable and comments cannot join a snapshot or thread from another board', async () => {
      const a = await fixture(), b = await fixture(), first = (await capture(a, true)).snapshot, second = (await capture(b)).snapshot
      const one = await scopeFor(a), two = await scopeFor(b)
      await assert.rejects(() => pool.query('UPDATE coding_workspace_bindings SET "workspaceId"=$2 WHERE "runId"=$1', [a.runId, otherWorkspace.id]), sqlCode('55000'))
      await assert.rejects(() => pool.query('UPDATE coding_workspace_snapshots SET snapshot=snapshot || \'{"isStale":true}\'::jsonb WHERE id=$1', [first.id]), sqlCode('55000'))
      for (const assignment of ['path=\'elsewhere.txt\'', 'position=99', 'metadata=metadata || \'{"status":"deleted"}\'::jsonb'])
        await assert.rejects(() => pool.query(`UPDATE coding_workspace_snapshot_files SET ${assignment} WHERE "snapshotId"=$1 AND path='alpha.txt'`, [first.id]), sqlCode('55000'))
      const rootComment = await comment(a, first, owner.id)
      const wrongSnapshot = randomUUID()
      await assert.rejects(() => pool.query(`INSERT INTO coding_workspace_review_comments(id,"threadId","boardId","snapshotId","userId",anchor,body)
        VALUES($1,$1,$2,$3,$4,'{}','Wrong snapshot')`, [wrongSnapshot, one.boardId, second.id, owner.id]), sqlCode('23503'))
      await assert.rejects(() => pool.query(`INSERT INTO coding_workspace_review_comments(id,"threadId","boardId","snapshotId","userId",anchor,body)
        VALUES($1,$2,$3,$4,$5,'{}','Wrong parent thread')`, [randomUUID(), rootComment, two.boardId, second.id, owner.id]), sqlCode('23503'))
      assert.equal((await pool.query('SELECT 1 FROM coding_workspace_review_comments WHERE "boardId"=$1', [two.boardId])).rowCount, 0)
    })

    await t.test('pagination and Reviewed marks are bound to viewer, file version, board revision and snapshot scope', async () => {
      const f = await fixture(), { snapshot } = await capture(f), scope = await scopeFor(f)
      const first = await readDiffFilePage(pool, scope, snapshot, owner.id, { limit: 1 })
      assert.deepEqual(first.files.map(file => file.path), ['alpha.txt']); assert.ok(first.nextCursor)
      const second = await readDiffFilePage(pool, scope, snapshot, owner.id, { limit: 1, cursor: first.nextCursor })
      assert.deepEqual(second.files.map(file => file.path), ['beta.txt']); assert.ok(second.nextCursor)
      const third = await readDiffFilePage(pool, scope, snapshot, owner.id, { limit: 1, cursor: second.nextCursor })
      assert.deepEqual(third.files.map(file => file.path), ['gamma.txt']); assert.equal(third.nextCursor, null)
      for (const [who, file] of [[owner.id, first.files[0]!], [member.id, second.files[0]!]] as const)
        await pool.query('INSERT INTO coding_workspace_reviewed_files("boardId","userId",path,"fileVersion") VALUES($1,$2,$3,$4)', [scope.boardId, who, file.path, file.fileVersion])
      await pool.query('UPDATE coding_workspace_review_boards SET revision=revision+1 WHERE id=$1', [scope.boardId])
      assert.deepEqual((await readDiffFilePage(pool, scope, snapshot, owner.id, { unreviewed: true })).files.map(file => file.path), ['beta.txt', 'gamma.txt'])
      assert.deepEqual((await readDiffFilePage(pool, await scopeFor(f, actor(member, f.where)), snapshot, member.id, { unreviewed: true })).files.map(file => file.path), ['alpha.txt', 'gamma.txt'])
      await assert.rejects(() => readDiffFilePage(pool, scope, snapshot, owner.id, { cursor: first.nextCursor! }), code('workspace_review_conflict'))
      await assert.rejects(() => readDiffFilePage(pool, scope, snapshot, owner.id, { cursor: first.nextCursor!, unreviewed: true }), code('workspace_snapshot_outdated'))
      await f.write('alpha.txt', 'new version alpha\n')
      const changed = (await capture(f)).snapshot
      assert.equal((await readDiffFilePage(pool, scope, changed, owner.id)).files.find(file => file.path === 'alpha.txt')?.reviewed, false)
      assert.equal((await readDiffFilePage(pool, scope, changed, member.id)).files.find(file => file.path === 'beta.txt')?.reviewed, true)
      await assert.rejects(() => readDiffFilePage(pool, scope, changed, owner.id, { cursor: first.nextCursor! }), code('workspace_snapshot_outdated'))
      const foreign = await fixture({ where: otherWorkspace }), foreignSnapshot = (await capture(foreign)).snapshot
      await assert.rejects(() => readDiffFilePage(pool, scope, foreignSnapshot, owner.id), code('workspace_snapshot_unavailable'))
    })

    await t.test('fresh session, workspace-bound PAT and Run-bound device credentials are required independently of retained authority', async () => {
      const f = await fixture(), { snapshot } = await capture(f)
      const sessionId = await session(owner.id), signedIn: ReviewActor = { ...f.who, credential: { kind: 'session', id: sessionId } }
      assert.equal((await read(f, snapshot.id, signedIn)).id, snapshot.id)
      await assert.rejects(() => read(f, snapshot.id, { ...signedIn, credential: { kind: 'session', id: member.sessionId } }), code('workspace_not_found'))
      await pool.query('UPDATE "session" SET "expiresAt"=now()-interval \'1 minute\' WHERE id=$1', [sessionId])
      await assert.rejects(() => read(f, snapshot.id, signedIn), code('workspace_not_found'))
      await pool.query('DELETE FROM "session" WHERE id=$1', [sessionId])
      await assert.rejects(() => read(f, snapshot.id, signedIn), code('workspace_not_found'))

      const patId = randomUUID(), pat: ReviewActor = { ...f.who, credential: { kind: 'pat', id: patId } }
      await pool.query(`INSERT INTO personal_access_tokens(id,"userId","workspaceId",name,"tokenHash",hint,"expiresAt")
        VALUES($1,$2,$3,'Diff fixture',$4,'test',now()+interval '1 hour')`, [patId, owner.id, f.where.id, hash(randomUUID())])
      assert.equal((await read(f, snapshot.id, pat)).id, snapshot.id)
      await pool.query('UPDATE personal_access_tokens SET "workspaceId"=$2 WHERE id=$1', [patId, otherWorkspace.id])
      await assert.rejects(() => read(f, snapshot.id, pat), code('workspace_not_found'))
      await pool.query('UPDATE personal_access_tokens SET "workspaceId"=$2,"revokedAt"=now() WHERE id=$1', [patId, f.where.id])
      await assert.rejects(() => read(f, snapshot.id, pat), code('workspace_not_found'))

      const device: ReviewActor = { ...f.who, credential: { kind: 'device', id: f.tokenId, deviceId: f.deviceId } }
      assert.equal((await read(f, snapshot.id, device)).id, snapshot.id)
      await pool.query('UPDATE device_tokens SET "boundWorkspaceId"=$2 WHERE id=$1', [f.tokenId, otherWorkspace.id])
      await assert.rejects(() => read(f, snapshot.id, device), code('workspace_not_found'))
      await pool.query('UPDATE device_tokens SET "boundWorkspaceId"=$2,"boundDeviceId"=$3 WHERE id=$1', [f.tokenId, f.where.id, f.deviceId])
      assert.equal((await read(f, snapshot.id, device)).id, snapshot.id)
      await pool.query('UPDATE device_tokens SET "revokedAt"=now() WHERE id=$1', [f.tokenId])
      await assert.rejects(() => read(f, snapshot.id, device), code('workspace_not_found'))
      await retire(f)
      assert.equal((await read(f, snapshot.id)).id, snapshot.id, 'revoking the device does not destroy owner session history')
    })

    await t.test('real review mutations preserve private drafts, author permissions, idempotent receipts and versioned per-viewer Reviewed state', async () => {
      const { readReviewBoard, mutateReview } = await import('./review')
      const deps = { database: pool, membership: pool }, f = await fixture(), { snapshot, files } = await capture(f, true)
      assert.equal(snapshot.sourceAccess, undefined); assert.ok(files.every(file => file.github === undefined))
      const reviewer = actor(member, f.where), scope = await scopeFor(f), mask = await maskFor(f)
      const anchorFor = async (path: string) => {
        const { patch } = await readStoredDiffFile(pool, scope, snapshot, path, mask)
        assert.ok(patch?.hunks[0])
        return validateReviewAnchor({ snapshotId: snapshot.id, sourceVersion: snapshot.revision.version, path,
          side: 'RIGHT', lineStart: 1, lineEnd: 1, hunkFingerprint: patch.hunks[0].fingerprint }, patch)
      }
      let revision = 0
      const mutate = async (who: ReviewActor, input: Record<string, unknown>) => {
        const response = await mutateReview(deps, who, f.runId, f.repoId, snapshot.id,
          { requestId: randomUUID(), expectedRevision: revision, ...input })
        revision = response.revision
        return response
      }
      const firstInput = { action: 'create', requestId: randomUUID(), expectedRevision: 0,
        anchor: await anchorFor('alpha.txt'), body: 'Private alpha draft', draft: true }
      const first = await mutate(f.who, firstInput)
      const second = await mutate(f.who, { action: 'create', anchor: await anchorFor('beta.txt'), body: 'Private beta draft', draft: true })
      assert.ok(first.commentId && second.commentId)
      const ownerBoard = await readReviewBoard(deps, f.who, f.runId, f.repoId, snapshot.id)
      const memberBoard = await readReviewBoard(deps, reviewer, f.runId, f.repoId, snapshot.id)
      assert.deepEqual(ownerBoard.comments.map(comment => comment.id).sort(), [first.commentId, second.commentId].sort())
      assert.deepEqual(memberBoard.comments, [])
      assert.equal(ownerBoard.permissions.canSendToAgent, true); assert.equal(memberBoard.permissions.canSendToAgent, false)
      for (const input of [
        { action: 'reply', threadId: first.threadId, body: 'Cannot discover this private thread' },
        { action: 'edit', commentId: first.commentId, body: 'Cannot edit another author' },
        { action: 'resolve', threadId: first.threadId, resolved: true },
      ]) await assert.rejects(() => mutate(reviewer, input), code('workspace_review_unavailable'))
      assert.equal((await readReviewBoard(deps, f.who, f.runId, f.repoId, snapshot.id)).revision, revision)

      const published = await mutate(f.who, { action: 'create', anchor: await anchorFor('alpha.txt'), body: 'Published owner thread', draft: false })
      const reply = await mutate(reviewer, { action: 'reply', threadId: published.threadId, body: 'Member reply' })
      assert.ok(reply.commentId)
      await mutate(reviewer, { action: 'edit', commentId: reply.commentId, body: 'Member edited their reply' })
      await assert.rejects(() => mutate(f.who, { action: 'edit', commentId: reply.commentId, body: 'Run owner cannot rewrite someone else' }), code('workspace_review_unavailable'))
      await assert.rejects(() => mutate(reviewer, { action: 'edit', commentId: published.commentId, body: 'Member cannot rewrite the owner' }), code('workspace_review_unavailable'))
      await assert.rejects(() => mutate(reviewer, { action: 'resolve', threadId: published.threadId, resolved: true }), code('workspace_review_unavailable'))
      await mutate(f.who, { action: 'resolve', threadId: published.threadId, resolved: true })
      const memberThread = await mutate(reviewer, { action: 'create', anchor: await anchorFor('beta.txt'), body: 'Published member thread', draft: false })
      await mutate(reviewer, { action: 'resolve', threadId: memberThread.threadId, resolved: true })
      await mutate(f.who, { action: 'resolve', threadId: memberThread.threadId, resolved: false })
      const visible = (await readReviewBoard(deps, reviewer, f.runId, f.repoId, snapshot.id)).comments
      assert.equal(visible.length, 3)
      assert.ok(visible.filter(comment => comment.threadId === published.threadId).every(comment => comment.resolved))
      assert.equal(visible.find(comment => comment.id === reply.commentId)?.body, 'Member edited their reply')
      assert.equal(visible.find(comment => comment.id === memberThread.commentId)?.resolved, false)

      const beforeReplay = (await pool.query('SELECT count(*)::int AS count FROM coding_workspace_review_comments WHERE "boardId"=$1', [scope.boardId])).rows[0].count
      assert.deepEqual(await mutateReview(deps, f.who, f.runId, f.repoId, snapshot.id, firstInput), first)
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM coding_workspace_review_comments WHERE "boardId"=$1', [scope.boardId])).rows[0].count, beforeReplay)
      await assert.rejects(() => mutateReview(deps, f.who, f.runId, f.repoId, snapshot.id, { ...firstInput, body: 'Same request, changed content' }), code('workspace_review_conflict'))
      await assert.rejects(() => mutateReview(deps, f.who, f.runId, f.repoId, snapshot.id,
        { action: 'edit', requestId: randomUUID(), expectedRevision: 0, commentId: first.commentId, body: 'Stale writer' }), code('workspace_review_conflict'))
      assert.equal((await readReviewBoard(deps, f.who, f.runId, f.repoId, snapshot.id)).revision, revision)

      const alpha = files.find(file => file.path === 'alpha.txt')!, beta = files.find(file => file.path === 'beta.txt')!
      await mutate(f.who, { action: 'reviewed', files: [{ path: alpha.path, fileVersion: alpha.fileVersion, reviewed: true }] })
      await mutate(reviewer, { action: 'reviewed', files: [{ path: beta.path, fileVersion: beta.fileVersion, reviewed: true }] })
      assert.deepEqual((await readDiffFilePage(pool, scope, snapshot, owner.id, { unreviewed: true })).files.map(file => file.path), ['beta.txt', 'gamma.txt'])
      assert.deepEqual((await readDiffFilePage(pool, scope, snapshot, member.id, { unreviewed: true })).files.map(file => file.path), ['alpha.txt', 'gamma.txt'])
      await f.write('alpha.txt', 'New Git version invalidates only alpha\n')
      const changed = (await capture(f, true)).snapshot
      assert.equal((await readDiffFilePage(pool, scope, changed, owner.id)).files.find(file => file.path === alpha.path)?.reviewed, false)
      assert.equal((await readDiffFilePage(pool, scope, changed, member.id)).files.find(file => file.path === beta.path)?.reviewed, true)
      const changedBoard = await readReviewBoard(deps, f.who, f.runId, f.repoId, changed.id)
      assert.ok(changedBoard.comments.filter(comment => comment.anchor.path === alpha.path).every(comment => comment.outdated))
      assert.ok(changedBoard.comments.filter(comment => comment.anchor.path === beta.path).every(comment => !comment.outdated))
      await assert.rejects(() => mutateReview(deps, f.who, f.runId, f.repoId, changed.id,
        { action: 'reviewed', requestId: randomUUID(), expectedRevision: revision,
          files: [{ path: alpha.path, fileVersion: alpha.fileVersion, reviewed: true }] }), code('workspace_snapshot_outdated'))
      await assert.rejects(() => mutateReview(deps, { ...f.who, credential: { kind: 'device', id: f.tokenId, deviceId: f.deviceId } }, f.runId, f.repoId, snapshot.id,
        { action: 'edit', requestId: randomUUID(), expectedRevision: revision, commentId: first.commentId, body: 'A worker cannot impersonate a reviewer' }), code('workspace_review_unavailable'))
    })

    await t.test('real encrypted owner secrets spanning two hunks reject full source proofs and retained patches for every viewer', async () => {
      const f = await fixture(), gap = Array<string>(12).fill('')
      await f.write('alpha.txt', ['A0', ...gap, 'B0', ''].join('\n'))
      await git(f.worktree, 'add', '--', 'alpha.txt')
      await git(f.worktree, 'commit', '-qm', 'two-hunk secret baseline')
      f.entry.baseCommit = await git(f.worktree, 'rev-parse', 'HEAD')
      const secret = [`diff-secret-first-${randomUUID()}`, ...gap, `diff-secret-second-${randomUUID()}`].join('\n')
      await f.write('alpha.txt', `${secret}\n`)
      const { snapshot, files } = await capture(f, true), scope = await scopeFor(f)
      const stored = await readStoredDiffFile(pool, scope, snapshot, 'alpha.txt', await maskFor(f))
      assert.ok(stored.patch, 'the source was not registered as secret at the original observation')
      assert.equal(stored.patch.hunks.length, 2, 'neither individual hunk contains the full newly registered secret')
      assert.ok(!stored.patch.patch?.includes(secret), 'matching only the rendered patch cannot detect this value')
      const { sealSecret, userSecretAad } = await import('../../secrets/crypto')
      const row = { id: randomUUID(), userId: owner.id, name: 'DIFF_STORE_MULTILINE_FIXTURE', kind: 'secret' }
      const sealed = sealSecret(secret, userSecretAad(row))
      await pool.query('INSERT INTO user_secrets(id,"userId",name,kind,ciphertext,iv,"keyVersion") VALUES($1,$2,$3,$4,$5,$6,$7)',
        [row.id, row.userId, row.name, row.kind, sealed.ciphertext, sealed.iv, sealed.keyVersion])
      try {
        const mask = await maskFor(f)
        assert.notEqual(mask(secret), secret, 'the masker decrypts the real owner secret')
        const file = files.find(file => file.path === 'alpha.txt')!
        const request = { kind: 'diff_file' as const, snapshotId: snapshot.id, revision: snapshot.revision, file }
        const proof = workspaceReadReceipt.parse(await readWorkspaceDiffReceipt(command(f, request), f.entry, f.repository))
        assert.deepEqual(validateDiffReceipt(request, proof, mask), { ok: false, code: 'workspace_path_unavailable' })
        for (const who of [f.who, actor(member, f.where)]) {
          const current = await scopeFor(f, who)
          await assert.rejects(() => readStoredDiffFile(pool, current, snapshot, file.path, mask), code('workspace_path_unavailable'))
        }
        assert.deepEqual((await pool.query('SELECT patch FROM coding_workspace_snapshot_files WHERE "snapshotId"=$1 AND path=$2', [snapshot.id, file.path])).rows[0].patch,
          stored.patch, 'the old immutable anchor is refused, never rewritten into a different patch')
      } finally { await pool.query('DELETE FROM user_secrets WHERE id=$1', [row.id]) }
    })

    await t.test('the 50-snapshot quota deduplicates observations, evicts only unreferenced history and rolls back when all snapshots are anchored', async () => {
      const f = await fixture(), retained: DiffSnapshot[] = []
      for (const path of ['beta.txt', 'gamma.txt']) await f.write(path, `before ${path}\n`)
      for (let index = 0; index < 50; index++) {
        await f.write('alpha.txt', `quota observation ${index}\n`)
        retained.push((await capture(f, true)).snapshot)
      }
      const count = async () => (await pool.query('SELECT count(*)::int AS count FROM coding_workspace_snapshots WHERE "runId"=$1', [f.runId])).rows[0].count
      assert.equal(await count(), 50)
      assert.equal((await capture(f, true)).snapshot.id, retained.at(-1)!.id, 'replaying an identical real manifest does not consume quota')
      assert.equal(await count(), 50)
      await comment(f, retained[0]!, owner.id, 'Keep this real review anchor')
      const evicted = (await pool.query(`SELECT s.id FROM coding_workspace_snapshots s WHERE s."runId"=$1
        AND NOT EXISTS(SELECT 1 FROM coding_workspace_review_comments c WHERE c."snapshotId"=s.id)
        ORDER BY s."createdAt",s.id LIMIT 1`, [f.runId])).rows[0].id
      await f.write('alpha.txt', 'quota observation 50\n')
      const newest = (await capture(f, true)).snapshot
      assert.equal(await count(), 50)
      assert.equal((await read(f, retained[0]!.id)).id, retained[0]!.id)
      await assert.rejects(() => read(f, evicted), code('workspace_snapshot_unavailable'))
      assert.equal((await pool.query('SELECT 1 FROM coding_workspace_snapshot_files WHERE "snapshotId"=$1', [evicted])).rowCount, 0)
      const remaining = [...retained.filter(snapshot => snapshot.id !== evicted), newest]
      for (const snapshot of remaining) await comment(f, snapshot, owner.id)
      await f.write('alpha.txt', 'quota observation cannot discard a review\n')
      await assert.rejects(() => capture(f, true), code('workspace_limit_exceeded'))
      assert.equal(await count(), 50)
      assert.deepEqual((await pool.query('SELECT id FROM coding_workspace_snapshots WHERE "runId"=$1 ORDER BY id', [f.runId])).rows.map(row => row.id),
        remaining.map(snapshot => snapshot.id).sort(), 'the rejected insert cannot delete a previously anchored snapshot')
    })

    await t.test('the per-Run patch byte quota rejects a lazy patch atomically while preserving its honest incomplete manifest', async () => {
      const f = await fixture(), mask = await maskFor(f)
      for (const path of ['beta.txt', 'gamma.txt']) await f.write(path, `before ${path}\n`)
      const usage = async () => Number((await pool.query(`SELECT coalesce(sum(octet_length(f.patch::text)),0) AS bytes
        FROM coding_workspace_snapshot_files f JOIN coding_workspace_snapshots s ON s.id=f."snapshotId" WHERE s."runId"=$1`, [f.runId])).rows[0].bytes)
      let refused = false, storedCount = 0
      // Each distinct real source produces about 940 KiB of patch+hunk JSON.
      // This bounded set reaches the 16 MiB budget without fabricating proofs.
      for (let index = 0; index < 20; index++) {
        await f.write('alpha.txt', `byte quota version ${index}\n${'x'.repeat(470_000)}\n`)
        const { snapshot, files } = await capture(f), { patch } = await filePatch(f, snapshot, files[0]!)
        assert.equal(patch.format, 'text')
        const before = await usage()
        const save = () => withReviewTransaction(pool, pool, f.who, f.runId, f.repoId,
          (client, scope) => retainDiffFilePatch(client, scope, snapshot, patch, mask))
        if (before + Buffer.byteLength(JSON.stringify(patch)) > 16 * 1024 * 1024) {
          await assert.rejects(save, code('workspace_limit_exceeded'))
          assert.equal(await usage(), before)
          assert.equal((await readStoredDiffFile(pool, await scopeFor(f), snapshot, 'alpha.txt', mask)).patch, null)
          assert.equal((await read(f, snapshot.id)).counts.complete, false)
          refused = true
          break
        }
        await save(); storedCount++
        assert.ok(await usage() <= 16 * 1024 * 1024)
      }
      assert.ok(refused && storedCount >= 16, 'real validated patches reach and enforce the aggregate byte quota')
    })

    await t.test('normal workspace deletion removes retained snapshots and all review descendants without touching another workspace', async () => {
      const where = await workspace(), f = await fixture({ where }), taskless = await fixture({ where, task: false })
      const one = (await capture(f, true)).snapshot, two = (await capture(taskless, true)).snapshot
      const { scope } = await reviewRows(f, one, owner.id)
      await reviewRows(f, one, member.id)
      const other = await fixture({ where: otherWorkspace }), survivor = (await capture(other, true)).snapshot
      const { deleteWorkspaceData } = await import('../../workspace-admin/general')
      const deleted = await deleteWorkspaceData(owner.id, where.id, where.name)
      assert.equal(deleted.deleted.tasks, 1); assert.equal(deleted.deleted.teams, 1)
      assert.equal((await pool.query('SELECT 1 FROM mikka_workspaces WHERE id=$1', [where.id])).rowCount, 0)
      assert.equal((await pool.query('SELECT 1 FROM workspace_deletions WHERE id=$1', [where.id])).rowCount, 1)
      for (const table of ['coding_workspace_bindings', 'coding_workspace_snapshots', 'coding_workspace_review_boards'])
        assert.equal((await pool.query(`SELECT 1 FROM ${table} WHERE "workspaceId"=$1`, [where.id])).rowCount, 0)
      assert.equal((await pool.query('SELECT 1 FROM coding_workspace_snapshot_files WHERE "snapshotId"=ANY($1::uuid[])', [[one.id, two.id]])).rowCount, 0)
      for (const table of ['coding_workspace_review_comments', 'coding_workspace_reviewed_files', 'coding_workspace_review_receipts', 'coding_workspace_review_batches'])
        assert.equal((await pool.query(`SELECT 1 FROM ${table} WHERE "boardId"=$1`, [scope.boardId])).rowCount, 0)
      assert.equal((await read(other, survivor.id)).id, survivor.id)
      await assert.rejects(() => read(taskless, two.id), code('workspace_not_found'))
    })

    await t.test('account deletion retains shared Bot snapshots, removes private history and authored review rows, and preserves other reviewers', async () => {
      const departing = await user(), where = await workspace(owner, [departing, member])
      // A solo workspace is private history; the shared workspace Run with a
      // Bot is the retained history this test distinguishes from it.
      const solo = await workspace(departing, [])
      const kept = await fixture({ person: departing, where, bot: true }), discarded = await fixture({ person: departing, where: solo })
      const keptSnapshot = (await capture(kept, true)).snapshot, discardedSnapshot = (await capture(discarded, true)).snapshot
      const { scope } = await reviewRows(kept, keptSnapshot, departing.id)
      const memberRows = await reviewRows(kept, keptSnapshot, member.id)
      const { deleteMainAccountData, deleteWorkspaceData: deleteAccountWorkspaceData, planWorkspaces, freezeTaskRetention } = await import('../../account/delete')
      const { workspaceDb } = await import('../../workspace-db')
      const plan = await workspaceDb.transaction(tx => planWorkspaces(tx, departing.id))
      assert.ok('shared' in plan)
      assert.deepEqual(plan.shared, [where.id])
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        // Retention must freeze the APP task set under the same transaction;
        // deleteMainAccountData deliberately trusts a frozen plan.
        const frozen = await freezeTaskRetention(client, departing.id, plan)
        await deleteMainAccountData(client, departing.id, frozen)
        await client.query('COMMIT')
      } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
      await workspaceDb.transaction(tx => deleteAccountWorkspaceData(tx, departing.id, hash(`${departing.id}@example.invalid`), plan))
      assert.equal((await pool.query('SELECT 1 FROM "user" WHERE id=$1', [departing.id])).rowCount, 0)
      assert.equal((await pool.query('SELECT 1 FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2', [where.id, departing.id])).rowCount, 0)
      assert.deepEqual((await pool.query('SELECT "ownerId","archivedAt" IS NOT NULL AS archived FROM bots WHERE id=$1', [kept.botId])).rows,
        [{ ownerId: null, archived: true }])
      assert.deepEqual((await pool.query('SELECT status,"deviceId","deviceRepoId" FROM agent_runs WHERE id=$1', [kept.runId])).rows,
        [{ status: 'stopped', deviceId: null, deviceRepoId: null }])
      assert.equal((await pool.query('SELECT 1 FROM coding_workspace_bindings WHERE "runId"=$1 AND "ownerId"=$2', [kept.runId, departing.id])).rowCount, 1)
      assert.equal((await pool.query('SELECT 1 FROM coding_workspace_snapshots WHERE id=$1', [discardedSnapshot.id])).rowCount, 0)
      assert.equal((await pool.query('SELECT 1 FROM coding_workspace_snapshot_files WHERE "snapshotId"=$1', [discardedSnapshot.id])).rowCount, 0)
      for (const table of ['coding_workspace_review_comments', 'coding_workspace_reviewed_files', 'coding_workspace_review_receipts', 'coding_workspace_review_batches']) {
        assert.equal((await pool.query(`SELECT 1 FROM ${table} WHERE "userId"=$1`, [departing.id])).rowCount, 0)
        assert.equal((await pool.query(`SELECT 1 FROM ${table} WHERE "boardId"=$1 AND "userId"=$2`, [scope.boardId, member.id])).rowCount, 1)
      }
      assert.equal((await pool.query('SELECT 1 FROM coding_workspace_review_comments WHERE id=$1', [memberRows.commentId])).rowCount, 1)
      const reviewer = actor(member, where), historical = await read(kept, keptSnapshot.id, reviewer)
      assert.equal(historical.identity.ownerId, departing.id)
      assert.ok((await readStoredDiffFile(pool, await scopeFor(kept, reviewer), historical, 'alpha.txt', await maskFor(kept))).patch)
    })
  } finally {
    mock.restoreAll()
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
    await dropTestDatabase(admin, database, pool, appPool, workspacePool)
    await admin.end()
    await rm(root, { recursive: true, force: true })
  }
})
