import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Pool } from 'pg'
import { runAssignmentSchema } from '@mikka/protocol'
import { remoteKey } from '@mikka/protocol/repository'
import { CodingWorkspaceError, workspaceReadReceipt, type WorkspaceReadCommand } from '@mikka/protocol/coding-workspace'
import { checkpointReviewEvidence, WorkspaceReviewError, type DiffFileMetadata, type DiffSnapshot, type ReviewAnchor, type TaskReviewRef } from '@mikka/protocol/coding-workspace-review'
import { takeCheckpoint } from '../../../packages/daemon/src/agents/checkpoint'
import { readWorkspaceDiffReceipt } from '../../../packages/daemon/src/coding-workspace/diff'
import type { JournalEntry } from '../../../packages/daemon/src/runs/journal'
import { orderMigrations } from '../../../scripts/migration-order.mjs'
import { disposableDatabase, E2E_DB_RULE } from '../../../tests/helpers/e2e-target.mjs'
import { dropTestDatabase } from '../../../tests/support/drop-test-database'
import type { ReviewActor } from '../diff/authority'
import type { ExternalDiffProvider } from '../diff/service'
import type { ObservedPullState } from '../diff/github-state'
import type { ReviewMutationReceipt } from '../diff/review'
import type { TaskReviewHttpInput, TaskReviewHttpResult } from './http'

const url = process.env.E2E_DATABASE_URL
if (url) assert.ok(disposableDatabase(process.env, url), E2E_DB_RULE)
else if (process.env.REQUIRE_DB === '1') assert.fail('REQUIRE_DB=1 needs an isolated E2E_DATABASE_URL')
const execute = promisify(execFile)
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const code = (expected: string) => (error: unknown) =>
  (error instanceof CodingWorkspaceError || error instanceof WorkspaceReviewError) && error.code === expected
const remote = 'https://github.com/mikka-fixtures/task-review.git'
const reference = (snapshot: DiffSnapshot): TaskReviewRef => ({ snapshotId: snapshot.id, sourceVersion: snapshot.revision.version })

/** Real PG authority and immutable evidence; Git creates the full checkpoint
 * proofs. Only the Next request context is supplied. No provider or model runs. */
