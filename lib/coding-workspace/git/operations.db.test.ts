import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Pool } from 'pg'
import { runAssignmentSchema } from '@mikka/protocol'
import { remoteKey } from '@mikka/protocol/repository'
import { CodingWorkspaceError, type RunWorktreeIdentity, type WorkspaceReadCommand } from '@mikka/protocol/coding-workspace'
import { WorkspaceGitError } from '@mikka/protocol/coding-workspace-git'
import { handleWorkspaceGitRequest } from '../../../packages/daemon/src/coding-workspace/git'
import { readWorkspaceDiffReceipt } from '../../../packages/daemon/src/coding-workspace/diff'
import { takeCheckpoint } from '../../../packages/daemon/src/agents/checkpoint'
import type { JournalEntry } from '../../../packages/daemon/src/runs/journal'
import { orderMigrations } from '../../../scripts/migration-order.mjs'
import { disposableDatabase, E2E_DB_RULE } from '../../../tests/helpers/e2e-target.mjs'
import { dropTestDatabase } from '../../../tests/support/drop-test-database'
import type { ReviewActor } from '../diff/authority'

const url = process.env.E2E_DATABASE_URL
if (url) assert.ok(disposableDatabase(process.env, url), E2E_DB_RULE)
else if (process.env.REQUIRE_DB === '1') assert.fail('REQUIRE_DB=1 needs an isolated E2E_DATABASE_URL')
const execute = promisify(execFile)
const git = async (cwd: string, ...args: string[]) => (await execute('git', args, { cwd, encoding: 'utf8' })).stdout.trim()
const remote = 'https://github.com/mikka-fixtures/git-history.git', repositoryKey = remoteKey(remote)
const code = (expected: string) => (error: unknown) =>
  (error instanceof CodingWorkspaceError || error instanceof WorkspaceGitError) && error.code === expected

/** Real PostgreSQL 17, real Git worktrees and the complete daemon write path.
 * Only the device gateway wake is replaced; authority, receipts, CAS and the
 * filesystem writer stay real. */
