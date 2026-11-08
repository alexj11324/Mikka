import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { mock } from 'node:test'
import { promisify } from 'node:util'
import { Pool } from 'pg'
import { runAssignmentSchema } from '@mikka/protocol'
import { remoteKey } from '@mikka/protocol/repository'
import { CodingWorkspaceError, workspaceReadReceipt, type RunWorktreeIdentity, type WorkspaceReadCommand } from '@mikka/protocol/coding-workspace'
import { WorkspaceReviewError, type DiffFileMetadata, type DiffFilePatch,
  type ReviewAnchor, type ReviewBatchRequest } from '@mikka/protocol/coding-workspace-review'
import { readWorkspaceDiffReceipt } from '../../../packages/daemon/src/coding-workspace/diff'
import type { JournalEntry } from '../../../packages/daemon/src/runs/journal'
import { orderMigrations } from '../../../scripts/migration-order.mjs'
import { disposableDatabase, E2E_DB_RULE } from '../../../tests/helpers/e2e-target.mjs'
import { dropTestDatabase } from '../../../tests/support/drop-test-database'
import { admitRepositoryTask } from '../../repository-admission'
import type { ReviewActor } from './authority'

const url = process.env.E2E_DATABASE_URL
if (url) assert.ok(disposableDatabase(process.env, url), E2E_DB_RULE)
else if (process.env.REQUIRE_DB === '1') assert.fail('REQUIRE_DB=1 needs an isolated E2E_DATABASE_URL')
const execute = promisify(execFile)
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const code = (expected: string) => (error: unknown) =>
  (error instanceof CodingWorkspaceError || error instanceof WorkspaceReviewError) && error.code === expected
const sqlCode = (expected: string) => (error: unknown) => error !== null && typeof error === 'object' && 'code' in error && error.code === expected
const remote = 'https://github.com/mikka-fixtures/agent-review.git', repositoryKey = remoteKey(remote)

/** Real PG17, Git, full daemon proofs, authority, saved-secret policy, batches
 * and run_messages. Only requestWorkspaceRead's daemon transport is replaced;
 * its result comes from the real Git reader and the real receipt validator.
 * This suite complements the separately exercised TCP daemon HTTP boundary. */
