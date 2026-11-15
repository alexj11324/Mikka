import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Pool } from 'pg'
import { and, inArray } from 'drizzle-orm'
import { runAssignmentSchema } from '@mikka/protocol'
import { remoteKey } from '@mikka/protocol/repository'
import { workspaceReadReceipt, type WorkspaceReadCommand } from '@mikka/protocol/coding-workspace'
import { checkpointReviewEvidence, type DiffSnapshot } from '@mikka/protocol/coding-workspace-review'
import { takeCheckpoint } from '../../../packages/daemon/src/agents/checkpoint'
import { readWorkspaceDiffReceipt } from '../../../packages/daemon/src/coding-workspace/diff'
import type { JournalEntry } from '../../../packages/daemon/src/runs/journal'
import { orderMigrations } from '../../../scripts/migration-order.mjs'
import { disposableDatabase, E2E_DB_RULE } from '../../../tests/helpers/e2e-target.mjs'
import { createTestDatabase, dropTestDatabase } from '../../../tests/support/drop-test-database'
import type { ReviewActor } from '../diff/authority'

const url = process.env.E2E_DATABASE_URL
if (url) assert.ok(disposableDatabase(process.env, url), E2E_DB_RULE)
else if (process.env.REQUIRE_DB === '1') assert.fail('REQUIRE_DB=1 needs an isolated E2E_DATABASE_URL')
const execute = promisify(execFile)
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const remote = 'https://github.com/mikka-fixtures/task-review-summaries.git'
const reference = (snapshot: DiffSnapshot) => ({ snapshotId: snapshot.id, sourceVersion: snapshot.revision.version })

/** The bulk reader, both databases, Git evidence and masking are real. Only
 * Next's request context is supplied; no query, provider or daemon is mocked. */