test('Task review reads preserve exact source, tenancy and accepted comments on PostgreSQL 17',
  { skip: !url, timeout: 240_000 }, async t => {
  const admin = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000 })
  const database = 'task_review_read_' + randomUUID().replaceAll('-', '') + '_e2e'
  const version = Number((await admin.query('SHOW server_version_num')).rows[0].server_version_num)
  assert.ok(version >= 170000 && version < 180000, 'Task review acceptance requires PostgreSQL 17')
  await admin.query('CREATE DATABASE "' + database + '" TEMPLATE template0')
  const target = new URL(url!); target.pathname = '/' + database
  const pool = new Pool({ connectionString: target.toString(), max: 8, connectionTimeoutMillis: 5000 })
  const directory = await mkdtemp(join(tmpdir(), 'mikka-task-review-db-'))
  const environment = { MIKKA_DATABASE_URL: target.toString(), DATABASE_URL: target.toString(), ORVILO_DATABASE_URL: target.toString(),
    E2E_DATABASE_URL: target.toString(), BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
    BETTER_AUTH_URL: 'http://127.0.0.1:3199', WORKSPACE_SECRETS_KEY: randomBytes(32).toString('hex') }
  const previous = Object.fromEntries(Object.keys(environment).map(name => [name, process.env[name]]))
  Object.assign(process.env, environment)
  let appPool: Pool | undefined, workspacePool: Pool | undefined
  try {
    const migrations = new URL('../../../drizzle/', import.meta.url)
    for (const name of orderMigrations((await readdir(migrations)).filter(name => name.endsWith('.sql'))))
      await pool.query(await readFile(new URL(name, migrations), 'utf8'))
    const next = await import('next/server')
    mock.module('next/server', { namedExports: { ...next, after() {} } })
    mock.module('next/headers', { namedExports: { headers: async () => new Headers(), cookies: async () => ({
      get: () => undefined, getAll: () => [], has: () => false, set() {}, delete() {},
    }) } })
    mock.module('next-intl/server', { namedExports: { getLocale: async () => 'en',
      getTranslations: async () => Object.assign((key: string) => key, { has: () => true }) } })
    const { resolveRunWorktree } = await import('../identity')
    const { resolveReviewScope, withReviewTransaction } = await import('../diff/authority')
    const { secretMaskerFor } = await import('../../secrets/runtime')
    const { prepareCheckpointReview, retainCheckpointReview } = await import('../diff/checkpoint')
    const { latestDiffSnapshot, manifestRevision, readDiffSnapshot, readStoredDiffFile, retainDiffSnapshot } = await import('../diff/store')
    const { diffFileVersion } = await import('../diff/patch')
    const { validateDiffReceipt } = await import('../diff/receipt')
    const { frozenReviewBatch } = await import('../diff/batch-store')
    const { currentTaskReview, selectedTaskReview } = await import('./context')
    const { taskCommentAnchor } = await import('./anchor')
    const { readTaskReview, readTaskReviewFile, readTaskReviewSummary, summarySnapshot, taskReviewSummary } = await import('./read')
    const { markTaskReviewFiles } = await import('./reviewed')
    const { retainTaskPullState } = await import('./pull-state')
    const { hasCommitEffect } = await import('../../db/commit-effects')
    const { wakeTokens, wakeTransport } = await import('../../workflow-wake')
    const { taskReviewDiff, taskReviewFile } = await import('./projection')
    appPool = (await import('../../db')).pool; workspacePool = (await import('../../workspace-db')).workspacePool
    const deps = { database: pool, membership: pool }
    type Summary = Awaited<ReturnType<typeof taskReviewSummary>>
    type Page = { summary: Summary; diff: ReturnType<typeof taskReviewDiff> & { boardRevision: number | null } }
    type Mark = ReviewMutationReceipt & { reviewRef: TaskReviewRef }
    type File = { reviewRef: TaskReviewRef; file: ReturnType<typeof taskReviewFile>;
      comments: { id: string; path: string; line: number; side: 'old' | 'new'; body: string; author: string; sentAt: string }[];
      nextCommentsCursor?: string }
    const git = async (cwd: string, ...args: string[]) => (await execute('git', ['-C', cwd,
      '-c', 'user.name=Task review fixture', '-c', 'user.email=task-review@example.invalid',
      '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args])).stdout.trim()
    async function user() {
      const id = 'task-review-' + randomUUID(), sessionId = randomUUID()
      await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())',
        [id, id + '@example.invalid'])
      await pool.query('INSERT INTO "session"(id,token,"userId","expiresAt","createdAt","updatedAt") VALUES($1,$2,$3,now()+interval \'1 hour\',now(),now())',
        [sessionId, randomUUID(), id])
      return { id, sessionId }
    }
    type User = Awaited<ReturnType<typeof user>>
    const owner = await user(), member = await user(), outsider = await user()
    async function workspace() {
      const id = randomUUID(), teamId = randomUUID()
      await pool.query('INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,$2,\'Task review fixture\')', [id, owner.id])
      for (const who of [owner, member])
        await pool.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$3,$4,\'active\')',
          [id, who.id, who.id + '@example.invalid', who === owner ? 'admin' : 'member'])
      await pool.query('INSERT INTO mikka_teams(id,"workspaceId","userId",name,identifier) VALUES($1,$2,$3,\'Task review fixture\',$4)',
        [teamId, id, owner.id, 'T' + randomUUID().replaceAll('-', '').slice(0, 7).toUpperCase()])
      await pool.query('INSERT INTO mikka_team_members("teamId","userId",role) VALUES($1,$2,\'owner\')', [teamId, owner.id])
      return { id, teamId }
    }
    const actor = (who: User, workspaceId: string): ReviewActor => ({ userId: who.id, workspaceId,
      credential: { kind: 'session', id: who.sessionId } })
    async function fixture() {
      const where = await workspace(), runId = randomUUID(), repoId = randomUUID(), taskId = randomUUID(),
        deviceId = randomUUID(), tokenId = randomUUID(), agentId = randomUUID()
      const repository = join(directory, runId, 'repository'), worktree = join(directory, runId, 'checkout')
      await mkdir(repository, { recursive: true })
      await git(repository, 'init', '--initial-branch=main')
      await git(repository, 'config', 'core.autocrlf', 'false')
      await git(repository, 'remote', 'add', 'origin', remote)
      for (const path of ['alpha.txt', 'beta.txt', 'gamma.txt']) await writeFile(join(repository, path), 'before ' + path + '\nstable\n')
      await git(repository, 'add', '--all'); await git(repository, 'commit', '-qm', 'review base')
      await git(repository, 'worktree', 'add', '-q', '--detach', worktree, 'HEAD')
      const baseSha = await git(worktree, 'rev-parse', 'HEAD')
      await pool.query('INSERT INTO issues(id,"userId",title,content,status,priority,scope) VALUES($1,$2,\'Task review fixture\',\'{"type":"doc","content":[]}\',\'doing\',\'normal\',\'workspace\')',
        [taskId, owner.id])
      await pool.query('INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId") VALUES($1,$2,$3,$4)',
        [taskId, where.teamId, where.id, owner.id])
      await pool.query('INSERT INTO devices(id,"ownerId",name,kind) VALUES($1,$2,\'Task review fixture\',\'local\')', [deviceId, owner.id])
      await pool.query('INSERT INTO agents(id,"userId",name,harness,"deviceId") VALUES($1,$2,$3,\'codex\',$4)',
        [agentId, owner.id, 'Task review ' + runId, deviceId])
      await pool.query('INSERT INTO device_repos(id,"userId","deviceId","repoPath","remoteUrl") VALUES($1,$2,$3,$4,$5)',
        [repoId, owner.id, deviceId, remoteKey(remote), remote])
      await pool.query('INSERT INTO device_tokens(id,"userId","tokenHash","expiresAt") VALUES($1,$2,$3,now()+interval \'1 hour\')',
        [tokenId, owner.id, hash(randomUUID())])
      await pool.query('INSERT INTO agent_runs(id,"userId","issueId","agentId","deviceId","deviceRepoId","deviceTokenId",status,"worktreePath","leaseExpiresAt","agentDefinition") ' +
        'VALUES($1,$2,$3,$4,$5,$6,$7,\'running\',$8,now()+interval \'10 minutes\',$9)',
      [runId, owner.id, taskId, agentId, deviceId, repoId, tokenId, worktree,
        { executionIdentity: { workspaceId: where.id }, repositoryAdmission: { workspaceId: where.id, remoteKey: remoteKey(remote) } }])
      const who = actor(owner, where.id), viewer = actor(member, where.id)
      const identity = (await resolveRunWorktree(pool, pool, who, runId, repoId)).identity
      const entry: JournalEntry = { assignment: runAssignmentSchema.parse({ runId, issueId: taskId, repoId, deviceId,
        remoteUrl: remote, baseBranch: 'main', harness: 'codex', prompt: 'Read this exact task.', kind: 'implement' }),
      state: 'running', sessionId: null, worktree, baseCommit: baseSha, lastSeq: 0, error: null, updatedAt: new Date().toISOString() }
      for (const path of ['alpha.txt', 'beta.txt', 'gamma.txt']) await writeFile(join(worktree, path), 'after ' + path + '\nstable\n')
      return { where, runId, repoId, taskId, deviceId, tokenId, agentId, repository, worktree, baseSha, who, viewer, identity, entry }
    }
    type Fixture = Awaited<ReturnType<typeof fixture>>
    async function checkpoint(f: Fixture) {
      const captured = await takeCheckpoint({ repoPath: f.repository, worktree: f.worktree, baseCommit: f.baseSha, repoId: f.repoId })
      assert.ok(captured)
      const proof = checkpointReviewEvidence.parse(captured.checkpoint.review)
      assert.equal(proof.reason, null)
      assert.ok(proof.blobs.length > 0, 'checkpoint content comes from complete real Git blob proofs')
      const mask = await secretMaskerFor({ workspaceId: f.where.id, ownerId: owner.id })
      const prepared = prepareCheckpointReview(captured.checkpoint, f.repoId, mask)
      assert.equal(prepared.reason, null)
      return withReviewTransaction(pool, pool, f.who, f.runId, f.repoId, async (tx, scope) => {
        await retainCheckpointReview(tx, scope, prepared, new Date(captured.checkpoint.takenAt), mask)
        const { rows: [saved] } = await tx.query<{ snapshotId: string; reason: string | null }>(
          'SELECT "snapshotId",reason FROM coding_workspace_checkpoint_reviews WHERE "runId"=$1', [f.runId])
        assert.ok(saved?.snapshotId); assert.equal(saved.reason, null)
        return readDiffSnapshot(tx, scope, saved.snapshotId)
      }, { live: f.identity })
    }
    const stop = (f: Fixture) => pool.query('UPDATE agent_runs SET status=\'stopped\',"stopRequestedAt"=now(),"finishedAt"=now() WHERE id=$1', [f.runId])
    async function localSnapshot(f: Fixture, request: Extract<WorkspaceReadCommand['request'], { kind: 'diff_snapshot' }> = {
      kind: 'diff_snapshot', source: 'working',
    }) {
      const command: WorkspaceReadCommand = { id: randomUUID(), identity: f.identity, request,
        expiresAt: new Date(Date.now() + 15_000).toISOString() }
      const mask = await secretMaskerFor({ workspaceId: f.where.id, ownerId: owner.id })
      const receipt = workspaceReadReceipt.parse(await readWorkspaceDiffReceipt(command, f.entry, f.repository))
      const result = validateDiffReceipt(request, receipt, mask)
      assert.ok(result?.ok && result.kind === 'diff_snapshot')
      const snapshot = await withReviewTransaction(pool, pool, f.who, f.runId, f.repoId,
        (tx, scope) => retainDiffSnapshot(tx, scope, { revision: result.revision, files: result.files }, mask), { live: f.identity })
      return { snapshot, revision: result.revision, files: result.files }
    }
    async function commitSnapshot(f: Fixture) {
      await git(f.worktree, 'add', '--all'); await git(f.worktree, 'commit', '-qm', 'Explicit review commit filter')
      return localSnapshot(f, { kind: 'diff_snapshot', source: 'commit', baseSha: f.baseSha, headSha: await git(f.worktree, 'rev-parse', 'HEAD') })
    }
    async function retainPull(f: Fixture, native: Awaited<ReturnType<typeof localSnapshot>>, number: number, factory?: DiffSnapshot['factory']) {
      assert.equal(native.revision.source, 'commit')
      const baseSha = native.revision.baseSha!, headSha = native.revision.headSha!
      const sourceAccess = { kind: 'github' as const, repositoryId: '61393725', manifestComplete: true as const,
        pullRequestNumber: number, pullRequestBaseSha: baseSha }
      const files: DiffFileMetadata[] = native.files.map(file => {
        const metadata = { ...file, github: { repositoryId: sourceAccess.repositoryId, patchSha256: null, page: null } }
        return { ...metadata, fileVersion: diffFileVersion(f.repoId, native.revision, metadata) }
      })
      const mask = await secretMaskerFor({ workspaceId: f.where.id, ownerId: owner.id })
      return withReviewTransaction(pool, pool, f.who, f.runId, f.repoId, (tx, scope) => retainDiffSnapshot(tx, scope, {
        revision: manifestRevision('pull_request', baseSha, headSha, native.revision.treeSha, files, sourceAccess), files, sourceAccess,
        pullRequest: { number, url: `https://github.com/mikka-fixtures/task-review/pull/${number}`, baseSha, headSha, state: 'open' },
        ...(factory ? { factory } : {}),
      }, mask), { live: f.identity })
    }
    const associatePull = (f: Fixture, number: number) => pool.query(`INSERT INTO run_publications
      ("runId","userId","issueId","remoteUrl","remoteKey",status,"pullRequest") VALUES($1,$2,$3,$4,$5,'published',$6)
      ON CONFLICT("runId") DO UPDATE SET status='published',"pullRequest"=EXCLUDED."pullRequest"`,
    [f.runId, owner.id, f.taskId, remote, remoteKey(remote), { url: `https://github.com/mikka-fixtures/task-review/pull/${number}`, state: 'open' }])
    const external = (verify: ExternalDiffProvider['verify']): ExternalDiffProvider => ({ verify,
      capture: async () => { assert.fail('summary reads must not capture a new native source') },
      file: async () => { assert.fail('summary reads must not fetch native file contents') },
    })
    const input = (f: Fixture, query: Record<string, unknown>, who = f.who): TaskReviewHttpInput => ({
      request: new Request('http://127.0.0.1:3199/api/tasks/' + f.taskId + '/review'), actor: who, deps, taskId: f.taskId, input: query,
    })
    async function render<T>(result: TaskReviewHttpResult, who: ReviewActor): Promise<T> {
      assert.ok(result.context, 'a real Task source must reach the protected renderer')
      return withReviewTransaction(pool, pool, who, result.context.scope.identity.runId, result.context.scope.identity.repoId,
        async (tx, scope) => (await result.render(tx, scope)).body as T)
    }
    const page = async (f: Fixture, query: Record<string, unknown>, who = f.who) => render<Page>(await readTaskReview(input(f, query, who)), who)
    const mark = async (f: Fixture, value: Record<string, unknown>, who = f.who) =>
      render<Mark>(await markTaskReviewFiles(input(f, value, who)), who)
    const file = async (f: Fixture, snapshot: DiffSnapshot, path = 'alpha.txt', who = f.who, cursor?: string) =>
      render<File>(await readTaskReviewFile(input(f, { ...reference(snapshot), path, ...(cursor ? { cursor } : {}) }, who)), who)
    async function anchor(f: Fixture, snapshot: DiffSnapshot, path = 'alpha.txt') {
      const scope = await resolveReviewScope(pool, pool, f.who, f.runId, f.repoId)
      const stored = await readStoredDiffFile(pool, scope, snapshot, path, await secretMaskerFor({ workspaceId: f.where.id, ownerId: owner.id }))
      assert.ok(stored.patch)
      return taskCommentAnchor(stored.patch, { path, line: 1, side: 'new', body: 'Fixture' })
    }
    type Comment = { id: string; anchor: ReviewAnchor; body: string }
    async function batch(f: Fixture, snapshot: DiffSnapshot, comments: Comment[], options: {
      destination?: 'agent' | 'github'; state?: 'prepared' | 'uncertain' | 'accepted'; at?: string;
    } = {}) {
      const scope = await resolveReviewScope(pool, pool, f.who, f.runId, f.repoId), id = randomUUID()
      const destination = options.destination ?? 'agent', state = options.state ?? 'accepted'
      const frozen = frozenReviewBatch.parse({ version: 1, sourceVersion: snapshot.revision.version, runId: f.runId, repoId: f.repoId,
        commentIds: comments.map(comment => comment.id), ...(destination === 'agent'
          ? { agent: { text: 'Frozen task review', comments, note: '', failedCheckRefs: [] } }
          : { native: { githubAccountId: '12345', write: { kind: 'github_review', event: 'COMMENT', note: '', comments } } }) })
      await pool.query('INSERT INTO coding_workspace_review_batches(id,"boardId","snapshotId","userId",fingerprint,destination,state,input,receipt,"updatedAt") ' +
        'VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [id, scope.boardId, snapshot.id, owner.id, hash(id), destination, state, frozen,
        { batchId: id, destination, state, sourceVersion: snapshot.revision.version, revision: 0,
          delivery: state === 'accepted' ? { kind: destination === 'agent' ? 'run_message' : 'github_review', id: randomUUID() } : null },
        options.at ?? new Date().toISOString()])
      return id
    }
    async function extraRun(f: Fixture, who: User, seconds: number) {
      const id = randomUUID(), agentId = randomUUID()
      await pool.query('INSERT INTO agents(id,"userId",name,harness) VALUES($1,$2,$3,\'codex\')', [agentId, who.id, 'Other thread ' + id])
      await pool.query('INSERT INTO agent_runs(id,"userId","issueId","agentId",status,"createdAt","agentDefinition") ' +
        'VALUES($1,$2,$3,$4,\'stopped\',clock_timestamp()+$5*interval \'1 second\',$6)',
      [id, who.id, f.taskId, agentId, seconds, { executionIdentity: { workspaceId: f.where.id } }])
      return id
    }
    async function factoryCheck(f: Fixture, stage: 'review' | 'verify' | 'monitor', seconds: number) {
      const runId = await extraRun(f, owner, seconds), taskId = randomUUID(), attemptId = randomUUID(), sourceEventId = randomUUID()
      const tx = await pool.connect()
      try {
        await tx.query('BEGIN')
        await tx.query('INSERT INTO coordinator_events(id,"userId","issueId",kind,"dedupeKey",payload) VALUES($1::uuid,$2,$3,\'user_message\',$1::text,\'{"text":"Review fixture"}\')',
          [sourceEventId, owner.id, f.taskId])
        await tx.query('INSERT INTO factory_tasks(id,"userId","issueId","sourceEventId",route,stage,status,revision,"attemptId",reason) ' +
          'VALUES($1,$2,$3,$4,$5,$6,\'running\',1,$7,\'Task review check fixture\')',
        [taskId, owner.id, f.taskId, sourceEventId, { issueId: f.taskId, sourceEventId, eventId: randomUUID(), rationale: 'Fixture' }, stage, attemptId])
        await tx.query('INSERT INTO factory_attempts(id,"taskId",stage,ordinal,position,status,"runId",reason,output) ' +
          'VALUES($1,$2,$3,1,1,\'running\',$4,\'Task review check fixture\',$5)', [attemptId, taskId, stage, runId, { requestEpoch: sourceEventId }])
        await tx.query('COMMIT')
      } catch (error) { await tx.query('ROLLBACK'); throw error } finally { tx.release() }
      return runId
    }

    await t.test('selected source permits the owner and current Team viewer, but rejects another Task, workspace and nonmember', async () => {
      const f = await fixture(), snapshot = await checkpoint(f), elsewhere = await workspace()
      for (const who of [f.who, f.viewer]) {
        const selected = await selectedTaskReview(deps, who, f.taskId, reference(snapshot))
        assert.equal(selected.ownerId, owner.id); assert.equal(selected.scope.identity.runId, f.runId)
        assert.equal(selected.snapshot.id, snapshot.id)
      }
      await assert.rejects(() => selectedTaskReview(deps, actor(owner, elsewhere.id), f.taskId, reference(snapshot)), code('workspace_not_found'))
      await assert.rejects(() => selectedTaskReview(deps, actor(outsider, f.where.id), f.taskId, reference(snapshot)), code('workspace_not_found'))
      const otherTask = randomUUID()
      await pool.query('INSERT INTO issues(id,"userId",title,content,status,priority,scope) VALUES($1,$2,\'Other task\',\'{"type":"doc","content":[]}\',\'doing\',\'normal\',\'workspace\')', [otherTask, owner.id])
      await pool.query('INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId") VALUES($1,$2,$3,$4)',
        [otherTask, f.where.teamId, f.where.id, owner.id])
      await assert.rejects(() => selectedTaskReview(deps, f.who, otherTask, reference(snapshot)), code('workspace_not_found'))
      await assert.rejects(() => selectedTaskReview(deps, f.who, f.taskId, { snapshotId: snapshot.id, sourceVersion: '0'.repeat(64) }),
        code('workspace_snapshot_outdated'))
    })

    await t.test('current Task follows its persisted owner, excluding the viewer thread and newer Factory checks', async () => {
      const f = await fixture(); await checkpoint(f)
      const viewerRun = await extraRun(f, member, 10)
      const checks: string[] = []
      for (const [index, stage] of (['review', 'verify', 'monitor'] as const).entries()) checks.push(await factoryCheck(f, stage, 20 + index))
      for (const who of [f.who, f.viewer]) {
        const current = await currentTaskReview(deps, who, f.taskId)
        assert.ok(current)
        assert.equal(current.scope.identity.runId, f.runId)
        assert.notEqual(current.scope.identity.runId, viewerRun)
        assert.ok(!checks.includes(current.scope.identity.runId))
        assert.equal(current.ownerId, owner.id); assert.equal(current.scope.identity.repoId, f.repoId)
      }
    })

    await t.test('frozen source remains readable after device/repo deletion, but fresh Team and membership gates still apply', async () => {
      const f = await fixture(), snapshot = await checkpoint(f)
      await pool.query('UPDATE agent_runs SET status=\'stopped\',"stopRequestedAt"=now(),"finishedAt"=now() WHERE id=$1', [f.runId])
      await pool.query('DELETE FROM devices WHERE id=$1', [f.deviceId])
      assert.equal((await pool.query('SELECT 1 FROM device_repos WHERE id=$1', [f.repoId])).rowCount, 0)
      assert.equal((await currentTaskReview(deps, f.viewer, f.taskId))?.scope.identity.repoId, f.repoId)
      assert.match((await file(f, snapshot, 'alpha.txt', f.viewer)).file.patch ?? '', /\+after alpha\.txt/)
      await pool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [f.where.id, member.id])
      await assert.rejects(() => selectedTaskReview(deps, f.viewer, f.taskId, reference(snapshot)), code('workspace_not_found'))
      await pool.query('DELETE FROM mikka_team_issues WHERE "issueId"=$1', [f.taskId])
      await assert.rejects(() => selectedTaskReview(deps, f.who, f.taskId, reference(snapshot)), code('workspace_not_found'))
    })

    await t.test('moving the Task to another workspace does not move the retained source authority', async () => {
      const f = await fixture(), snapshot = await checkpoint(f), elsewhere = await workspace()
      await pool.query('DELETE FROM mikka_team_issues WHERE "issueId"=$1', [f.taskId])
      await pool.query('INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId") VALUES($1,$2,$3,$4)',
        [f.taskId, elsewhere.teamId, elsewhere.id, owner.id])
      await assert.rejects(() => selectedTaskReview(deps, f.who, f.taskId, reference(snapshot)), code('workspace_not_found'))
      await assert.rejects(() => selectedTaskReview(deps, actor(owner, elsewhere.id), f.taskId, reference(snapshot)), code('workspace_not_found'))
    })

    await t.test('checkpoint page and summary render real counts and per-viewer reviewed marks without source proofs', async () => {
      const f = await fixture(), snapshot = await checkpoint(f)
      const scope = await resolveReviewScope(pool, pool, f.who, f.runId, f.repoId)
      const { rows: [entry] } = await pool.query<{ metadata: { fileVersion: string } }>(
        'SELECT metadata FROM coding_workspace_snapshot_files WHERE "snapshotId"=$1 AND path=\'alpha.txt\'', [snapshot.id])
      await pool.query('INSERT INTO coding_workspace_reviewed_files("boardId","userId",path,"fileVersion") VALUES($1,$2,\'alpha.txt\',$3)',
        [scope.boardId, owner.id, entry.metadata.fileVersion])
      const own = await page(f, { ...reference(snapshot), limit: 2 })
      assert.equal(own.summary.files, 3); assert.equal(own.summary.additions, 3); assert.equal(own.summary.deletions, 3)
      assert.equal(own.summary.countsKnown, true); assert.equal(own.summary.checks, null)
      assert.equal(own.diff.source.kind, 'checkpoint'); assert.equal(own.diff.live, false); assert.equal(own.diff.empty, false)
      assert.deepEqual(own.diff.reviewRef, reference(snapshot))
      assert.deepEqual(own.diff.files.map(value => value.path), ['alpha.txt', 'beta.txt'])
      assert.equal(own.diff.files[0]!.viewed, true); assert.equal(own.diff.files[0]!.patch, null)
      assert.equal((await page(f, { ...reference(snapshot), limit: 2 }, f.viewer)).diff.files[0]!.viewed, false)
      await stop(f)
      const summary = await render<Summary>(await readTaskReviewSummary(input(f, {})), f.who)
      assert.deepEqual(summary.reviewRef, reference(snapshot)); assert.equal(summary.files, 3)
      assert.equal(summary.permissions.canSend, true)
      const shared = await render<Summary>(await readTaskReviewSummary(input(f, {}, f.viewer)), f.viewer)
      assert.equal(shared.permissions.canSend, false)
      const serialized = JSON.stringify(await file(f, snapshot))
      for (const privateKey of ['base64', 'rawBlob', 'rawSize', 'workingVersion', 'repositoryKey', 'tokenHash', 'blobs'])
        assert.ok(!serialized.includes('"' + privateKey + '"'), 'public projection excludes ' + privateKey)
    })

    await t.test('reviewed writes replay once for the same viewer and remain independent for each Task member', async () => {
      const f = await fixture(), snapshot = await checkpoint(f), initial = await page(f, reference(snapshot))
      const revision = initial.diff.boardRevision
      assert.ok(revision !== null)
      const alpha = initial.diff.files.find(value => value.path === 'alpha.txt')!
      const request = { reviewRef: reference(snapshot), idempotencyKey: 'review-alpha', expectedRevision: revision,
        files: [{ path: alpha.path, fileVersion: alpha.fileVersion, reviewed: true }] }
      const receipt = await mark(f, request)
      assert.deepEqual(receipt.reviewRef, reference(snapshot)); assert.equal(receipt.action, 'reviewed')
      assert.equal(receipt.revision, revision + 1); assert.equal(receipt.changed, 1)
      const scope = await resolveReviewScope(pool, pool, f.who, f.runId, f.repoId)
      const saved = async () => (await pool.query('SELECT "userId",path,"fileVersion","reviewedAt" FROM coding_workspace_reviewed_files WHERE "boardId"=$1 ORDER BY "userId",path', [scope.boardId])).rows
      const beforeReplay = await saved()
      assert.deepEqual(await mark(f, request), receipt)
      assert.deepEqual(await saved(), beforeReplay, 'a retry must not rewrite reviewedAt')
      assert.equal((await file(f, snapshot)).file.viewed, true)
      assert.equal((await file(f, snapshot, alpha.path, f.viewer)).file.viewed, false)
      const memberReceipt = await mark(f, { ...request, expectedRevision: receipt.revision }, f.viewer)
      assert.equal(memberReceipt.revision, receipt.revision + 1)
      assert.notEqual(memberReceipt.requestId, receipt.requestId, 'the same client key is scoped to the acting member')
      assert.equal((await file(f, snapshot, alpha.path, f.viewer)).file.viewed, true)
      const unmark = await mark(f, { ...request, idempotencyKey: 'unreview-alpha', expectedRevision: memberReceipt.revision,
        files: [{ ...request.files[0]!, reviewed: false }] })
      assert.equal(unmark.revision, revision + 3)
      assert.deepEqual(await mark(f, request), receipt, 'even after an undo, an old request remains its original receipt')
      assert.equal((await file(f, snapshot)).file.viewed, false)
      assert.equal((await file(f, snapshot, alpha.path, f.viewer)).file.viewed, true)
      assert.equal((await page(f, reference(snapshot))).diff.boardRevision, unmark.revision)
      assert.deepEqual((await saved()).map(row => ({ userId: row.userId, path: row.path, fileVersion: row.fileVersion })),
        [{ userId: member.id, path: alpha.path, fileVersion: alpha.fileVersion }])
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM coding_workspace_review_receipts WHERE "boardId"=$1', [scope.boardId])).rows[0].count, 3)
    })

    await t.test('reviewed writes reject mixed references and file versions, and concurrent compare-and-swap admits one mutation', async () => {
      const f = await fixture(), first = await checkpoint(f), initial = await page(f, reference(first))
      const revision = initial.diff.boardRevision
      assert.ok(revision !== null)
      await writeFile(join(f.worktree, 'alpha.txt'), 'a different reviewed source\nstable\n')
      const second = await checkpoint(f)
      assert.equal(first.revision.headSha, second.revision.headSha); assert.notEqual(first.revision.version, second.revision.version)
      const scope = await resolveReviewScope(pool, pool, f.who, f.runId, f.repoId)
      const state = async () => ({
        board: (await pool.query('SELECT revision FROM coding_workspace_review_boards WHERE id=$1', [scope.boardId])).rows,
        marks: (await pool.query('SELECT * FROM coding_workspace_reviewed_files WHERE "boardId"=$1 ORDER BY "userId",path', [scope.boardId])).rows,
        receipts: (await pool.query('SELECT * FROM coding_workspace_review_receipts WHERE "boardId"=$1 ORDER BY "userId","requestId"', [scope.boardId])).rows,
      })
      const requests = initial.diff.files.slice(0, 2).map(value => ({ reviewRef: reference(first),
        idempotencyKey: 'concurrent-' + value.path, expectedRevision: revision,
        files: [{ path: value.path, fileVersion: value.fileVersion, reviewed: true }] }))
      const before = await state()
      await assert.rejects(() => mark(f, { ...requests[0]!, idempotencyKey: 'wrong-file-version',
        files: [{ ...requests[0]!.files[0]!, fileVersion: hash('another immutable file version') }] }), code('workspace_snapshot_outdated'))
      await assert.rejects(() => mark(f, { ...requests[0]!, idempotencyKey: 'mixed-reference',
        reviewRef: { snapshotId: first.id, sourceVersion: second.revision.version } }), code('workspace_snapshot_outdated'))
      assert.deepEqual(await state(), before, 'invalid evidence must leave no mark, receipt or revision change')
      const outcomes = await Promise.allSettled(requests.map(value => mark(f, value)))
      const accepted = outcomes.filter(value => value.status === 'fulfilled'), rejected = outcomes.filter(value => value.status === 'rejected')
      assert.equal(accepted.length, 1); assert.equal(rejected.length, 1)
      assert.ok(code('workspace_review_conflict')(rejected[0]!.reason))
      assert.equal(accepted[0]!.value.revision, revision + 1)
      const after = await state()
      assert.deepEqual(after.board, [{ revision: revision + 1 }]); assert.equal(after.marks.length, 1); assert.equal(after.receipts.length, 1)
      const winner = requests[outcomes.findIndex(value => value.status === 'fulfilled')]!
      await assert.rejects(() => mark(f, { ...winner, files: [{ ...winner.files[0]!, reviewed: false }] }), code('workspace_review_conflict'))
      await assert.rejects(() => mark(f, { ...winner, idempotencyKey: 'stale-revision' }), code('workspace_review_conflict'))
      assert.deepEqual(await state(), after, 'conflicting replay and stale revision must not add a second mutation')
    })

    await t.test('only-unreviewed pagination binds the filter and revision while preserving each viewer marks', async () => {
      const f = await fixture(), snapshot = await checkpoint(f), initial = await page(f, reference(snapshot))
      const revision = initial.diff.boardRevision
      assert.ok(revision !== null)
      const alpha = initial.diff.files.find(value => value.path === 'alpha.txt')!
      const receipt = await mark(f, { reviewRef: reference(snapshot), idempotencyKey: 'review-first', expectedRevision: revision,
        files: [{ path: alpha.path, fileVersion: alpha.fileVersion, reviewed: true }] })
      const first = await page(f, { ...reference(snapshot), unreviewed: 'true', limit: 1 })
      assert.equal(first.diff.boardRevision, receipt.revision)
      assert.deepEqual(first.diff.files.map(value => [value.path, value.viewed]), [['beta.txt', false]])
      assert.ok(first.diff.nextCursor)
      const last = await page(f, { cursor: first.diff.nextCursor, limit: 1 })
      assert.deepEqual(last.diff.reviewRef, reference(snapshot))
      assert.deepEqual(last.diff.files.map(value => [value.path, value.viewed]), [['gamma.txt', false]])
      assert.equal(last.diff.nextCursor, undefined)
      await assert.rejects(() => page(f, { cursor: first.diff.nextCursor, unreviewed: 'false' }), code('workspace_snapshot_outdated'))
      const all = await page(f, { ...reference(snapshot), unreviewed: 'false', limit: 1 })
      assert.ok(all.diff.nextCursor); assert.equal(all.diff.files[0]!.path, 'alpha.txt'); assert.equal(all.diff.files[0]!.viewed, true)
      await assert.rejects(() => page(f, { cursor: all.diff.nextCursor, unreviewed: 'true' }), code('workspace_snapshot_outdated'))
      const tampered = JSON.parse(Buffer.from(first.diff.nextCursor, 'base64url').toString('utf8')) as { unreviewed: boolean }
      tampered.unreviewed = false
      await assert.rejects(() => page(f, { cursor: Buffer.from(JSON.stringify(tampered)).toString('base64url') }), code('workspace_snapshot_outdated'))
      const memberPage = await page(f, { ...reference(snapshot), unreviewed: 'true', limit: 1 }, f.viewer)
      assert.deepEqual(memberPage.diff.files.map(value => [value.path, value.viewed]), [['alpha.txt', false]])
      const completed = await mark(f, { reviewRef: reference(snapshot), idempotencyKey: 'review-remaining', expectedRevision: receipt.revision,
        files: initial.diff.files.filter(value => value.path !== alpha.path).map(value => ({ path: value.path, fileVersion: value.fileVersion, reviewed: true })) })
      await assert.rejects(() => page(f, { cursor: first.diff.nextCursor }), code('workspace_review_conflict'))
      const none = await page(f, { ...reference(snapshot), unreviewed: 'true' })
      assert.equal(none.diff.boardRevision, completed.revision); assert.deepEqual(none.diff.files, [])
      assert.equal(none.diff.nextCursor, undefined); assert.equal(none.diff.empty, false, 'an exhausted filter does not turn a nonempty source into an empty diff')
      assert.equal(none.summary.files, 3)
    })

    await t.test('a member default read uses the retained working source without contacting the owner daemon or claiming it is live', async () => {
      const f = await fixture(), working = (await localSnapshot(f)).snapshot
      const shared = await page(f, {}, f.viewer)
      assert.deepEqual(shared.diff.reviewRef, reference(working)); assert.deepEqual(shared.summary.reviewRef, reference(working))
      assert.equal(shared.diff.source.kind, 'machine'); assert.equal(shared.diff.source.stale, true)
      assert.equal(shared.diff.live, false); assert.equal(shared.summary.running, true)
      assert.equal(shared.diff.files.length, 3); assert.equal(shared.summary.countsKnown, false)
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM coding_workspace_requests WHERE "runId"=$1', [f.runId])).rows[0].count, 0)
    })

    await t.test('an explicit real commit subset keeps the current whole-PR Task summary', async () => {
      const f = await fixture()
      await git(f.worktree, 'add', 'alpha.txt'); await git(f.worktree, 'commit', '-qm', 'Only alpha belongs to the selected commit')
      const selectedSha = await git(f.worktree, 'rev-parse', 'HEAD')
      const subset = await localSnapshot(f, { kind: 'diff_snapshot', source: 'commit', baseSha: f.baseSha, headSha: selectedSha })
      assert.deepEqual(subset.files.map(value => value.path), ['alpha.txt'])
      const complete = await commitSnapshot(f)
      assert.equal(complete.files.length, 3); assert.notEqual(complete.revision.headSha, selectedSha)
      await associatePull(f, 104)
      const whole = await retainPull(f, complete, 104)
      const sourceAccess = { kind: 'github' as const, repositoryId: '61393725', manifestComplete: true as const }
      const files = subset.files.map(value => {
        const metadata = { ...value, github: { repositoryId: sourceAccess.repositoryId, patchSha256: null, page: null } }
        return { ...metadata, fileVersion: diffFileVersion(f.repoId, subset.revision, metadata) }
      })
      const revision = manifestRevision('commit', f.baseSha, selectedSha, subset.revision.treeSha, files, sourceAccess)
      let captures = 0
      const verified: string[] = [], provider: ExternalDiffProvider = {
        ...external(async (_scope, selected) => { verified.push(selected.id) }),
        capture: async (scope, selection) => {
          captures++; assert.equal(scope.identity.runId, f.runId)
          assert.deepEqual(selection, { source: 'commit', baseSha: f.baseSha, headSha: selectedSha })
          return { revision, files, sourceAccess }
        },
      }
      const request = (query: Record<string, unknown>) => ({ ...input(f, query, f.viewer), deps: { ...deps, external: provider } })
      const filtered = await render<Page>(await readTaskReview(request({ ...reference(whole), commit: selectedSha })), f.viewer)
      assert.equal(captures, 1); assert.equal(filtered.diff.source.kind, 'commit'); assert.equal(filtered.diff.head, selectedSha)
      assert.deepEqual(filtered.diff.files.map(value => value.path), ['alpha.txt'])
      assert.deepEqual(filtered.summary.reviewRef, reference(whole)); assert.equal(filtered.summary.pr?.number, 104)
      assert.equal(filtered.summary.files, 3); assert.notDeepEqual(filtered.diff.reviewRef, filtered.summary.reviewRef)
      const current = await render<Summary>(await readTaskReviewSummary(request({})), f.viewer)
      assert.deepEqual(filtered.summary, current)
      assert.deepEqual(verified, [filtered.diff.reviewRef!.snapshotId, whole.id])
    })

    await t.test('PR state cache retains the newest per-viewer observation and wakes the run only for actual state changes', async () => {
      const f = await fixture(), native = await commitSnapshot(f)
      await associatePull(f, 105)
      const snapshot = await retainPull(f, native, 105)
      assert.equal(snapshot.pullRequest?.baseSha, f.baseSha)
      const observation = (state: ObservedPullState['state'], second: number): ObservedPullState => ({
        repositoryId: snapshot.sourceAccess!.repositoryId, number: snapshot.pullRequest!.number,
        headSha: snapshot.revision.headSha!, baseSha: f.baseSha, state,
        observedAt: new Date(Date.UTC(2026, 10, 8, 12, 0, second)).toISOString(),
      })
      const previousResume = wakeTransport.resume
      // Inspect the real commit queue, using its transport seam without starting a Workflow world.
      wakeTransport.resume = async () => undefined
      try {
        const key = 'workflow-wake:' + wakeTokens.threadMachine(f.runId)
        const store = async (value: ObservedPullState, changed: boolean, who = f.who) => {
          await withReviewTransaction(pool, pool, who, f.runId, f.repoId, async (tx, scope) => {
            assert.equal(hasCommitEffect(tx, key), false)
            await retainTaskPullState(tx, who, scope, snapshot, value)
            assert.equal(hasCommitEffect(tx, key), changed, 'timestamp-only refreshes and older results must not enqueue runChanged')
          })
          const { rows: [saved] } = await pool.query<{ observation: ObservedPullState }>(
            'SELECT observation FROM coding_workspace_pull_states WHERE "snapshotId"=$1 AND "userId"=$2', [snapshot.id, who.userId])
          assert.ok(saved)
          return saved.observation
        }
        assert.deepEqual(await store(observation('open', 1), true), observation('open', 1))
        assert.deepEqual(await store(observation('open', 1), false), observation('open', 1))
        assert.deepEqual(await store(observation('open', 3), false), observation('open', 3))
        assert.deepEqual(await store(observation('approved', 2), false), observation('open', 3), 'a slower request cannot overwrite a newer result')
        assert.deepEqual(await store(observation('closed', 3), false), observation('open', 3), 'equal timestamps do not replace an existing observation')
        assert.deepEqual(await store(observation('approved', 4), true), observation('approved', 4))
        assert.deepEqual(await store(observation('approved', 5), false), observation('approved', 5))
        assert.deepEqual(await store(observation('changes_requested', 6), true, f.viewer), observation('changes_requested', 6))
        await assert.rejects(() => store({ ...observation('merged', 7), headSha: hash('a different native head').slice(0, 40) }, false), code('workspace_snapshot_outdated'))
        assert.deepEqual((await pool.query('SELECT "userId",observation FROM coding_workspace_pull_states WHERE "snapshotId"=$1 ORDER BY "userId"', [snapshot.id])).rows,
          [{ userId: owner.id, observation: observation('approved', 5) }, { userId: member.id, observation: observation('changes_requested', 6) }]
            .sort((left, right) => left.userId.localeCompare(right.userId)))
        const provider = external(async () => {})
        for (const [who, expected] of [[f.who, observation('approved', 5)], [f.viewer, observation('changes_requested', 6)]] as const) {
          const summary = await render<Summary>(await readTaskReviewSummary({ ...input(f, {}, who), deps: { ...deps, external: provider } }), who)
          assert.equal(summary.pr?.state, expected.state); assert.equal(summary.pr?.observedAt, expected.observedAt)
          assert.deepEqual(summary.reviewRef, reference(snapshot))
        }
      } finally { wakeTransport.resume = previousResume }
    })

    await t.test('an active summary uses its working snapshot even after newer checkpoint and commit-filter reads', async () => {
      const f = await fixture(), working = (await localSnapshot(f)).snapshot
      const retained = await checkpoint(f), commit = (await commitSnapshot(f)).snapshot
      const scope = await resolveReviewScope(pool, pool, f.who, f.runId, f.repoId)
      assert.equal((await latestDiffSnapshot(pool, scope))?.id, commit.id, 'the unrelated commit really is the newest retained row')
      assert.notEqual(working.id, retained.id)
      assert.equal((await summarySnapshot(pool, scope))?.id, working.id)
      const summary = await render<Summary>(await readTaskReviewSummary(input(f, {})), f.who)
      assert.deepEqual(summary.reviewRef, reference(working)); assert.equal(summary.running, true)
      assert.equal(summary.files, 3); assert.equal(summary.countsKnown, false)
      assert.notDeepEqual(summary.reviewRef, reference(commit))
    })

    await t.test('an ended summary follows the latest checkpoint observation even when it deduplicates to an older snapshot', async () => {
      const f = await fixture(), first = await checkpoint(f)
      await writeFile(join(f.worktree, 'alpha.txt'), 'a later checkpoint observation\nstable\n')
      const second = await checkpoint(f)
      await writeFile(join(f.worktree, 'alpha.txt'), 'after alpha.txt\nstable\n')
      const latest = await checkpoint(f)
      assert.equal(latest.id, first.id); assert.notEqual(latest.id, second.id)
      const commit = (await commitSnapshot(f)).snapshot
      await stop(f)
      const scope = await resolveReviewScope(pool, pool, f.who, f.runId, f.repoId)
      assert.equal((await latestDiffSnapshot(pool, scope, 'checkpoint'))?.id, second.id)
      assert.equal((await latestDiffSnapshot(pool, scope))?.id, commit.id)
      assert.equal((await summarySnapshot(pool, scope))?.id, first.id)
      const summary = await render<Summary>(await readTaskReviewSummary(input(f, {})), f.who)
      assert.deepEqual(summary.reviewRef, reference(first)); assert.equal(summary.running, false)
      assert.equal(summary.countsKnown, true); assert.equal(summary.files, 3)
    })

    await t.test('an explicitly unavailable latest checkpoint returns no current review instead of an old good snapshot or commit filter', async () => {
      const f = await fixture(), good = await checkpoint(f)
      await localSnapshot(f)
      const commit = (await commitSnapshot(f)).snapshot
      const captured = await takeCheckpoint({ repoPath: f.repository, worktree: f.worktree, baseCommit: f.baseSha, repoId: f.repoId })
      assert.ok(captured)
      const mask = await secretMaskerFor({ workspaceId: f.where.id, ownerId: owner.id })
      const unavailable = prepareCheckpointReview({ ...captured.checkpoint, review: undefined }, f.repoId, mask)
      assert.equal(unavailable.reason, 'missing_evidence')
      await withReviewTransaction(pool, pool, f.who, f.runId, f.repoId,
        (tx, scope) => retainCheckpointReview(tx, scope, unavailable, new Date(captured.checkpoint.takenAt), mask), { live: f.identity })
      assert.deepEqual((await pool.query('SELECT "snapshotId",reason FROM coding_workspace_checkpoint_reviews WHERE "runId"=$1', [f.runId])).rows,
        [{ snapshotId: null, reason: 'missing_evidence' }])
      await stop(f)
      const scope = await resolveReviewScope(pool, pool, f.who, f.runId, f.repoId)
      assert.equal((await latestDiffSnapshot(pool, scope, 'checkpoint'))?.id, good.id)
      assert.equal((await latestDiffSnapshot(pool, scope))?.id, commit.id)
      assert.equal(await summarySnapshot(pool, scope), null)
      const summary = await render<Summary>(await readTaskReviewSummary(input(f, {})), f.who)
      assert.equal(summary.reviewRef, null); assert.equal(summary.files, null); assert.equal(summary.countsKnown, false)
      assert.equal(summary.additions, null); assert.equal(summary.deletions, null); assert.equal(summary.permissions.canSend, false)
      assert.match((await file(f, good)).file.patch ?? '', /\+after alpha\.txt/, 'the old snapshot remains explicitly readable as history')
    })

    await t.test('the summary selects the currently associated PR across A to B to A, excluding a different Factory tuple', async () => {
      const f = await fixture(), native = await commitSnapshot(f)
      await associatePull(f, 101)
      const a = await retainPull(f, native, 101)
      await associatePull(f, 102)
      const b = await retainPull(f, native, 102)
      await associatePull(f, 101)
      const verified: string[] = [], provider = external(async (scope, snapshot) => {
        assert.equal(scope.identity.runId, f.runId); verified.push(snapshot.id)
      })
      const request = (query: Record<string, unknown> = {}) => ({ ...input(f, query), deps: { ...deps, external: provider } })
      const summary = await render<Summary>(await readTaskReviewSummary(request()), f.who)
      assert.deepEqual(summary.reviewRef, reference(a)); assert.equal(summary.pr?.number, 101)
      assert.deepEqual(verified, [a.id])
      const complete = await render<Page>(await readTaskReview(request(reference(a))), f.who)
      assert.deepEqual(complete.summary.reviewRef, summary.reviewRef); assert.deepEqual(complete.diff.reviewRef, summary.reviewRef)
      const pending = await readTaskReviewSummary(request())
      await associatePull(f, 102)
      await assert.rejects(() => render<Summary>(pending, f.who), code('workspace_snapshot_outdated'))
      assert.deepEqual((await render<Summary>(await readTaskReviewSummary(request()), f.who)).reviewRef, reference(b))
      await associatePull(f, 101)
      await writeFile(join(f.worktree, 'alpha.txt'), 'local work belonging to another Factory candidate\n')
      const otherNative = await commitSnapshot(f)
      const otherFactory = await retainPull(f, otherNative, 101, { taskId: randomUUID(), candidateId: randomUUID(),
        producerRunId: f.runId, sha: otherNative.revision.headSha! })
      const scope = await resolveReviewScope(pool, pool, f.who, f.runId, f.repoId)
      assert.equal((await latestDiffSnapshot(pool, scope, 'pull_request'))?.id, otherFactory.id)
      assert.equal((await summarySnapshot(pool, scope))?.id, a.id, 'matching the PR number alone cannot substitute another candidate')
      const restored = await render<Summary>(await readTaskReviewSummary(request()), f.who)
      assert.deepEqual(restored.reviewRef, reference(a)); assert.equal(verified.at(-1), a.id)
    })

    await t.test('a retained PR summary still requires the current viewer native access before returning metadata', async () => {
      const f = await fixture(), native = await commitSnapshot(f)
      await associatePull(f, 103)
      const snapshot = await retainPull(f, native, 103)
      await assert.rejects(() => readTaskReviewSummary(input(f, {})), code('workspace_review_github_unavailable'))
      let verifies = 0
      const denied = external(async (scope, selected) => {
        verifies++;
        assert.equal(scope.identity.ownerId, owner.id); assert.equal(selected.id, snapshot.id)
        throw new WorkspaceReviewError('workspace_review_github_forbidden')
      })
      for (const who of [f.who, f.viewer]) await assert.rejects(() => readTaskReviewSummary({ ...input(f, {}, who),
        deps: { ...deps, external: denied } }), code('workspace_review_github_forbidden'))
      assert.equal(verifies, 2)
    })

    await t.test('summary rendering rejects a different working source selected after the initial read', async () => {
      const f = await fixture(), first = (await localSnapshot(f)).snapshot
      const pending = await readTaskReviewSummary(input(f, {}))
      await writeFile(join(f.worktree, 'alpha.txt'), 'new current working source\n')
      const second = (await localSnapshot(f)).snapshot
      assert.equal(first.revision.headSha, second.revision.headSha); assert.notEqual(first.revision.version, second.revision.version)
      await assert.rejects(() => render<Summary>(pending, f.who), code('workspace_snapshot_outdated'))
      const fresh = await render<Summary>(await readTaskReviewSummary(input(f, {})), f.who)
      assert.deepEqual(fresh.reviewRef, reference(second))
    })

    await t.test('summary rendering rechecks the current owner Task run instead of returning a superseded thread', async () => {
      const f = await fixture(); await localSnapshot(f)
      const pending = await readTaskReviewSummary(input(f, {}))
      assert.equal(pending.context?.scope.identity.runId, f.runId)
      const newer = await extraRun(f, owner, 60)
      assert.notEqual(newer, f.runId)
      await assert.rejects(() => render<Summary>(pending, f.who), code('workspace_snapshot_outdated'))
    })

    await t.test('same HEAD with another working tree is another source version; mixed references are rejected', async () => {
      const f = await fixture(), first = await checkpoint(f)
      await writeFile(join(f.worktree, 'alpha.txt'), 'different alpha version\nstable\n')
      const second = await checkpoint(f)
      assert.equal(first.revision.headSha, second.revision.headSha)
      assert.notEqual(first.revision.version, second.revision.version)
      await assert.rejects(() => selectedTaskReview(deps, f.who, f.taskId,
        { snapshotId: first.id, sourceVersion: second.revision.version }), code('workspace_snapshot_outdated'))
      const original = await file(f, first)
      assert.match(original.file.patch ?? '', /\+after alpha\.txt/)
      assert.doesNotMatch(original.file.patch ?? '', /different alpha version/)
      assert.match((await file(f, second)).file.patch ?? '', /different alpha version/)
    })

    await t.test('opaque file pagination stays on its original snapshot and rejects changed references or board revisions', async () => {
      const f = await fixture(), first = await checkpoint(f), one = await page(f, { ...reference(first), limit: 1 })
      assert.ok(one.diff.nextCursor)
      await writeFile(join(f.worktree, 'alpha.txt'), 'newest alpha\n')
      const second = await checkpoint(f)
      const two = await page(f, { cursor: one.diff.nextCursor, limit: 1 })
      assert.deepEqual(two.diff.reviewRef, reference(first))
      assert.deepEqual(two.diff.files.map(value => value.path), ['beta.txt'])
      await assert.rejects(() => page(f, { ...reference(second), cursor: one.diff.nextCursor }), code('workspace_snapshot_outdated'))
      const forged = JSON.parse(Buffer.from(one.diff.nextCursor, 'base64url').toString('utf8')) as { reviewRef: TaskReviewRef; position: string }
      forged.reviewRef = reference(second)
      await assert.rejects(() => page(f, { cursor: Buffer.from(JSON.stringify(forged)).toString('base64url') }), code('workspace_snapshot_outdated'))
      await assert.rejects(() => page(f, { cursor: one.diff.nextCursor, commit: first.revision.headSha }), code('workspace_invalid_request'))
      await assert.rejects(() => page(f, { commit: first.revision.headSha }), code('workspace_invalid_request'))
      await assert.rejects(() => page(f, { cursor: 'invalid-cursor' }), code('workspace_invalid_request'))
      const scope = await resolveReviewScope(pool, pool, f.who, f.runId, f.repoId)
      await pool.query('UPDATE coding_workspace_review_boards SET revision=revision+1 WHERE id=$1', [scope.boardId])
      await assert.rejects(() => page(f, { cursor: one.diff.nextCursor }), code('workspace_review_conflict'))
    })

    await t.test('inline sent comments use accepted agent batches, excluding mutable board, drafts and GitHub delivery', async () => {
      const f = await fixture(), snapshot = await checkpoint(f), selectedAnchor = await anchor(f, snapshot)
      const sent = { id: randomUUID(), anchor: selectedAnchor, body: '冻结发送内容：keep both sides intact.' }
      await batch(f, snapshot, [sent], { at: '2026-11-08T10:00:00Z' })
      await batch(f, snapshot, [{ ...sent, body: 'Later delivery does not rewrite the first send.' }], { at: '2026-11-08T10:01:00Z' })
      await batch(f, snapshot, [{ id: randomUUID(), anchor: selectedAnchor, body: 'Prepared only' }], { state: 'prepared' })
      await batch(f, snapshot, [{ id: randomUUID(), anchor: selectedAnchor, body: 'Uncertain only' }], { state: 'uncertain' })
      await batch(f, snapshot, [{ id: randomUUID(), anchor: selectedAnchor, body: 'Native GitHub only' }], { destination: 'github' })
      const scope = await resolveReviewScope(pool, pool, f.who, f.runId, f.repoId)
      for (const [id, body, draft] of [[sent.id, 'Mutable body after send', false],
        [randomUUID(), 'Public board but never sent', false], [randomUUID(), 'Private draft', true]] as const)
        await pool.query('INSERT INTO coding_workspace_review_comments(id,"threadId","boardId","snapshotId","userId",anchor,body,draft) VALUES($1,$1,$2,$3,$4,$5,$6,$7)',
          [id, scope.boardId, snapshot.id, owner.id, selectedAnchor, body, draft])
      const value = await file(f, snapshot, 'alpha.txt', f.viewer)
      assert.equal(value.file.comments, 1); assert.equal(value.comments.length, 1)
      assert.deepEqual(value.comments[0], { id: sent.id, path: 'alpha.txt', line: 1, side: 'new', body: sent.body,
        author: owner.id, sentAt: '2026-11-08T10:00:00.000Z' })
      assert.equal((await page(f, reference(snapshot), f.viewer)).diff.files[0]!.comments, 1)
      await writeFile(join(f.worktree, 'alpha.txt'), 'another snapshot\n')
      const newer = await checkpoint(f)
      assert.deepEqual((await file(f, newer)).comments, [])
    })

    await t.test('sent-comment pagination is bounded, exact-source and exact-path with no missing or repeated records', async () => {
      const f = await fixture(), snapshot = await checkpoint(f), selectedAnchor = await anchor(f, snapshot)
      const comments = Array.from({ length: 101 }, (_, index) => ({ id: randomUUID(), anchor: selectedAnchor, body: 'Sent item ' + index }))
      for (let position = 0; position < comments.length; position += 40) await batch(f, snapshot, comments.slice(position, position + 40))
      const first = await file(f, snapshot)
      assert.equal(first.comments.length, 100); assert.equal(first.file.comments, 101); assert.ok(first.nextCommentsCursor)
      const last = await file(f, snapshot, 'alpha.txt', f.who, first.nextCommentsCursor)
      assert.equal(last.comments.length, 1); assert.equal(last.nextCommentsCursor, undefined)
      assert.deepEqual(new Set([...first.comments, ...last.comments].map(value => value.id)), new Set(comments.map(value => value.id)))
      await assert.rejects(() => file(f, snapshot, 'beta.txt', f.who, first.nextCommentsCursor), code('workspace_snapshot_outdated'))
      await writeFile(join(f.worktree, 'alpha.txt'), 'another comment source\n')
      const newer = await checkpoint(f)
      await assert.rejects(() => file(f, newer, 'alpha.txt', f.who, first.nextCommentsCursor), code('workspace_snapshot_outdated'))
    })

    await t.test('lazy manifest zeroes remain unknown counts rather than a fabricated empty diff', async () => {
      const f = await fixture(); await checkpoint(f)
      const request = { kind: 'diff_snapshot' as const, source: 'working' as const }
      const command: WorkspaceReadCommand = { id: randomUUID(), identity: f.identity, request,
        expiresAt: new Date(Date.now() + 15_000).toISOString() }
      const mask = await secretMaskerFor({ workspaceId: f.where.id, ownerId: owner.id })
      const receipt = workspaceReadReceipt.parse(await readWorkspaceDiffReceipt(command, f.entry, f.repository))
      const result = validateDiffReceipt(request, receipt, mask)
      assert.ok(result?.ok && result.kind === 'diff_snapshot')
      const snapshot = await withReviewTransaction(pool, pool, f.who, f.runId, f.repoId,
        (tx, scope) => retainDiffSnapshot(tx, scope, { revision: result.revision, files: result.files }, mask), { live: f.identity })
      const value = await page(f, reference(snapshot))
      assert.equal(value.summary.files, 3); assert.equal(value.summary.countsKnown, false)
      assert.equal(value.summary.additions, null); assert.equal(value.summary.deletions, null)
      assert.equal(value.diff.availability, 'available'); assert.equal(value.diff.empty, false)
      for (const entry of value.diff.files) {
        assert.equal(entry.additions, null); assert.equal(entry.deletions, null)
        assert.equal(entry.countsKnown, false); assert.equal(entry.format, 'unloaded')
      }
    })

    await t.test('membership revocation between source read and rendering prevents returning retained content', async () => {
      const f = await fixture(), snapshot = await checkpoint(f)
      const pending = await readTaskReviewFile(input(f, { ...reference(snapshot), path: 'alpha.txt' }, f.viewer))
      assert.ok(pending.context)
      await pool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [f.where.id, member.id])
      await assert.rejects(() => render<File>(pending, f.viewer), code('workspace_not_found'))
    })
  } finally {
    mock.restoreAll()
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
    await dropTestDatabase(admin, database, pool, appPool, workspacePool)
    await admin.end()
    await rm(directory, { recursive: true, force: true })
  }
})