test('agent review delivery with PostgreSQL 17 and real Git source proofs', { skip: !url, timeout: 240_000 }, async t => {
  const admin = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000 })
  const database = `agent_review_delivery_${randomUUID().replaceAll('-', '')}_e2e`
  const version = Number((await admin.query('SHOW server_version_num')).rows[0].server_version_num)
  assert.ok(version >= 170000 && version < 180000, 'agent delivery acceptance requires PostgreSQL 17')
  await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`)
  const target = new URL(url!); target.pathname = `/${database}`
  const pool = new Pool({ connectionString: target.toString(), max: 16, connectionTimeoutMillis: 5000 })
  const directory = await mkdtemp(join(tmpdir(), 'mikka-agent-review-db-'))
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
    const { validateWorkspaceReceipt } = await import('../receipt')
    const { secretMaskerFor } = await import('../../secrets/runtime')
    const { sealSecret, userSecretAad } = await import('../../secrets/crypto')
    const requests = await import('../requests')
    type Source = { identity: RunWorktreeIdentity; entry: JournalEntry; repository: string;
      reads: number; afterRead?: () => Promise<void> }
    const sources = new Map<string, Source>()
    const upstream: typeof requests.requestWorkspaceRead = async (database, membership, actor, runId, repoId, request, signal) => {
      signal?.throwIfAborted()
      assert.equal(request.kind, 'diff_snapshot', 'feedback source preflight requests a complete manifest')
      const source = sources.get(runId)
      assert.ok(source, 'only the exact registered source Run has a daemon fixture')
      const current = await resolveRunWorktree(database, membership, actor, runId, repoId)
      assert.equal(current.identity.bindingId, source.identity.bindingId)
      const command: WorkspaceReadCommand = { id: randomUUID(), identity: current.identity, request,
        expiresAt: new Date(Date.now() + 15_000).toISOString() }
      const proof = workspaceReadReceipt.parse(await readWorkspaceDiffReceipt(command, source.entry, source.repository))
      const mask = await secretMaskerFor({ workspaceId: actor.workspaceId, ownerId: actor.userId })
      const result = validateWorkspaceReceipt(request, current.identity, proof, mask)
      assert.ok(result, 'the actual daemon receipt must pass identity, manifest and full-source validation')
      source.reads++
      await source.afterRead?.()
      signal?.throwIfAborted()
      return result
    }
    mock.module(new URL('../requests.ts', import.meta.url).href, { namedExports: { ...requests, requestWorkspaceRead: upstream } })
    const { captureDiffSnapshot } = await import('./service')
    const { resolveReviewScope, withReviewTransaction } = await import('./authority')
    const { readDiffSnapshot, readStoredDiffFile, retainDiffFilePatch } = await import('./store')
    const { validateReviewAnchor } = await import('./patch')
    const { reviewFeedbackText } = await import('./feedback')
    const { deliverAgentReview, readAgentReviewBatch } = await import('./agent-delivery')
    appPool = (await import('../../db')).pool; workspacePool = (await import('../../workspace-db')).workspacePool
    const deps = { database: pool, membership: pool }
    const git = async (cwd: string, ...args: string[]) => (await execute('git', ['-C', cwd,
      '-c', 'user.name=Agent review fixture', '-c', 'user.email=agent-review@example.invalid',
      '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args])).stdout.trim()

    async function user() {
      const id = `agent-review-${randomUUID()}`, sessionId = randomUUID()
      await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt")
        VALUES($1,$1,$2,true,now(),now())`, [id, `${id}@example.invalid`])
      await pool.query(`INSERT INTO "session"(id,token,"userId","expiresAt","createdAt","updatedAt")
        VALUES($1,$2,$3,now()+interval '1 hour',now(),now())`, [sessionId, randomUUID(), id])
      return { id, sessionId }
    }
    type User = Awaited<ReturnType<typeof user>>
    const actor = (person: User, workspaceId: string): ReviewActor => ({ userId: person.id, workspaceId,
      credential: { kind: 'session', id: person.sessionId } })
    async function workspace(owner: User, member: User) {
      const id = randomUUID(), teamId = randomUUID()
      await pool.query('INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,$2,\'Agent review fixture\')', [id, owner.id])
      for (const person of [owner, member]) await pool.query(`INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status)
        VALUES($1,$2,$2,$3,$4,'active')`, [id, person.id, `${person.id}@example.invalid`, person === owner ? 'admin' : 'member'])
      await pool.query(`INSERT INTO mikka_teams(id,"workspaceId","userId",name,identifier)
        VALUES($1,$2,$3,'Agent review fixture',$4)`, [teamId, id, owner.id, `A${randomUUID().replaceAll('-', '').slice(0, 7).toUpperCase()}`])
      await pool.query('INSERT INTO mikka_team_members("teamId","userId",role) VALUES($1,$2,\'owner\')', [teamId, owner.id])
      return { id, teamId }
    }
    async function fixture(options: { count?: number; body?: string } = {}) {
      const owner = await user(), member = await user(), outsider = await user()
      const where = await workspace(owner, member), elsewhere = await workspace(owner, member), who = actor(owner, where.id)
      const runId = randomUUID(), repoId = randomUUID(), taskId = randomUUID(), deviceId = randomUUID(),
        tokenId = randomUUID(), agentId = randomUUID(), botId = randomUUID()
      const repository = join(directory, runId, 'repository'), worktree = join(directory, runId, 'checkout')
      await mkdir(repository, { recursive: true })
      await git(repository, 'init', '--initial-branch=main')
      await git(repository, 'config', 'core.autocrlf', 'false')
      await git(repository, 'remote', 'add', 'origin', remote)
      for (const path of ['alpha.txt', 'beta.txt']) await writeFile(join(repository, path), `before ${path}\nstable\n`)
      await git(repository, 'add', '--all'); await git(repository, 'commit', '-qm', 'feedback base')
      const targetBranch = 'mikka/agent-review-1'
      await git(repository, 'worktree', 'add', '-q', '-b', targetBranch, worktree, 'HEAD')
      const baseSha = await git(worktree, 'rev-parse', 'HEAD')
      await pool.query(`INSERT INTO issues(id,"userId",title,content,status,priority,scope)
        VALUES($1,$2,'Agent feedback task','{"type":"doc","content":[]}','doing','normal','workspace')`, [taskId, owner.id])
      await pool.query('INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId") VALUES($1,$2,$3,$4)',
        [taskId, where.teamId, where.id, owner.id])
      await pool.query('INSERT INTO bots(id,"workspaceId","ownerId",name) VALUES($1,$2,$3,\'Agent feedback fixture\')', [botId, where.id, owner.id])
      await pool.query('INSERT INTO devices(id,"ownerId",name,kind) VALUES($1,$2,\'Agent feedback fixture\',\'local\')', [deviceId, owner.id])
      await pool.query('INSERT INTO agents(id,"userId",name,harness,"deviceId") VALUES($1,$2,\'Agent feedback fixture\',\'codex\',$3)', [agentId, owner.id, deviceId])
      await pool.query('INSERT INTO device_repos(id,"userId","deviceId","repoPath","remoteUrl") VALUES($1,$2,$3,$4,$5)',
        [repoId, owner.id, deviceId, repositoryKey, remote])
      await pool.query(`INSERT INTO device_tokens(id,"userId","tokenHash","expiresAt","boundDeviceId","boundWorkspaceId")
        VALUES($1,$2,$3,now()+interval '1 hour',$4,$5)`, [tokenId, owner.id, digest(randomUUID()), deviceId, where.id])
      const admission = admitRepositoryTask({ userId: owner.id, issueId: taskId, deviceId, agentId,
        remoteKey: repositoryKey, remoteUrl: remote, targetBranch, workspaceId: where.id, now: new Date() })
      assert.ok(admission, 'the run-message path validates a complete owner-credential repository admission')
      const definition = { executionIdentity: { workspaceId: where.id }, repositoryAdmission: admission }
      await pool.query(`INSERT INTO agent_runs(id,"userId","issueId","botId","agentId","deviceId","deviceRepoId","deviceTokenId",
        status,"worktreePath","leaseExpiresAt","agentDefinition",prompt,kind)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'running',$9,now()+interval '10 minutes',$10,'Implement the original task.','implement')`,
      [runId, owner.id, taskId, botId, agentId, deviceId, repoId, tokenId, worktree, definition])
      const identity = (await resolveRunWorktree(pool, pool, who, runId, repoId)).identity
      const entry: JournalEntry = { assignment: runAssignmentSchema.parse({ runId, issueId: taskId, repoId, deviceId,
        remoteUrl: remote, baseBranch: 'main', harness: 'codex', prompt: 'Implement the original task.', kind: 'implement' }),
      state: 'running', sessionId: null, worktree, baseCommit: baseSha, lastSeq: 0, error: null, updatedAt: new Date().toISOString() }
      const source: Source = { identity, entry, repository, reads: 0 }
      sources.set(runId, source)
      const write = (path: string, text: string) => writeFile(join(worktree, path), text)
      for (const path of ['alpha.txt', 'beta.txt']) await write(path, `after ${path}\nstable\n`)
      let snapshot = await captureDiffSnapshot(deps, who, runId, repoId, { source: 'working' })
      const scope = await resolveReviewScope(pool, pool, who, runId, repoId)
      const mask = await secretMaskerFor({ workspaceId: where.id, ownerId: owner.id })
      const files = (await pool.query<{ metadata: DiffFileMetadata }>('SELECT metadata FROM coding_workspace_snapshot_files WHERE "snapshotId"=$1 ORDER BY position', [snapshot.id])).rows.map(row => row.metadata)
      assert.equal(files.length, 2)
      for (const file of files) {
        const request = { kind: 'diff_file' as const, snapshotId: snapshot.id, revision: snapshot.revision, file }
        const command: WorkspaceReadCommand = { id: randomUUID(), identity, request, expiresAt: new Date(Date.now() + 15_000).toISOString() }
        const proof = workspaceReadReceipt.parse(await readWorkspaceDiffReceipt(command, entry, repository))
        const result = validateWorkspaceReceipt(request, identity, proof, mask)
        assert.ok(result?.ok && result.kind === 'diff_file')
        const patch: DiffFilePatch = { snapshotId: result.snapshotId, sourceVersion: result.sourceVersion, file: result.file,
          format: result.format, patch: result.patch, hunks: result.hunks }
        await withReviewTransaction(pool, pool, who, runId, repoId, (client, fresh) =>
          retainDiffFilePatch(client, fresh, snapshot, patch, mask, mask.sourcePolicy))
      }
      snapshot = await readDiffSnapshot(pool, scope, snapshot.id)
      assert.equal(snapshot.counts.complete, true)
      const comments: { id: string; anchor: ReviewAnchor; body: string; userId: string }[] = []
      const boardRevision = async () => Number((await pool.query('SELECT revision FROM coding_workspace_review_boards WHERE id=$1', [scope.boardId])).rows[0].revision)
      async function addComment(person = owner, body = `Fix the changed line ${comments.length + 1}.`) {
        const id = randomUUID(), path = files[comments.length % files.length]!.path
        await withReviewTransaction(pool, pool, actor(person, where.id), runId, repoId, async (client, fresh) => {
          const stored = await readStoredDiffFile(client, fresh, snapshot, path, mask)
          assert.ok(stored.patch?.hunks[0])
          const anchor = validateReviewAnchor({ snapshotId: snapshot.id, sourceVersion: snapshot.revision.version, path,
            side: 'RIGHT', lineStart: 1, lineEnd: 1, hunkFingerprint: stored.patch.hunks[0].fingerprint }, stored.patch)
          await client.query(`INSERT INTO coding_workspace_review_comments(id,"threadId","boardId","snapshotId","userId",anchor,body,draft)
            VALUES($1,$1,$2,$3,$4,$5,$6,true)`, [id, scope.boardId, snapshot.id, person.id, anchor, body])
          await client.query('UPDATE coding_workspace_review_boards SET revision=revision+1 WHERE id=$1', [scope.boardId])
          comments.push({ id, anchor, body, userId: person.id })
        })
        return id
      }
      for (let index = 0; index < (options.count ?? 2); index++) await addComment(owner, options.body)
      const input = async (change: Partial<ReviewBatchRequest> = {}): Promise<ReviewBatchRequest> => ({
        requestId: randomUUID(), batchId: randomUUID(), expectedRevision: await boardRevision(), snapshotId: snapshot.id,
        sourceVersion: snapshot.revision.version, commentIds: comments.filter(comment => comment.userId === owner.id).map(comment => comment.id),
        note: '', failedCheckRefs: [], ...change,
      })
      const deliver = (value: ReviewBatchRequest, person = who, signal?: AbortSignal) => deliverAgentReview(deps, person, runId, repoId, value, signal)
      const read = (batchId: string, person = who) => readAgentReviewBatch(deps, person, runId, repoId, batchId)
      const rows = async () => ({
        messages: (await pool.query('SELECT * FROM run_messages WHERE "runId"=$1 ORDER BY id', [runId])).rows,
        batches: (await pool.query('SELECT * FROM coding_workspace_review_batches WHERE "boardId"=$1 ORDER BY id', [scope.boardId])).rows,
        comments: (await pool.query('SELECT id,draft FROM coding_workspace_review_comments WHERE "boardId"=$1 ORDER BY id', [scope.boardId])).rows,
      })
      return { owner, member, outsider, where, elsewhere, who, runId, repoId, taskId, botId, deviceId, agentId,
        tokenId, definition, snapshot, scope, source, worktree, comments, addComment, input, deliver, read, rows, write, boardRevision }
    }
    type Fixture = Awaited<ReturnType<typeof fixture>>
    async function unchanged(f: Fixture) {
      const rows = await f.rows()
      assert.equal(rows.messages.length, 0)
      assert.ok(rows.batches.every(row => row.state !== 'accepted'))
      assert.ok(rows.comments.every(row => row.draft))
    }
    async function saveSecret(f: Fixture, value: string) {
      const row = { id: randomUUID(), userId: f.owner.id, name: `REVIEW_${randomUUID().replaceAll('-', '').toUpperCase()}`, kind: 'secret' }
      const sealed = sealSecret(value, userSecretAad(row))
      await pool.query(`INSERT INTO user_secrets(id,"userId",name,kind,ciphertext,iv,"keyVersion")
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [row.id, row.userId, row.name, row.kind, sealed.ciphertext, sealed.iv, sealed.keyVersion])
    }

    await t.test('two owner comments become one real run message with an accepted batch and complete anchored feedback', async () => {
      const f = await fixture(), input = await f.input(), receipt = await f.deliver(input), rows = await f.rows()
      assert.equal(receipt.state, 'accepted'); assert.equal(receipt.destination, 'agent')
      assert.equal(receipt.delivery?.kind, 'run_message'); assert.equal(receipt.delivery?.runId, f.runId)
      assert.equal(rows.messages.length, 1); assert.equal(rows.batches.length, 1)
      assert.equal(rows.messages[0].id, receipt.delivery!.id); assert.equal(rows.messages[0].userId, f.owner.id)
      assert.equal(rows.messages[0].origin, 'owner'); assert.equal(rows.messages[0].mailboxWakeDepth, -1)
      assert.equal(rows.batches[0].state, 'accepted'); assert.equal(rows.batches[0].receipt.delivery.id, rows.messages[0].id)
      assert.ok(rows.comments.every(row => !row.draft)); assert.ok(f.source.reads >= 2, 'delivery recaptures the actual source')
      const text = String(rows.messages[0].text)
      for (const comment of f.comments) {
        assert.ok(text.includes(comment.id)); assert.ok(text.includes(comment.body))
        assert.ok(text.includes(JSON.stringify(comment.anchor)))
      }
      for (const expected of [f.runId, f.repoId, f.snapshot.id, f.snapshot.revision.version, repositoryKey]) assert.ok(text.includes(expected))
      for (const privateKey of ['maskPolicy', 'sourcePolicy', 'base64', 'blobs']) assert.ok(!text.includes(`"${privateKey}":`))
      assert.deepEqual(await f.read(receipt.batchId), receipt)
    })

    await t.test('exact retries and new request IDs for the same frozen semantics reuse the one accepted message', async () => {
      const f = await fixture(), input = await f.input(), first = await f.deliver(input)
      const exact = await f.deliver(input)
      assert.equal(exact.batchId, first.batchId); assert.equal(exact.state, 'accepted')
      assert.ok(input.expectedRevision < await f.boardRevision())
      const duplicate = await f.deliver({ ...input, requestId: randomUUID(), batchId: randomUUID(), commentIds: [...input.commentIds].reverse() })
      assert.equal(duplicate.batchId, first.batchId); assert.equal(duplicate.delivery?.id, first.delivery?.id)
      await assert.rejects(() => f.deliver({ ...input, note: 'A changed request under the same request ID.' }), code('workspace_review_conflict'))
      await assert.rejects(() => f.deliver({ ...input, requestId: randomUUID(), batchId: randomUUID(), note: 'Different feedback with a stale board revision.' }), code('workspace_review_conflict'))
      const rows = await f.rows(); assert.equal(rows.messages.length, 1); assert.equal(rows.batches.length, 1)
      const aliases = (await pool.query(`SELECT response FROM coding_workspace_review_receipts
        WHERE "boardId"=$1 AND action='batch_agent'`, [f.scope.boardId])).rows
      assert.equal(aliases.length, 2); assert.ok(aliases.every(row => row.response.batchId === first.batchId))
    })

    await t.test('accepted batch reads retain current session, workspace and private-owner authority', async () => {
      const f = await fixture(), accepted = await f.deliver(await f.input())
      await assert.rejects(() => f.read(accepted.batchId, actor(f.member, f.where.id)), code('workspace_review_unavailable'))
      await assert.rejects(() => f.read(accepted.batchId, actor(f.owner, f.elsewhere.id)), code('workspace_not_found'))
      await assert.rejects(() => f.read(randomUUID()), code('workspace_review_unavailable'))
      await pool.query('UPDATE "session" SET "expiresAt"=now()-interval \'1 second\' WHERE id=$1', [f.owner.sessionId])
      await assert.rejects(() => f.read(accepted.batchId), code('workspace_not_found'))
      const rows = await f.rows(); assert.equal(rows.messages.length, 1); assert.equal(rows.batches[0].state, 'accepted')
    })

    await t.test('concurrent exact and semantic submissions converge on one batch and one real message', async () => {
      const f = await fixture(), input = await f.input()
      const results = await Promise.allSettled([f.deliver(input), f.deliver(input),
        f.deliver({ ...input, requestId: randomUUID(), batchId: randomUUID() })])
      const batches = new Set<string>(), messages = new Set<string>()
      for (const result of results) {
        assert.equal(result.status, 'fulfilled', result.status === 'rejected' ? String(result.reason) : undefined)
        if (result.status === 'fulfilled') {
          assert.equal(result.value.state, 'accepted'); batches.add(result.value.batchId)
          assert.ok(result.value.delivery); messages.add(result.value.delivery.id)
        }
      }
      assert.equal(batches.size, 1); assert.equal(messages.size, 1)
      const rows = await f.rows(); assert.equal(rows.messages.length, 1); assert.equal(rows.batches.length, 1)
      assert.equal(rows.batches[0].state, 'accepted')
    })

    await t.test('shared Task visibility does not grant another member control of the owner Agent', async () => {
      const f = await fixture(), id = await f.addComment(f.member, 'A member-owned private draft.')
      await assert.rejects(async () => f.deliver(await f.input({ commentIds: [id] }), actor(f.member, f.where.id)), code('workspace_review_unavailable'))
      await unchanged(f)
    })

    await t.test('PAT and device tokens cannot create Agent feedback even when they belong to the Run owner', async () => {
      const f = await fixture(), input = await f.input(), patId = randomUUID()
      await pool.query(`INSERT INTO personal_access_tokens(id,"userId","workspaceId",name,"tokenHash",hint,"expiresAt")
        VALUES($1,$2,$3,'Agent review PAT',$4,'test',now()+interval '1 hour')`, [patId, f.owner.id, f.where.id, digest(randomUUID())])
      for (const credential of [{ kind: 'pat', id: patId }, { kind: 'device', id: f.tokenId, deviceId: f.deviceId }] as const)
        await assert.rejects(() => f.deliver(input, { ...f.who, credential }), code('workspace_review_unavailable'))
      await unchanged(f)
    })

    for (const changed of ['expired session', 'foreign workspace', 'nonmember', 'wrong repository'] as const)
      await t.test(`${changed} cannot send or create an accepted Agent batch`, async () => {
        const f = await fixture(), input = await f.input()
        if (changed === 'expired session') await pool.query('UPDATE "session" SET "expiresAt"=now()-interval \'1 second\' WHERE id=$1', [f.owner.sessionId])
        const who = changed === 'foreign workspace' ? actor(f.owner, f.elsewhere.id)
          : changed === 'nonmember' ? actor(f.outsider, f.where.id) : f.who
        await assert.rejects(() => deliverAgentReview(deps, who, f.runId, changed === 'wrong repository' ? randomUUID() : f.repoId, input), code('workspace_not_found'))
        await unchanged(f)
      })

    await t.test('the Run owner cannot publish another Task member private draft', async () => {
      const f = await fixture(), id = await f.addComment(f.member, 'This draft belongs to the member.')
      await assert.rejects(async () => f.deliver(await f.input({ commentIds: [id] })), code('workspace_review_unavailable'))
      await unchanged(f)
    })

    await t.test('a stale source version cannot borrow current anchors or deliver feedback', async () => {
      const f = await fixture()
      await assert.rejects(async () => f.deliver(await f.input({ sourceVersion: '0'.repeat(64) })), code('workspace_snapshot_outdated'))
      await unchanged(f)
    })

    await t.test('actual Git edits after review reject the previous complete manifest before sending', async () => {
      const f = await fixture(), input = await f.input()
      await f.write('alpha.txt', 'newer code written after review\nstable\n')
      const receipt = await f.deliver(input)
      assert.equal(receipt.state, 'rejected'); assert.equal(receipt.reason, 'source_changed'); assert.equal(receipt.delivery, null)
      assert.deepEqual(await f.read(receipt.batchId), receipt)
      await unchanged(f)
    })

    await t.test('a definitely rejected source can be explicitly resubmitted after real Git restoration without unlocking the old request', async () => {
      const f = await fixture(), input = await f.input()
      const original = await readFile(join(f.worktree, 'alpha.txt'), 'utf8')
      await f.write('alpha.txt', 'temporary source drift\nstable\n')
      const rejected = await f.deliver(input)
      assert.equal(rejected.state, 'rejected'); assert.equal(rejected.reason, 'source_changed'); assert.equal(rejected.delivery, null)
      await unchanged(f)
      const originalRetry = await f.deliver(input)
      assert.equal(originalRetry.batchId, rejected.batchId); assert.equal(originalRetry.state, 'rejected')
      await f.write('alpha.txt', original)
      const restoredOldRequest = await f.deliver(input)
      assert.equal(restoredOldRequest.batchId, rejected.batchId); assert.equal(restoredOldRequest.state, 'rejected')
      await unchanged(f)

      // A new explicit request uses the current CAS revision, with exactly
      // the same reviewed source, selected comments and feedback semantics.
      const retry = { ...input, requestId: randomUUID(), batchId: randomUUID(), expectedRevision: await f.boardRevision() }
      const accepted = await f.deliver(retry)
      assert.equal(accepted.state, 'accepted'); assert.equal(accepted.batchId, retry.batchId)
      assert.notEqual(accepted.batchId, rejected.batchId)
      assert.equal(accepted.delivery?.kind, 'run_message'); assert.equal(accepted.delivery?.runId, f.runId)
      const repeated = await f.deliver(retry)
      const semantic = await f.deliver({ ...retry, requestId: randomUUID(), batchId: randomUUID() })
      for (const receipt of [repeated, semantic]) {
        assert.equal(receipt.state, 'accepted'); assert.equal(receipt.batchId, accepted.batchId)
        assert.equal(receipt.delivery?.id, accepted.delivery?.id)
      }
      const oldAfterAcceptance = await f.deliver(input)
      assert.equal(oldAfterAcceptance.batchId, rejected.batchId); assert.equal(oldAfterAcceptance.state, 'rejected')
      const rows = await f.rows()
      assert.equal(rows.messages.length, 1); assert.equal(rows.messages[0].id, accepted.delivery!.id)
      assert.equal(rows.batches.length, 2)
      const old = rows.batches.find(row => row.id === rejected.batchId), current = rows.batches.find(row => row.id === accepted.batchId)
      assert.ok(old && current)
      assert.equal(old.state, 'rejected'); assert.equal(old.receipt.delivery, null); assert.equal(current.state, 'accepted')
      assert.equal(old.fingerprint, current.fingerprint); assert.deepEqual(old.input, current.input)
      assert.ok(rows.comments.every(row => !row.draft))
    })

    await t.test('a session revoked while daemon source evidence is in flight cannot send', async () => {
      const f = await fixture(), input = await f.input()
      f.source.afterRead = async () => {
        f.source.afterRead = undefined
        await pool.query('UPDATE "session" SET "expiresAt"=now()-interval \'1 second\' WHERE id=$1', [f.owner.sessionId])
      }
      await assert.rejects(() => f.deliver(input), code('workspace_not_found'))
      await unchanged(f)
    })

    await t.test('a new encrypted secret policy invalidates retained full-source evidence before message acceptance', async () => {
      const f = await fixture(), input = await f.input(), secret = `agent-review-private-${randomUUID()}`
      const prior = await secretMaskerFor({ workspaceId: f.where.id, ownerId: f.owner.id })
      f.source.afterRead = async () => {
        f.source.afterRead = undefined
        await saveSecret(f, secret)
        const current = await secretMaskerFor({ workspaceId: f.where.id, ownerId: f.owner.id })
        assert.notEqual(current.sourcePolicy, prior.sourcePolicy); assert.notEqual(current(secret), secret)
      }
      const receipt = await f.deliver(input)
      assert.equal(receipt.state, 'rejected'); assert.equal(receipt.reason, 'authorization_changed'); assert.equal(receipt.delivery, null)
      await unchanged(f)
    })

    for (const bound of ['10K characters', '32 KiB UTF-8'] as const)
      await t.test(`feedback above ${bound} rejects the whole selection without partial messages or accepted drafts`, async () => {
        const f = await fixture(bound === '10K characters' ? { count: 4, body: 'x'.repeat(3000) } : { count: 4, body: '界'.repeat(1250) })
        const selected = f.comments.map(comment => comment.body).join('')
        if (bound === '10K characters') assert.ok(selected.length > 10_000)
        else {
          const comments = f.comments.map(({ id, anchor, body }) => ({ id, anchor, body })).sort((a, b) => a.id.localeCompare(b.id))
          const text = reviewFeedbackText(f.snapshot, comments, '', [])
          assert.ok(text.length < 10_000, 'the UTF-8 case must pass the independent text length limit')
          const frozen = { version: 1, sourceVersion: f.snapshot.revision.version, runId: f.runId, repoId: f.repoId,
            commentIds: comments.map(comment => comment.id), agent: { text, comments, note: '', failedCheckRefs: [] } }
          const bytes = Number((await pool.query('SELECT octet_length($1::jsonb::text) AS bytes', [JSON.stringify(frozen)])).rows[0].bytes)
          assert.ok(bytes > 32_768, 'real PostgreSQL JSONB bytes exceed the immutable batch limit')
        }
        await assert.rejects(async () => f.deliver(await f.input()), code('workspace_limit_exceeded'))
        await unchanged(f)
      })

    await t.test('a newer successor Run rejects the old source review instead of redirecting its message', async () => {
      const f = await fixture(), successor = randomUUID()
      await pool.query(`INSERT INTO agent_runs(id,"userId","issueId","botId","agentId","deviceId","deviceRepoId","deviceTokenId",
        status,"worktreePath","leaseExpiresAt","agentDefinition",prompt,kind,"retryOf")
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'running',$9,now()+interval '10 minutes',$10,'A newer successor task.','implement',$11)`,
      [successor, f.owner.id, f.taskId, f.botId, f.agentId, f.deviceId, f.repoId, f.tokenId, f.worktree, f.definition, f.runId])
      const receipt = await f.deliver(await f.input())
      assert.equal(receipt.state, 'rejected'); assert.equal(receipt.reason, 'source_changed'); assert.equal(receipt.delivery, null)
      await unchanged(f)
      assert.equal((await pool.query('SELECT 1 FROM run_messages WHERE "runId"=$1', [successor])).rowCount, 0)
      await assert.rejects(() => readAgentReviewBatch(deps, f.who, successor, f.repoId, receipt.batchId),
        error => code('workspace_not_found')(error) || code('workspace_review_conflict')(error))
    })

    for (const failure of ['batch projection', 'message commit'] as const)
      await t.test(`a real ${failure} failure rolls back both message acceptance and draft publication`, async () => {
        const f = await fixture(), input = await f.input(), name = `agent_review_fixture_${randomUUID().replaceAll('-', '')}`
        const table = failure === 'batch projection' ? 'coding_workspace_review_batches' : 'run_messages'
        await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $fixture$
          BEGIN IF ${failure === 'batch projection' ? `NEW.id='${input.batchId}'::uuid AND NEW.state='accepted'`
            : `NEW."runId"='${f.runId}'::uuid`} THEN
            RAISE EXCEPTION 'controlled_agent_delivery_failure' USING ERRCODE='P0001'; END IF; RETURN NEW; END
          $fixture$`)
        await pool.query(failure === 'batch projection'
          ? `CREATE TRIGGER ${name} BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`
          : `CREATE CONSTRAINT TRIGGER ${name} AFTER INSERT ON ${table} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${name}()`)
        try {
          await assert.rejects(() => f.deliver(input), error => sqlCode('P0001')(error) || code('workspace_review_delivery_uncertain')(error))
          await unchanged(f)
        } finally {
          await pool.query(`DROP TRIGGER ${name} ON ${table}`)
          await pool.query(`DROP FUNCTION ${name}()`)
        }
        const retried = await f.deliver(input), rows = await f.rows()
        assert.equal(retried.state, 'accepted'); assert.equal(rows.messages.length, 1)
        assert.equal(rows.batches.length, 1); assert.equal(rows.batches[0].state, 'accepted')
        assert.ok(rows.comments.every(row => !row.draft))
      })
  } finally {
    mock.restoreAll()
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
    await dropTestDatabase(admin, database, pool, appPool, workspacePool)
    await admin.end()
    await rm(directory, { recursive: true, force: true })
  }
})