test('Task review summaries preserve current source and tenant boundaries on PostgreSQL 17',
  { skip: !url, timeout: 240_000 }, async t => {
  const admin = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000 })
  const database = 'task_review_summaries_' + randomUUID().replaceAll('-', '') + '_e2e'
  const version = Number((await admin.query('SHOW server_version_num')).rows[0].server_version_num)
  assert.ok(version >= 170000 && version < 180000, 'Task review summaries require PostgreSQL 17')
  await createTestDatabase(admin, database, 'template0')
  const target = new URL(url!); target.pathname = '/' + database
  const pool = new Pool({ connectionString: target.toString(), max: 8, connectionTimeoutMillis: 5000 })
  const directory = await mkdtemp(join(tmpdir(), 'mikka-task-summary-db-'))
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
    const { taskReviewSummaries } = await import('./summaries')
    const { taskReviewSourceHint } = await import('./summary-selection')
    const { issueVisibility } = await import('../../issue-visibility')
    const { issues } = await import('../../db/schema')
    const { resolveRunWorktree } = await import('../identity')
    const { resolveReviewScope, withReviewTransaction } = await import('../diff/authority')
    const { prepareCheckpointReview, retainCheckpointReview } = await import('../diff/checkpoint')
    const { latestDiffSnapshot, readDiffSnapshot, retainDiffSnapshot } = await import('../diff/store')
    const { validateDiffReceipt } = await import('../diff/receipt')
    const { secretMaskerFor } = await import('../../secrets/runtime')
    const { tokenWorkspace } = await import('../../tokens/principal')
    const { actingContext } = await import('../../activity-actor')
    const storage = await import('../../db'), db = storage.db
    appPool = storage.pool; workspacePool = (await import('../../workspace-db')).workspacePool
    const git = async (cwd: string, ...args: string[]) => (await execute('git', ['-C', cwd,
      '-c', 'user.name=Task summary fixture', '-c', 'user.email=task-summary@example.invalid',
      '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args])).stdout.trim()
    async function user() {
      const id = 'task-summary-' + randomUUID(), sessionId = randomUUID()
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
      await pool.query('INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,$2,\'Task summary fixture\')', [id, owner.id])
      for (const who of [owner, member])
        await pool.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$3,$4,\'active\')',
          [id, who.id, who.id + '@example.invalid', who === owner ? 'admin' : 'member'])
      await pool.query('INSERT INTO mikka_teams(id,"workspaceId","userId",name,identifier) VALUES($1,$2,$3,\'Task summary fixture\',$4)',
        [teamId, id, owner.id, 'T' + randomUUID().replaceAll('-', '').slice(0, 7).toUpperCase()])
      await pool.query('INSERT INTO mikka_team_members("teamId","userId",role) VALUES($1,$2,\'owner\')', [teamId, owner.id])
      return { id, teamId }
    }
    type Workspace = Awaited<ReturnType<typeof workspace>>
    const actor = (who: User, workspaceId: string): ReviewActor => ({ userId: who.id, workspaceId,
      credential: { kind: 'session', id: who.sessionId } })
    async function task(where: Workspace) {
      const id = randomUUID()
      await pool.query('INSERT INTO issues(id,"userId","workspaceId",title,content,status,priority,scope) VALUES($1,$2,$3,\'Task summary fixture\',\'{"type":"doc","content":[]}\',\'doing\',\'normal\',\'workspace\')',
        [id, owner.id, where.id])
      await pool.query('INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId") VALUES($1,$2,$3,$4)',
        [id, where.teamId, where.id, owner.id])
      return id
    }
    async function fixture(where?: Workspace) {
      where ??= await workspace()
      const runId = randomUUID(), repoId = randomUUID(), taskId = await task(where),
        deviceId = randomUUID(), tokenId = randomUUID(), agentId = randomUUID()
      const repository = join(directory, runId, 'repository'), worktree = join(directory, runId, 'checkout')
      await mkdir(repository, { recursive: true })
      await git(repository, 'init', '--initial-branch=main')
      await git(repository, 'config', 'core.autocrlf', 'false')
      await git(repository, 'remote', 'add', 'origin', remote)
      for (const path of ['alpha.txt', 'beta.txt']) await writeFile(join(repository, path), 'before ' + path + '\nstable\n')
      await git(repository, 'add', '--all'); await git(repository, 'commit', '-qm', 'summary base')
      await git(repository, 'worktree', 'add', '-q', '--detach', worktree, 'HEAD')
      const baseSha = await git(worktree, 'rev-parse', 'HEAD')
      await pool.query('INSERT INTO devices(id,"ownerId",name,kind) VALUES($1,$2,\'Task summary fixture\',\'local\')', [deviceId, owner.id])
      await pool.query('INSERT INTO agents(id,"userId",name,harness,"deviceId") VALUES($1,$2,$3,\'codex\',$4)',
        [agentId, owner.id, 'Task summary ' + runId, deviceId])
      await pool.query('INSERT INTO device_repos(id,"userId","deviceId","repoPath","remoteUrl") VALUES($1,$2,$3,$4,$5)',
        [repoId, owner.id, deviceId, remoteKey(remote), remote])
      await pool.query('INSERT INTO device_tokens(id,"userId","tokenHash","expiresAt") VALUES($1,$2,$3,now()+interval \'1 hour\')',
        [tokenId, owner.id, hash(randomUUID())])
      await pool.query('INSERT INTO agent_runs(id,"userId","issueId","agentId","deviceId","deviceRepoId","deviceTokenId",status,"worktreePath","leaseExpiresAt","agentDefinition") ' +
        'VALUES($1,$2,$3,$4,$5,$6,$7,\'running\',$8,now()+interval \'10 minutes\',$9)',
      [runId, owner.id, taskId, agentId, deviceId, repoId, tokenId, worktree,
        { executionIdentity: { workspaceId: where.id }, repositoryAdmission: { workspaceId: where.id, remoteKey: remoteKey(remote) } }])
      const who = actor(owner, where.id)
      const identity = (await resolveRunWorktree(pool, pool, who, runId, repoId)).identity
      const entry: JournalEntry = { assignment: runAssignmentSchema.parse({ runId, issueId: taskId, repoId, deviceId,
        remoteUrl: remote, baseBranch: 'main', harness: 'codex', prompt: 'Read this task.', kind: 'implement' }),
      state: 'running', sessionId: null, worktree, baseCommit: baseSha, lastSeq: 0, error: null, updatedAt: new Date().toISOString() }
      for (const path of ['alpha.txt', 'beta.txt']) await writeFile(join(worktree, path), 'after ' + path + '\nstable\n')
      return { where, taskId, runId, repoId, deviceId, tokenId, agentId, repository, worktree, baseSha, who, identity, entry }
    }
    type Fixture = Awaited<ReturnType<typeof fixture>>
    async function checkpoint(f: Fixture) {
      const captured = await takeCheckpoint({ repoPath: f.repository, worktree: f.worktree, baseCommit: f.baseSha, repoId: f.repoId })
      assert.ok(captured)
      const proof = checkpointReviewEvidence.parse(captured.checkpoint.review)
      assert.equal(proof.reason, null); assert.ok(proof.blobs.length > 0)
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
    async function working(f: Fixture) {
      const request = { kind: 'diff_snapshot' as const, source: 'working' as const }
      const command: WorkspaceReadCommand = { id: randomUUID(), identity: f.identity, request,
        expiresAt: new Date(Date.now() + 15_000).toISOString() }
      const mask = await secretMaskerFor({ workspaceId: f.where.id, ownerId: owner.id })
      const receipt = workspaceReadReceipt.parse(await readWorkspaceDiffReceipt(command, f.entry, f.repository))
      const result = validateDiffReceipt(request, receipt, mask)
      assert.ok(result?.ok && result.kind === 'diff_snapshot')
      return withReviewTransaction(pool, pool, f.who, f.runId, f.repoId,
        (tx, scope) => retainDiffSnapshot(tx, scope, { revision: result.revision, files: result.files }, mask), { live: f.identity })
    }
    async function extraRun(f: Pick<Fixture, 'where' | 'taskId'>, who: User, seconds: number, kind = 'implement') {
      const id = randomUUID(), agentId = randomUUID()
      await pool.query('INSERT INTO agents(id,"userId",name,harness) VALUES($1,$2,$3,\'codex\')', [agentId, who.id, 'Other summary thread ' + id])
      await pool.query('INSERT INTO agent_runs(id,"userId","issueId","agentId",kind,status,"createdAt","agentDefinition") ' +
        'VALUES($1,$2,$3,$4,$5,\'stopped\',clock_timestamp()+$6*interval \'1 second\',$7)',
      [id, who.id, f.taskId, agentId, kind, seconds, { executionIdentity: { workspaceId: f.where.id } }])
      return id
    }
    async function factoryCheck(f: Fixture, stage: 'review' | 'verify' | 'monitor', seconds: number) {
      const runId = await extraRun(f, owner, seconds), taskId = randomUUID(), attemptId = randomUUID(), sourceEventId = randomUUID()
      const tx = await pool.connect()
      try {
        await tx.query('BEGIN')
        await tx.query('INSERT INTO coordinator_events(id,"userId","issueId",kind,"dedupeKey",payload) VALUES($1::uuid,$2,$3,\'user_message\',$1::text,\'{"text":"Summary fixture"}\')',
          [sourceEventId, owner.id, f.taskId])
        await tx.query('INSERT INTO factory_tasks(id,"userId","issueId","sourceEventId",route,stage,status,revision,"attemptId",reason) ' +
          'VALUES($1,$2,$3,$4,$5,$6,\'running\',1,$7,\'Summary check fixture\')',
        [taskId, owner.id, f.taskId, sourceEventId, { issueId: f.taskId, sourceEventId, eventId: randomUUID(), rationale: 'Fixture' }, stage, attemptId])
        await tx.query('INSERT INTO factory_attempts(id,"taskId",stage,ordinal,position,status,"runId",reason,output) ' +
          'VALUES($1,$2,$3,1,1,\'running\',$4,\'Summary check fixture\',$5)', [attemptId, taskId, stage, runId, { requestEpoch: sourceEventId }])
        await tx.query('COMMIT')
      } catch (error) { await tx.query('ROLLBACK'); throw error } finally { tx.release() }
      return runId
    }
    const read = (f: Fixture, userId = owner.id, workspaceId = f.where.id) => taskReviewSummaries(userId, [f.taskId], workspaceId)
    async function sourceHints(ids: string[], userId = owner.id) {
      const visibility = await issueVisibility(userId, false, undefined, db, { onlyIssueIds: ids, withIdentifierTeams: true })
      const rows = await db.select({ id: issues.id, codingReview: taskReviewSourceHint }).from(issues)
        .where(and(inArray(issues.id, ids), visibility.predicate))
      return new Map(rows.map(row => [row.id, row.codingReview]))
    }

    await t.test('one bulk read returns each same-owner Task with its own immutable reference and shared viewer permissions', async () => {
      const where = await workspace(), fixtures: Fixture[] = [], snapshots: DiffSnapshot[] = []
      for (let index = 0; index < 3; index++) {
        const f = await fixture(where); fixtures.push(f); snapshots.push(await checkpoint(f)); await stop(f)
      }
      const ids = fixtures.map(f => f.taskId), own = await taskReviewSummaries(owner.id, [...ids, ids[0]!, 'invalid'], where.id)
      const shared = await taskReviewSummaries(member.id, ids, where.id)
      assert.equal(own.size, 3); assert.equal(shared.size, 3)
      for (const [index, f] of fixtures.entries()) {
        const value = own.get(f.taskId); assert.ok(value)
        assert.deepEqual(value.reviewRef, reference(snapshots[index]!)); assert.equal(value.taskId, f.taskId)
        assert.equal(value.files, 2); assert.equal(value.additions, 2); assert.equal(value.deletions, 2)
        assert.equal(value.countsKnown, true); assert.equal(value.checks, null); assert.equal(value.running, false)
        assert.equal(value.permissions.canSend, true)
        assert.deepEqual(shared.get(f.taskId)?.reviewRef, value.reviewRef)
        assert.equal(shared.get(f.taskId)?.permissions.canSend, false); assert.equal(shared.get(f.taskId)?.permissions.canTerminal, false)
      }
      const serialized = JSON.stringify([...own.values()])
      for (const field of ['base64', 'blobs', 'patch', 'repositoryKey', 'tokenHash', 'worktreePath'])
        assert.ok(!serialized.includes('"' + field + '"'), 'summary never returns private field ' + field)
      assert.ok(!serialized.includes('after alpha.txt'))
    })

    await t.test('current source follows the persisted Task owner and excludes newer viewer, group and Factory check Runs', async () => {
      const f = await fixture(), snapshot = await checkpoint(f); await stop(f)
      await extraRun(f, member, 10)
      await extraRun(f, owner, 20, 'group_chat')
      for (const [index, stage] of (['review', 'verify', 'monitor'] as const).entries()) await factoryCheck(f, stage, 30 + index)
      for (const userId of [owner.id, member.id]) assert.deepEqual((await read(f, userId)).get(f.taskId)?.reviewRef, reference(snapshot))
    })

    await t.test('private source hints keep an old Task-owner repository visible through shared mobile and citation reads', async () => {
      const f = await fixture(), snapshot = await checkpoint(f); await stop(f)
      await pool.query('UPDATE agent_runs SET "createdAt"=now()-interval \'45 days\' WHERE id=$1', [f.runId])
      const viewerRunId = await extraRun(f, member, 0)
      const plainTaskId = await task(f.where)
      await extraRun({ where: f.where, taskId: plainTaskId }, owner, 0)
      const hints = await sourceHints([f.taskId, plainTaskId], member.id)
      assert.equal(hints.get(f.taskId), true, 'the owner repository is older than the viewer list window')
      assert.equal(hints.get(plainTaskId), false, 'another Task repository cannot satisfy the correlated SELECT')

      const { newestTaskRuns } = await import('../../task-block-runs')
      const decorations = await newestTaskRuns(member.id, [f.taskId, plainTaskId], f.where.id)
      const selected = decorations.find(row => row.issueId === f.taskId)
      assert.equal(selected?.runId, viewerRunId, 'the existing list decoration still follows its own viewer window')
      assert.equal(selected?.codingReview, true, 'the independent Task-owner hint does not follow the viewer Run')
      assert.equal(decorations.find(row => row.issueId === plainTaskId)?.codingReview, false)

      const { mobileTask } = await import('../../mobile-tasks')
      const detail = await mobileTask({ id: member.id }, f.taskId, f.where.id)
      assert.ok(detail)
      assert.deepEqual(detail.task.review?.reviewRef, reference(snapshot))
      assert.doesNotMatch(JSON.stringify(detail), /"codingReview"|"repositoryKey"|"worktreePath"/)

      const { citationSources } = await import('../../coordinator/store')
      const direct = await citationSources(member.id, [`[[issue:${f.taskId}]]`, `[[issue:${plainTaskId}]]`])
      const coding = direct[f.taskId], plain = direct[plainTaskId]
      assert.ok(coding?.kind === 'issue' && plain?.kind === 'issue')
      assert.deepEqual(coding.review?.reviewRef, reference(snapshot))
      assert.equal(Object.hasOwn(plain, 'review'), false, 'noncoding citations keep their prior public shape')
      const runOnly = await citationSources(member.id, [`[[run:${f.runId}]]`])
      assert.deepEqual(Object.keys(runOnly), [f.runId], 'a run-only citation does not add a direct Task source')
      const run = runOnly[f.runId]; assert.ok(run?.kind === 'run')
      assert.deepEqual(run.issue?.review?.reviewRef, reference(snapshot))
      assert.doesNotMatch(JSON.stringify([direct, runOnly]), /"codingReview"|"ownerId"|"repositoryKey"|"worktreePath"/)
    })

    await t.test('a first coding Run without retained binding or snapshot still exposes an honest empty summary entry', async () => {
      const f = await fixture()
      const retained = async () => (await pool.query('SELECT (SELECT count(*)::int FROM coding_workspace_bindings WHERE "runId"=$1) AS bindings,' +
        '(SELECT count(*)::int FROM coding_workspace_snapshots WHERE "runId"=$1) AS snapshots', [f.runId])).rows[0]
      assert.deepEqual(await retained(), { bindings: 0, snapshots: 0 })
      assert.equal((await sourceHints([f.taskId])).get(f.taskId), true, 'an unretained first repository Run remains a candidate')
      const value = (await read(f)).get(f.taskId); assert.ok(value)
      assert.equal(value.taskId, f.taskId); assert.equal(value.reviewRef, null); assert.equal(value.running, true)
      assert.equal(value.files, null); assert.equal(value.additions, null); assert.equal(value.deletions, null)
      assert.equal(value.countsKnown, false); assert.equal(value.checks, null)
      assert.equal(value.permissions.canSend, false); assert.equal(value.permissions.canTerminal, true)
      assert.deepEqual(await retained(), { bindings: 0, snapshots: 0 }, 'card reads never create source evidence')
    })

    await t.test('lazy working manifests keep unknown additions, deletions and checks null', async () => {
      const f = await fixture(), snapshot = await working(f)
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM coding_workspace_snapshot_files WHERE "snapshotId"=$1 AND patch IS NULL',
        [snapshot.id])).rows[0].n, 2)
      const value = (await read(f)).get(f.taskId); assert.ok(value)
      assert.deepEqual(value.reviewRef, reference(snapshot)); assert.equal(value.files, 2)
      assert.equal(value.countsKnown, false); assert.equal(value.additions, null); assert.equal(value.deletions, null)
      assert.equal(value.checks, null); assert.equal(value.running, true)
    })

    await t.test('retained checkpoint summaries survive physical device and repository cleanup', async () => {
      const f = await fixture(), snapshot = await checkpoint(f); await stop(f)
      await pool.query('DELETE FROM devices WHERE id=$1', [f.deviceId])
      assert.equal((await pool.query('SELECT 1 FROM device_repos WHERE id=$1', [f.repoId])).rowCount, 0)
      const run = (await pool.query('SELECT "deviceId","deviceRepoId" FROM agent_runs WHERE id=$1', [f.runId])).rows[0]
      assert.deepEqual(run, { deviceId: null, deviceRepoId: null })
      for (const userId of [owner.id, member.id]) {
        assert.equal((await sourceHints([f.taskId], userId)).get(f.taskId), true, 'retained binding survives device/repository removal')
        const value = (await read(f, userId)).get(f.taskId); assert.ok(value)
        assert.deepEqual(value.reviewRef, reference(snapshot)); assert.equal(value.files, 2); assert.equal(value.running, false)
      }
    })

    await t.test('foreign workspace, suspended member, outsider and removed Team link disclose no summary', async () => {
      const f = await fixture(); await checkpoint(f); await stop(f)
      const elsewhere = await workspace()
      assert.equal((await read(f, member.id)).size, 1)
      assert.equal((await read(f, owner.id, elsewhere.id)).size, 0)
      assert.equal((await read(f, outsider.id)).size, 0)
      await pool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [f.where.id, member.id])
      assert.equal((await read(f, member.id)).size, 0)
      await pool.query('DELETE FROM mikka_team_issues WHERE "issueId"=$1', [f.taskId])
      assert.equal((await read(f)).size, 0)
      assert.equal((await taskReviewSummaries(owner.id, [f.taskId])).size, 0, 'owner fallback cannot revive an unlinked Team Task')
    })

    await t.test('moving a Task between workspaces cannot move its frozen summary authority', async () => {
      const f = await fixture(); await checkpoint(f); await stop(f)
      const elsewhere = await workspace()
      await pool.query('DELETE FROM mikka_team_issues WHERE "issueId"=$1', [f.taskId])
      await pool.query('INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId") VALUES($1,$2,$3,$4)',
        [f.taskId, elsewhere.teamId, elsewhere.id, owner.id])
      for (const userId of [owner.id, member.id]) {
        assert.equal((await read(f, userId)).size, 0)
        assert.equal((await read(f, userId, elsewhere.id)).size, 0)
        assert.equal((await taskReviewSummaries(userId, [f.taskId])).size, 0)
      }
    })

    await t.test('explicit and ambient PAT workspace pins override a caller-selected workspace', async () => {
      const a = await fixture(), b = await fixture()
      const snapshot = await checkpoint(a); await checkpoint(b); await stop(a); await stop(b)
      const ids = [a.taskId, b.taskId]
      const explicit = await taskReviewSummaries({ id: owner.id, [tokenWorkspace]: a.where.id }, ids, b.where.id)
      const ambient = await actingContext.run({ userId: owner.id, tokenWorkspaceId: a.where.id },
        () => taskReviewSummaries(owner.id, ids, b.where.id))
      for (const result of [explicit, ambient]) {
        assert.equal(result.size, 1); assert.deepEqual(result.get(a.taskId)?.reviewRef, reference(snapshot)); assert.equal(result.has(b.taskId), false)
        assert.equal(result.get(a.taskId)?.permissions.canSend, false); assert.equal(result.get(a.taskId)?.permissions.canTerminal, false)
      }
      const unrelatedActor = await actingContext.run({ userId: outsider.id, tokenWorkspaceId: b.where.id },
        () => taskReviewSummaries(owner.id, ids, a.where.id))
      assert.equal(unrelatedActor.size, 1); assert.equal(unrelatedActor.has(a.taskId), true)
      assert.equal(unrelatedActor.get(a.taskId)?.permissions.canTerminal, true, 'another identity cannot attach its ambient PAT scope')
      const { citationSources } = await import('../../coordinator/store')
      const citations = await actingContext.run({ userId: owner.id, tokenWorkspaceId: a.where.id }, () => citationSources(owner.id,
        [`[[issue:${a.taskId}]]`, `[[issue:${b.taskId}]]`, `[[run:${b.runId}]]`]))
      assert.deepEqual(Object.keys(citations), [a.taskId], 'the combined direct/run Task read retains the ambient PAT workspace pin')
      assert.doesNotMatch(JSON.stringify(citations), /"codingReview"/)
    })

    await t.test('no Run, noncoding current Run and group-only Tasks have no Review entry or old-source fallback', async () => {
      const where = await workspace(), noRun = await task(where), plain = await task(where), groupOnly = await task(where)
      await extraRun({ where, taskId: plain }, owner, 0)
      await extraRun({ where, taskId: groupOnly }, owner, 0, 'group_chat')
      const previous = await fixture(where); await checkpoint(previous); await stop(previous)
      await extraRun(previous, owner, 10)
      const hints = await sourceHints([noRun, plain, groupOnly, previous.taskId])
      for (const id of [noRun, plain, groupOnly]) assert.equal(hints.get(id), false)
      assert.equal(hints.get(previous.taskId), true, 'the conservative prefilter is not current-source authority')
      const result = await taskReviewSummaries(owner.id, [noRun, plain, groupOnly, previous.taskId], where.id)
      assert.equal(result.size, 0)
      for (const id of [noRun, plain, groupOnly, previous.taskId]) assert.equal(result.get(id) ?? null, null)
    })

    await t.test('the latest unusable checkpoint never falls back to an older complete checkpoint summary', async () => {
      const f = await fixture(), good = await checkpoint(f)
      await writeFile(join(f.worktree, 'alpha.txt'), 'new checkpoint without review evidence\n')
      const captured = await takeCheckpoint({ repoPath: f.repository, worktree: f.worktree, baseCommit: f.baseSha, repoId: f.repoId })
      assert.ok(captured)
      const mask = await secretMaskerFor({ workspaceId: f.where.id, ownerId: owner.id })
      const unavailable = prepareCheckpointReview({ ...captured.checkpoint, review: undefined }, f.repoId, mask)
      assert.equal(unavailable.reason, 'missing_evidence')
      await withReviewTransaction(pool, pool, f.who, f.runId, f.repoId,
        (tx, scope) => retainCheckpointReview(tx, scope, unavailable, new Date(captured.checkpoint.takenAt), mask), { live: f.identity })
      await stop(f)
      assert.deepEqual((await pool.query('SELECT "snapshotId",reason FROM coding_workspace_checkpoint_reviews WHERE "runId"=$1', [f.runId])).rows,
        [{ snapshotId: null, reason: 'missing_evidence' }])
      const scope = await resolveReviewScope(pool, pool, f.who, f.runId, f.repoId)
      assert.equal((await latestDiffSnapshot(pool, scope, 'checkpoint'))?.id, good.id, 'the old valid snapshot remains retained')
      for (const userId of [owner.id, member.id]) {
        const value = (await read(f, userId)).get(f.taskId); assert.ok(value)
        assert.equal(value.reviewRef, null); assert.equal(value.files, null); assert.equal(value.countsKnown, false)
        assert.equal(value.additions, null); assert.equal(value.deletions, null); assert.equal(value.checks, null)
        assert.equal(value.permissions.canSend, false)
      }
    })
  } finally {
    mock.restoreAll()
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
    await dropTestDatabase(admin, database, pool, appPool, workspacePool)
    await admin.end()
    await rm(directory, { recursive: true, force: true })
  }
})