test('Git status, history, safe revert, Undo and checkpoint restore on PostgreSQL 17', { skip: !url, timeout: 300_000 }, async t => {
  const admin = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000 })
  const database = `coding_workspace_git_${randomUUID().replaceAll('-', '')}_e2e`
  const version = Number((await admin.query('SHOW server_version_num')).rows[0].server_version_num)
  assert.ok(version >= 170000 && version < 180000, 'Git history acceptance requires PostgreSQL 17')
  await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`)
  const target = new URL(url!); target.pathname = `/${database}`
  const pool = new Pool({ connectionString: target.toString(), max: 16, connectionTimeoutMillis: 5000 })
  const root = await mkdtemp(join(tmpdir(), 'mikka-git-history-db-'))
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
      get: () => undefined, getAll: () => [], has: () => false, set() {}, delete() {} }) } })
    mock.module('next-intl/server', { namedExports: { getLocale: async () => 'en',
      getTranslations: async () => Object.assign((key: string) => key, { has: () => true }) } })
    const gateway = await import('../../device-gateway-notify')
    mock.module('../../device-gateway-notify', { namedExports: { ...gateway, wakeDeviceWorkNow: async () => {} } })
    const { resolveRunWorktree } = await import('../identity')
    const { pendingWorkspaceReads, finishWorkspaceRead } = await import('../requests')
    const { subscribeShared, DEVICE_WORK_CHANNEL } = await import('../../db/listen')
    const { captureDiffSnapshot, diffFile } = await import('../diff/service')
    const { getRunGitStatus, listRunGitHistory, listRunCheckpoints } = await import('./service')
    const { previewRevert, applyRevert, undoLastOperation } = await import('./revert')
    const { previewCheckpointRestore, restoreCheckpoint } = await import('./restore')
    appPool = (await import('../../db')).pool; workspacePool = (await import('../../workspace-db')).workspacePool
    const owner = `git-owner-${randomUUID()}`, member = `git-member-${randomUUID()}`, stranger = `git-stranger-${randomUUID()}`
    for (const user of [owner, member, stranger]) await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())',
      [user, `${user}@example.invalid`])
    const workspaceId = randomUUID(), otherWorkspace = randomUUID()
    for (const id of [workspaceId, otherWorkspace]) {
      await pool.query('INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,$2,\'Git history fixture\')', [id, owner])
      for (const user of [owner, member]) await pool.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$3,\'member\',\'active\')',
        [id, user, `${user}@example.invalid`])
    }
    async function session(userId: string) {
      const id = randomUUID()
      await pool.query('INSERT INTO "session"(id,token,"userId","expiresAt","createdAt","updatedAt") VALUES($1,$2,$3,now()+interval \'1 hour\',now(),now())',
        [id, randomUUID(), userId])
      return id
    }
    const ownerSession = await session(owner), memberSession = await session(member), strangerSession = await session(stranger)
    const actor = (userId = owner, sessionId = ownerSession, scope = workspaceId): ReviewActor =>
      ({ userId, workspaceId: scope, credential: { kind: 'session', id: sessionId } })
    const dependencies = { database: pool, membership: pool }

    async function fixture() {
      const runId = randomUUID(), repoId = randomUUID(), deviceId = randomUUID(), tokenId = randomUUID(), agentId = randomUUID()
      const repository = join(root, runId, 'repository'), worktree = join(root, runId, 'checkout')
      await mkdir(repository, { recursive: true })
      await mkdir(join(repository, 'src'), { recursive: true })
      await git(repository, 'init', '--initial-branch=main')
      await git(repository, 'config', 'core.autocrlf', 'false')
      await git(repository, 'remote', 'add', 'origin', remote)
      await writeFile(join(repository, 'src/example.ts'), 'export const answer = 42\n')
      await writeFile(join(repository, 'README.md'), '# Fixture\n')
      await git(repository, 'add', '--all')
      await git(repository, '-c', 'user.name=Mikka fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture base')
      await git(repository, 'worktree', 'add', '-q', '--detach', worktree, 'HEAD')
      const headSha = await git(worktree, 'rev-parse', 'HEAD')
      await pool.query('INSERT INTO devices(id,"ownerId",name,kind) VALUES($1,$2,\'Git fixture\',\'local\')', [deviceId, owner])
      await pool.query('INSERT INTO agents(id,"userId",name,harness,"deviceId") VALUES($1,$2,$3,\'codex\',$4)', [agentId, owner, `Fixture ${runId}`, deviceId])
      await pool.query('INSERT INTO device_repos(id,"userId","deviceId","repoPath","remoteUrl") VALUES($1,$2,$3,$4,$5)', [repoId, owner, deviceId, repositoryKey, remote])
      await pool.query('INSERT INTO device_tokens(id,"userId","tokenHash","boundDeviceId","boundWorkspaceId","expiresAt") VALUES($1,$2,$3,$4,$5,now()+interval \'1 hour\')',
        [tokenId, owner, randomUUID(), deviceId, workspaceId])
      const definition = { executionIdentity: { workspaceId }, repositoryAdmission: { workspaceId, remoteKey: repositoryKey } }
      await pool.query(`INSERT INTO agent_runs(id,"userId","agentId","deviceId","deviceRepoId","deviceTokenId",status,"worktreePath","leaseExpiresAt","agentDefinition")
        VALUES($1,$2,$3,$4,$5,$6,'running',$7,now()+interval '10 minutes',$8)`, [runId, owner, agentId, deviceId, repoId, tokenId, worktree, definition])
      const entry: JournalEntry = { assignment: runAssignmentSchema.parse({ runId, issueId: randomUUID(), repoId, deviceId,
        remoteUrl: remote, baseBranch: 'main', harness: 'codex', prompt: 'Git fixture', kind: 'implement',
        leaseExpiresAt: new Date(Date.now() + 600_000).toISOString() }), state: 'running', sessionId: null,
        worktree, baseCommit: headSha, lastSeq: 0, error: null, updatedAt: new Date().toISOString() }
      const write = (path: string, text: string) => writeFile(join(worktree, path), text)
      return { runId, repoId, deviceId, tokenId, worktree, repository, entry, headSha, write,
        caller: { userId: owner, tokenId } }
    }
    type Fixture = Awaited<ReturnType<typeof fixture>>
    async function exchange<T>(f: Fixture, start: (signal: AbortSignal) => Promise<T>, settleMs = 400): Promise<T> {
      const subscription = await subscribeShared(pool, DEVICE_WORK_CHANNEL, [f.deviceId])
      assert.ok(subscription, 'a real PostgreSQL LISTEN session is required')
      const controller = new AbortController()
      const outcome = start(controller.signal).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }))
      try {
        let settled: Awaited<typeof outcome> | null = null
        for (let attempt = 0; attempt < 8 && !settled; attempt++) {
          settled = await Promise.race([outcome, new Promise<null>(resolve => setTimeout(() => resolve(null), settleMs))])
          if (settled) break
          const wake = await subscription.next(5000)
          for (;;) {
            const commands = await pendingWorkspaceReads(pool, pool, f.caller, f.deviceId, [], { diff: true, git: true })
            if (!commands.length) break
            for (const command of commands) await answer(f, command)
          }
          if (wake !== 'notified') break
        }
        if (!settled) settled = await Promise.race([outcome, new Promise<null>(resolve => setTimeout(() => resolve(null), 1000))])
        if (!settled) throw new Error('service did not settle')
        if (!settled.ok) throw settled.error
        return settled.value
      } finally { controller.abort(); subscription.close(); await outcome.catch(() => {}) }
    }
    async function answer(f: Fixture, command: WorkspaceReadCommand) {
      const receipt = command.request.kind.startsWith('git_')
        ? await handleWorkspaceGitRequest(command, f.entry, f.repository)
        : await readWorkspaceDiffReceipt(command, f.entry, f.repository)
      assert.equal(await finishWorkspaceRead(pool, pool, f.caller, f.deviceId, command.id, receipt), true,
        `receipt rejected for ${command.request.kind}`)
    }

    await t.test('live status and commit timeline come from the exact checkout', async () => {
      const f = await fixture()
      await f.write('src/example.ts', 'export const answer = 43\n')
      const status = await exchange(f, signal => getRunGitStatus(dependencies, actor(), f.runId, f.repoId, signal))
      assert.ok(status.live)
      const live = status.value
      if (!('entries' in live)) throw new Error('expected a live status')
      assert.equal(live.commitSha, f.headSha)
      assert.equal(live.branch.headSha, f.headSha)
      assert.ok(live.entries.some(entry => entry.path === 'src/example.ts' && entry.worktree === 'modified'))
      const history = await exchange(f, signal => listRunGitHistory(dependencies, actor(), f.runId, f.repoId, { limit: 10 }, signal))
      assert.equal(history.value.commitSha, f.headSha)
      assert.equal(history.value.commits[0]?.sha, f.headSha)
      assert.equal(history.value.commits[0]?.head, true)
    })

    await t.test('file revert previews, applies once, survives a retry and Undo restores the newer bytes', async () => {
      const f = await fixture()
      await f.write('src/example.ts', 'export const answer = 43\n')
      const snapshot = await exchange(f, signal => captureDiffSnapshot(dependencies, actor(), f.runId, f.repoId, { source: 'working' }, signal))
      const operationId = randomUUID()
      const preview = await exchange(f, signal => previewRevert(dependencies, actor(), f.runId, f.repoId,
        { operationId, snapshotId: snapshot.id, path: 'src/example.ts', target: { kind: 'file' } }, signal))
      assert.ok(preview.patch?.includes('-export const answer = 43'))
      assert.equal(typeof preview.afterContentBase64, 'string', 'the server retains the exact confirmed bytes internally')
      const applied = await exchange(f, signal => applyRevert(dependencies, actor(), f.runId, f.repoId, { operationId }, signal))
      assert.equal(applied.file.action, 'restored')
      assert.equal(await readFile(join(f.worktree, 'src/example.ts'), 'utf8'), 'export const answer = 42\n')
      assert.equal(applied.undoAvailable, true)
      const retried = await exchange(f, signal => applyRevert(dependencies, actor(), f.runId, f.repoId, { operationId }, signal))
      assert.equal(retried.previewVersion, applied.previewVersion)
      const undone = await exchange(f, signal => undoLastOperation(dependencies, actor(), f.runId, f.repoId,
        { operationId: randomUUID(), undoOf: operationId }, signal))
      assert.equal(undone.undoOf, operationId)
      assert.equal(await readFile(join(f.worktree, 'src/example.ts'), 'utf8'), 'export const answer = 43\n')
    })

    await t.test('a changed file or HEAD between preview and apply is refused and the newer bytes remain', async () => {
      const f = await fixture()
      await f.write('src/example.ts', 'export const answer = 43\n')
      const snapshot = await exchange(f, signal => captureDiffSnapshot(dependencies, actor(), f.runId, f.repoId, { source: 'working' }, signal))
      const operationId = randomUUID()
      await exchange(f, signal => previewRevert(dependencies, actor(), f.runId, f.repoId,
        { operationId, snapshotId: snapshot.id, path: 'src/example.ts', target: { kind: 'file' } }, signal))
      await f.write('src/example.ts', 'export const answer = 44\n')
      await assert.rejects(exchange(f, signal => applyRevert(dependencies, actor(), f.runId, f.repoId, { operationId }, signal)),
        code('workspace_version_conflict'))
      assert.equal(await readFile(join(f.worktree, 'src/example.ts'), 'utf8'), 'export const answer = 44\n')
      const f2 = await fixture()
      await f2.write('src/example.ts', 'export const answer = 43\n')
      const other = await exchange(f2, signal => captureDiffSnapshot(dependencies, actor(), f2.runId, f2.repoId, { source: 'working' }, signal))
      const second = randomUUID()
      await exchange(f2, signal => previewRevert(dependencies, actor(), f2.runId, f2.repoId,
        { operationId: second, snapshotId: other.id, path: 'src/example.ts', target: { kind: 'file' } }, signal))
      await f2.write('README.md', '# Agent wrote more\n')
      await git(f2.worktree, 'add', '--all')
      await git(f2.worktree, '-c', 'user.name=Mikka fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'agent commit')
      await assert.rejects(exchange(f2, signal => applyRevert(dependencies, actor(), f2.runId, f2.repoId, { operationId: second }, signal)),
        code('workspace_version_conflict'))
      assert.equal(await git(f2.worktree, 'rev-parse', 'HEAD') !== f2.headSha, true)
    })

    await t.test('hunk revert changes only the selected hunk', async () => {
      const f = await fixture()
      const original = Array.from({ length: 20 }, (_, index) => `line${String(index + 1).padStart(2, '0')}`).join('\n') + '\n'
      const changed = original.replace('line02', 'LINE02').replace('line18', 'LINE18')
      await f.write('src/example.ts', changed)
      const snapshot = await exchange(f, signal => captureDiffSnapshot(dependencies, actor(), f.runId, f.repoId, { source: 'working' }, signal))
      const patch = await exchange(f, signal => diffFile(dependencies, actor(), f.runId, f.repoId, snapshot.id, 'src/example.ts', signal))
      assert.ok(patch.hunks.length >= 2)
      const operationId = randomUUID()
      const preview = await exchange(f, signal => previewRevert(dependencies, actor(), f.runId, f.repoId,
        { operationId, snapshotId: snapshot.id, path: 'src/example.ts',
          target: { kind: 'hunks', fingerprints: [patch.hunks[0]!.fingerprint] } }, signal))
      assert.equal(preview.additions, 1)
      assert.equal(preview.deletions, 1)
      await exchange(f, signal => applyRevert(dependencies, actor(), f.runId, f.repoId, { operationId }, signal))
      const result = await readFile(join(f.worktree, 'src/example.ts'), 'utf8')
      const first = patch.hunks[0]!
      const selectedLine = first.lines.find(line => line.startsWith('-'))!.slice(1)
      assert.ok(result.includes(selectedLine), 'the selected new side was restored')
      assert.ok(result.includes('LINE18'), 'an unselected hunk is untouched')
    })

    await t.test('checkpoint dry run refuses conflicts and a clean restore is undoable', async () => {
      const f = await fixture()
      await f.write('src/example.ts', 'export const answer = 43\n')
      const taken = await takeCheckpoint({ repoPath: f.repository, worktree: f.worktree, baseCommit: f.entry.baseCommit!, repoId: f.repoId })
      assert.ok(taken)
      const review = taken.checkpoint.review as { revision: { baseSha: string; headSha: string | null; treeSha: string | null } }
      assert.ok(review)
      await pool.query(`INSERT INTO run_checkpoints("runId","userId","baseCommit",patch,files,"takenAt","updatedAt")
        VALUES($1,$2,$3,$4,$5,$6,$6)`, [f.runId, owner, taken.checkpoint.baseCommit,
        Buffer.from(taken.checkpoint.patch, 'base64'), taken.checkpoint.files, new Date(taken.checkpoint.takenAt)])
      // Any review read normally establishes this binding first; the retained
      // review row references it, so the fixture must do the same explicitly.
      await pool.query(`INSERT INTO coding_workspace_bindings("runId","repoId","ownerId","workspaceId","repositoryKey")
        VALUES($1,$2,$3,$4,$5) ON CONFLICT ("runId","repoId") DO NOTHING`, [f.runId, f.repoId, owner, workspaceId, repositoryKey])
      await pool.query(`INSERT INTO coding_workspace_checkpoint_reviews("runId","repoId","ownerId","workspaceId","snapshotId",
        "baseSha","headSha","treeSha",reason,"capturedAt") VALUES($1,$2,$3,$4,NULL,$5,$6,$7,NULL,$8)`,
      [f.runId, f.repoId, owner, workspaceId, review.revision.baseSha, review.revision.headSha,
        review.revision.treeSha, new Date(taken.checkpoint.takenAt)])
      const list = await exchange(f, signal => listRunCheckpoints(dependencies, actor(), f.runId, f.repoId, signal))
      assert.equal(list.checkpoints.length, 1)
      assert.equal(list.checkpoints[0]?.checkpointId, 'latest')
      assert.equal(list.checkpoints[0]?.restorable, true)
      // The Agent wrote a newer change after the checkpoint.
      await f.write('src/example.ts', 'export const answer = 44\n')
      const operationId = randomUUID()
      const preview = await exchange(f, signal => previewCheckpointRestore(dependencies, actor(), f.runId, f.repoId,
        { operationId, checkpointId: 'latest' }, signal))
      assert.equal(preview.clean, true)
      assert.ok(preview.files.some(file => file.path === 'src/example.ts' && file.action === 'modified'))
      const restored = await exchange(f, signal => restoreCheckpoint(dependencies, actor(), f.runId, f.repoId, { operationId }, signal))
      assert.equal(restored.undoAvailable, true)
      assert.equal(await readFile(join(f.worktree, 'src/example.ts'), 'utf8'), 'export const answer = 43\n')
      await exchange(f, signal => undoLastOperation(dependencies, actor(), f.runId, f.repoId,
        { operationId: randomUUID(), undoOf: operationId }, signal))
      assert.equal(await readFile(join(f.worktree, 'src/example.ts'), 'utf8'), 'export const answer = 44\n')
    })

    await t.test('members, strangers, other tenants and stopped machines never get live Git access', async () => {
      const f = await fixture()
      const identity = await resolveRunWorktree(pool, pool, { userId: owner, workspaceId }, f.runId, f.repoId)
      assert.ok(identity.identity.bindingId)
      await assert.rejects(exchange(f, signal => getRunGitStatus(dependencies, actor(member, memberSession), f.runId, f.repoId, signal)),
        code('workspace_not_found'))
      await assert.rejects(exchange(f, signal => getRunGitStatus(dependencies, actor(stranger, strangerSession), f.runId, f.repoId, signal)),
        code('workspace_not_found'))
      await assert.rejects(exchange(f, signal => getRunGitStatus(dependencies, actor(owner, ownerSession, otherWorkspace), f.runId, f.repoId, signal)),
        code('workspace_not_found'))
      await pool.query('UPDATE agent_runs SET status=\'stopped\',"stopRequestedAt"=now() WHERE id=$1', [f.runId])
      const frozen = await exchange(f, signal => getRunGitStatus(dependencies, actor(), f.runId, f.repoId, signal))
      const value = frozen.value
      assert.equal(value.availability, 'offline')
      assert.ok('frozen' in value && value.frozen === true)
      assert.equal('reason' in value ? value.reason : null, 'machine_unavailable')
      assert.equal('commits' in value ? value.commits.length : -1, 0)
      assert.equal(frozen.live, null)
    })
  } finally {
    mock.restoreAll()
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await dropTestDatabase(admin, database, pool, appPool, workspacePool)
    await admin.end()
    await rm(root, { recursive: true, force: true })
  }
})
