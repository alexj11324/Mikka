import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { mock, type TestContext } from 'node:test'
import { promisify } from 'node:util'
import { Pool } from 'pg'
import { z } from 'zod'
import { runAssignmentSchema } from '@mikka/protocol'
import { remoteKey } from '@mikka/protocol/repository'
import { CodingWorkspaceError, workspaceReadReceipt, type RunWorktreeIdentity, type WorkspaceReadCommand } from '@mikka/protocol/coding-workspace'
import { checkpointReviewEvidence, reviewBatchReceipt, WorkspaceReviewError, type DiffFilePatch, type DiffSnapshot,
  type ReviewBatchReceipt, type TaskReviewRef, type TaskReviewSubmission } from '@mikka/protocol/coding-workspace-review'
import { takeCheckpoint } from '../../../packages/daemon/src/agents/checkpoint'
import { readWorkspaceDiffReceipt } from '../../../packages/daemon/src/coding-workspace/diff'
import type { JournalEntry } from '../../../packages/daemon/src/runs/journal'
import { orderMigrations } from '../../../scripts/migration-order.mjs'
import { disposableDatabase, E2E_DB_RULE } from '../../../tests/helpers/e2e-target.mjs'
import { dropTestDatabase } from '../../../tests/support/drop-test-database'
import { GitHubAccessError } from '../../github/user-access-error'
import { admitRepositoryTask } from '../../repository-admission'
import type { RequestBudget } from '../../request-budget'
import type { ReviewActor } from '../diff/authority'
import type { ReviewBatchRow } from '../diff/batch-store'
import type { TaskReviewHttpInput } from './http'

const url = process.env.E2E_DATABASE_URL
if (url) assert.ok(disposableDatabase(process.env, url), E2E_DB_RULE)
else if (process.env.REQUIRE_DB === '1') assert.fail('REQUIRE_DB=1 needs an isolated E2E_DATABASE_URL')
const execute = promisify(execFile)
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const code = (expected: string) => (error: unknown) =>
  (error instanceof CodingWorkspaceError || error instanceof WorkspaceReviewError) && error.code === expected
const sqlFault = (error: unknown) => error !== null && typeof error === 'object'
  && 'code' in error && error.code === 'P0001' && 'message' in error && error.message === 'task_send_prepare_fixture'
const fullName = 'mikka-fixtures/task-review-send', remote = `https://github.com/${fullName}.git`, repositoryKey = remoteKey(remote)
const repositoryId = '61393725', pullNumber = 7, apiPath = '/repos/' + fullName
const pullUrl = `https://github.com/${fullName}/pull/${pullNumber}`, reviewId = '9007199254741001'
const reference = (snapshot: DiffSnapshot): TaskReviewRef => ({ snapshotId: snapshot.id, sourceVersion: snapshot.revision.version })
type SendProjection = { submissionId: string; reviewRef: TaskReviewRef; state: 'sent' | 'pending' | 'partial' | 'rejected' | 'blocked';
  agent: ReviewBatchReceipt; github: ReviewBatchReceipt | null; messageId?: string; attempt?: number; error?: string; reason?: string }
type Plan = { version: 1; id: string; submissionDigest: string;
  agent: { batchId: string; requestId: string; expectedRevision: number };
  github?: { batchId: string; requestId: string; expectedRevision: number } }

/** Real PG17 migrations, authority/session/membership, linked Git worktrees,
 * checkpoint/full-source proofs, frozen plans, operation ledger and inbox.
 * Only upstream credential acquisition, GitHub HTTP and daemon transport are
 * controlled. The daemon transport still runs the actual Git reader and full
 * receipt validator; provider responses are fixtures, not external E2E. */
test('Task review send composes real transactional deliveries on PostgreSQL 17', { skip: !url, timeout: 240_000 }, async t => {
  const admin = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000 })
  const database = 'task_review_send_' + randomUUID().replaceAll('-', '') + '_e2e'
  const version = Number((await admin.query('SHOW server_version_num')).rows[0].server_version_num)
  assert.ok(version >= 170000 && version < 180000, 'Task review send acceptance requires PostgreSQL 17')
  await admin.query('CREATE DATABASE "' + database + '" TEMPLATE template0')
  const target = new URL(url!); target.pathname = '/' + database
  const pool = new Pool({ connectionString: target.toString(), max: 16, connectionTimeoutMillis: 5000 })
  const directory = await mkdtemp(join(tmpdir(), 'mikka-task-send-db-'))
  const environment = { MIKKA_DATABASE_URL: target.toString(), DATABASE_URL: target.toString(), ORVILO_DATABASE_URL: target.toString(),
    E2E_DATABASE_URL: target.toString(), BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
    BETTER_AUTH_URL: 'http://127.0.0.1:3199', WORKSPACE_SECRETS_KEY: randomBytes(32).toString('hex'),
    GITHUB_CLIENT_ID: 'fixture-client', GITHUB_CLIENT_SECRET: 'fixture-client-secret' }
  const previous = Object.fromEntries(Object.keys(environment).map(name => [name, process.env[name]]))
  Object.assign(process.env, environment)
  let appPool: Pool | undefined, workspacePool: Pool | undefined
  const tokens = new Map<string, { token: string; githubAccountId: string; expiresAt: Date }>()
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
    mock.module(new URL('../../github/user-access.ts', import.meta.url).href, { namedExports: {
      GitHubAccessError,
      readAuthorizedIssue: async () => { assert.fail('Task review send must not fetch external issue content') },
      githubTokenForUser: async (userId: string, options: { minValidityMs?: number; budget?: RequestBudget } = {}) => {
        const token = tokens.get(userId)
        assert.ok(token, 'native review requests the actual fixture owner credential')
        assert.equal(options.minValidityMs, 45_000); assert.ok(options.budget && options.budget.deadline > Date.now())
        return token
      },
      githubRepositoryReadCredential: async (userId: string, key: string, budget?: RequestBudget) => {
        const token = tokens.get(userId)
        assert.ok(token); assert.equal(key, repositoryKey); assert.ok(budget && budget.deadline > Date.now())
        return { ...token, kind: 'user', repository: { id: repositoryId, fullName, installationId: '1',
          htmlUrl: 'https://github.com/' + fullName, private: true } }
      },
    } })
    const { resolveRunWorktree } = await import('../identity')
    const { validateWorkspaceReceipt } = await import('../receipt')
    const { secretMaskerFor } = await import('../../secrets/runtime')
    const requests = await import('../requests')
    type Source = { identity: RunWorktreeIdentity; entry: JournalEntry; repository: string; reads: number }
    const sources = new Map<string, Source>()
    const upstream: typeof requests.requestWorkspaceRead = async (database, membership, actor, runId, repoId, request, signal) => {
      signal?.throwIfAborted()
      assert.equal(request.kind, 'diff_snapshot', 'only the actual Agent source preflight needs daemon I/O')
      const source = sources.get(runId)
      assert.ok(source, 'never follow a caller-selected replacement Run')
      const current = await resolveRunWorktree(database, membership, actor, runId, repoId)
      assert.equal(current.identity.bindingId, source.identity.bindingId)
      const command: WorkspaceReadCommand = { id: randomUUID(), identity: current.identity, request,
        expiresAt: new Date(Date.now() + 15_000).toISOString() }
      const receipt = workspaceReadReceipt.parse(await readWorkspaceDiffReceipt(command, source.entry, source.repository))
      const mask = await secretMaskerFor({ workspaceId: actor.workspaceId, ownerId: actor.userId })
      const result = validateWorkspaceReceipt(request, current.identity, receipt, mask)
      assert.ok(result, 'the actual daemon identity, Git manifest and proof validator must succeed')
      source.reads++
      signal?.throwIfAborted()
      return result
    }
    mock.module(new URL('../requests.ts', import.meta.url).href, { namedExports: { ...requests, requestWorkspaceRead: upstream } })
    const { saveGitHubConnection } = await import('../../github/connection')
    const { ensureReviewScope } = await import('../diff/service')
    const { withReviewTransaction } = await import('../diff/authority')
    const { prepareCheckpointReview, retainCheckpointReview } = await import('../diff/checkpoint')
    const { readDiffSnapshot, retainDiffSnapshot, manifestRevision } = await import('../diff/store')
    const { buildGitHubManifest } = await import('../diff/github-manifest')
    const { buildGitHubFilePatch } = await import('../diff/github-patch')
    const { gitBlobHash } = await import('../diff/patch')
    const { githubDiffProvider } = await import('../diff/github')
    const { sendTaskReview } = await import('./send')
    const { TaskReviewDenied } = await import('./http')
    appPool = (await import('../../db')).pool; workspacePool = (await import('../../workspace-db')).workspacePool
    const git = async (cwd: string, ...args: string[]) => (await execute('git', ['-C', cwd,
      '-c', 'user.name=Task send fixture', '-c', 'user.email=task-send@example.invalid',
      '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args])).stdout.trim()
    async function user() {
      const id = 'task-send-' + randomUUID(), sessionId = randomUUID()
      await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())',
        [id, id + '@example.invalid'])
      await pool.query('INSERT INTO "session"(id,token,"userId","expiresAt","createdAt","updatedAt") VALUES($1,$2,$3,now()+interval \'1 hour\',now(),now())',
        [sessionId, randomUUID(), id])
      return { id, sessionId }
    }
    type User = Awaited<ReturnType<typeof user>>
    const actor = (person: User, workspaceId: string): ReviewActor => ({ userId: person.id, workspaceId,
      credential: { kind: 'session', id: person.sessionId } })
    async function fixture(context: TestContext, options: { pr?: boolean } = {}) {
      const owner = await user(), member = await user(), workspaceId = randomUUID(), teamId = randomUUID()
      await pool.query('INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,$2,\'Task send fixture\')', [workspaceId, owner.id])
      for (const person of [owner, member]) await pool.query(`INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status)
        VALUES($1,$2,$2,$3,$4,'active')`, [workspaceId, person.id, person.id + '@example.invalid', person === owner ? 'admin' : 'member'])
      await pool.query('INSERT INTO mikka_teams(id,"workspaceId","userId",name,identifier) VALUES($1,$2,$3,\'Task send fixture\',$4)',
        [teamId, workspaceId, owner.id, 'S' + randomUUID().replaceAll('-', '').slice(0, 7).toUpperCase()])
      await pool.query('INSERT INTO mikka_team_members("teamId","userId",role) VALUES($1,$2,\'owner\')', [teamId, owner.id])
      const who = actor(owner, workspaceId), viewer = actor(member, workspaceId), taskId = randomUUID(), runId = randomUUID(), repoId = randomUUID(),
        deviceId = randomUUID(), tokenId = randomUUID(), agentId = randomUUID(), botId = randomUUID()
      const repository = join(directory, runId, 'repository'), worktree = join(directory, runId, 'checkout'), branch = 'mikka/task-send-1'
      await mkdir(repository, { recursive: true })
      await git(repository, 'init', '--initial-branch=main'); await git(repository, 'config', 'core.autocrlf', 'false')
      await git(repository, 'remote', 'add', 'origin', remote)
      const files = ['alpha.txt', 'beta.txt'].map(path => ({ path, before: Buffer.from('before ' + path + '\nstable\n'),
        after: Buffer.from('after ' + path + '\nstable\n'), patch: `@@ -1,2 +1,2 @@\n-before ${path}\n+after ${path}\n stable\n` }))
      for (const file of files) await writeFile(join(repository, file.path), file.before)
      await git(repository, 'add', '--all'); await git(repository, 'commit', '-qm', 'task send base')
      await git(repository, 'worktree', 'add', '-q', '-b', branch, worktree, 'HEAD')
      const baseSha = await git(worktree, 'rev-parse', 'HEAD')
      for (const file of files) await writeFile(join(worktree, file.path), file.after)
      if (options.pr) { await git(worktree, 'add', '--all'); await git(worktree, 'commit', '-qm', 'task send PR head') }
      const headSha = await git(worktree, 'rev-parse', 'HEAD')
      await pool.query('INSERT INTO issues(id,"userId",title,content,status,priority,scope) VALUES($1,$2,\'Task send\',\'{"type":"doc","content":[]}\',\'doing\',\'normal\',\'workspace\')', [taskId, owner.id])
      await pool.query('INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId") VALUES($1,$2,$3,$4)', [taskId, teamId, workspaceId, owner.id])
      await pool.query('INSERT INTO bots(id,"workspaceId","ownerId",name) VALUES($1,$2,$3,\'Task send fixture\')', [botId, workspaceId, owner.id])
      await pool.query('INSERT INTO devices(id,"ownerId",name,kind) VALUES($1,$2,\'Task send fixture\',\'local\')', [deviceId, owner.id])
      await pool.query('INSERT INTO agents(id,"userId",name,harness,"deviceId") VALUES($1,$2,$3,\'codex\',$4)',
        [agentId, owner.id, 'Task send ' + runId, deviceId])
      await pool.query('INSERT INTO device_repos(id,"userId","deviceId","repoPath","remoteUrl") VALUES($1,$2,$3,$4,$5)',
        [repoId, owner.id, deviceId, repositoryKey, remote])
      await pool.query(`INSERT INTO device_tokens(id,"userId","tokenHash","expiresAt","boundDeviceId","boundWorkspaceId")
        VALUES($1,$2,$3,now()+interval '1 hour',$4,$5)`, [tokenId, owner.id, digest(randomUUID()), deviceId, workspaceId])
      const admission = admitRepositoryTask({ userId: owner.id, issueId: taskId, deviceId, agentId, remoteKey: repositoryKey,
        remoteUrl: remote, targetBranch: branch, workspaceId, now: new Date() })
      assert.ok(admission)
      await pool.query(`INSERT INTO agent_runs(id,"userId","issueId","botId","agentId","deviceId","deviceRepoId","deviceTokenId",
        status,"worktreePath","leaseExpiresAt","agentDefinition",prompt,kind)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'running',$9,now()+interval '10 minutes',$10,'Implement the original task.','implement')`,
      [runId, owner.id, taskId, botId, agentId, deviceId, repoId, tokenId, worktree,
        { executionIdentity: { workspaceId }, repositoryAdmission: admission }])
      const identity = (await resolveRunWorktree(pool, pool, who, runId, repoId)).identity
      const entry: JournalEntry = { assignment: runAssignmentSchema.parse({ runId, issueId: taskId, repoId, deviceId,
        remoteUrl: remote, baseBranch: 'main', harness: 'codex', prompt: 'Implement the original task.', kind: 'implement' }),
      state: 'running', sessionId: null, worktree, baseCommit: baseSha, lastSeq: 0, error: null, updatedAt: new Date().toISOString() }
      const source: Source = { identity, entry, repository, reads: 0 }; sources.set(runId, source)
      const deps = { database: pool, membership: pool }, scope = await ensureReviewScope(deps, who, runId, repoId)
      const mask = await secretMaskerFor({ workspaceId, ownerId: owner.id })
      let snapshot: DiffSnapshot
      if (options.pr) {
        const token = { token: 'fixture-native-' + randomUUID(), githubAccountId: String(1_000_000 + tokens.size),
          expiresAt: new Date(Date.now() + 3_600_000) }
        tokens.set(owner.id, token)
        await saveGitHubConnection(owner.id, { githubAccountId: token.githubAccountId, githubLogin: 'task-send-fixture' },
          { access_token: token.token, expires_in: 3600 })
        await pool.query(`INSERT INTO run_publications("runId","userId","issueId","remoteUrl","remoteKey",branch,status,"pullRequest")
          VALUES($1,$2,$3,$4,$5,$6,'published',$7)`, [runId, owner.id, taskId, remote, repositoryKey, branch, { url: pullUrl }])
        const tree = (side: 'before' | 'after') => new Map(files.map(file => [file.path,
          { sha: gitBlobHash(file[side], headSha), mode: '100644', size: file[side].length }]))
        for (const file of files) {
          assert.equal(await git(worktree, 'rev-parse', baseSha + ':' + file.path), gitBlobHash(file.before, headSha))
          assert.equal(await git(worktree, 'rev-parse', headSha + ':' + file.path), gitBlobHash(file.after, headSha))
        }
        const metadata = buildGitHubManifest({ repoId, repositoryId, baseSha, headSha, before: tree('before'), after: tree('after'),
          nativeFiles: files.map(file => ({ path: file.path, previousPath: null, status: 'modified', sha: gitBlobHash(file.after, headSha),
            additions: 1, deletions: 1, patchSha256: digest(file.patch), page: 1 })) })
        const sourceAccess = { kind: 'github' as const, repositoryId, pullRequestNumber: pullNumber, pullRequestBaseSha: baseSha, manifestComplete: true as const }
        const revision = manifestRevision('pull_request', baseSha, headSha, null, metadata, sourceAccess), patches = new Map<string, DiffFilePatch>()
        for (const file of metadata) {
          const bytes = files.find(value => value.path === file.path)!
          patches.set(file.path, buildGitHubFilePatch({ snapshotId: randomUUID(), sourceVersion: revision.version, file,
            before: bytes.before, after: bytes.after, nativePatch: bytes.patch }, mask))
        }
        snapshot = await withReviewTransaction(pool, pool, who, runId, repoId, (tx, fresh) => retainDiffSnapshot(tx, fresh,
          { revision, files: metadata, patches, sourceAccess, pullRequest: { number: pullNumber, url: pullUrl, headSha, baseSha, state: 'open' } }, mask))
      } else {
        const captured = await takeCheckpoint({ repoPath: repository, worktree, baseCommit: baseSha, repoId })
        assert.ok(captured)
        const evidence = checkpointReviewEvidence.parse(captured.checkpoint.review)
        assert.equal(evidence.reason, null); assert.ok(evidence.blobs.length > 0)
        const prepared = prepareCheckpointReview(captured.checkpoint, repoId, mask)
        assert.equal(prepared.reason, null)
        snapshot = await withReviewTransaction(pool, pool, who, runId, repoId, async (tx, fresh) => {
          await retainCheckpointReview(tx, fresh, prepared, new Date(captured.checkpoint.takenAt), mask)
          const { rows: [saved] } = await tx.query<{ snapshotId: string; reason: string | null }>(
            'SELECT "snapshotId",reason FROM coding_workspace_checkpoint_reviews WHERE "runId"=$1', [runId])
          assert.ok(saved?.snapshotId); assert.equal(saved.reason, null)
          return readDiffSnapshot(tx, fresh, saved.snapshotId)
        })
      }
      type Inline = { id: string; pull_request_review_id: string; user: { id: string }; pull_request_url: string; body: string;
        path: string; side: string; start_side: string | null; original_line: number; original_start_line: number | null;
        original_commit_id: string; in_reply_to_id: null }
      const state = { throwAfterPost: false, visible: true, mutationStatus: 200,
        mutationBody: { message: 'Fixture mutation refused' } as Record<string, unknown>, pullAuthorId: undefined as string | undefined,
        mutationBodyMode: 'json' as 'json' | 'empty' | 'broken',
        inline: [] as Inline[], receipt: null as Record<string, unknown> | null,
        beforePost: undefined as (() => Promise<void>) | undefined, afterPost: undefined as (() => Promise<void>) | undefined }
      const calls: { method: string; path: string; body?: Record<string, unknown> }[] = []
      context.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
        assert.ok(options.pr, 'a checkpoint without a PR must not attempt any provider HTTP')
        const target = new URL(String(input)), method = init.method ?? 'GET', token = tokens.get(owner.id)!
        assert.equal(target.origin, 'https://api.github.com'); assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit')
        assert.equal(new Headers(init.headers).get('authorization'), 'Bearer ' + token.token)
        const payload = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
        calls.push({ method, path: target.pathname, body: payload })
        if (method === 'GET' && target.pathname === apiPath) return Response.json({ id: repositoryId, full_name: fullName })
        if (method === 'GET' && target.pathname === `${apiPath}/pulls/${pullNumber}`)
          return Response.json({ number: pullNumber, html_url: pullUrl, state: 'open', merged: false, changed_files: files.length,
            ...(state.pullAuthorId ? { user: { id: state.pullAuthorId } } : {}),
            base: { sha: baseSha, repo: { id: repositoryId, full_name: fullName } }, head: { sha: headSha } })
        if (method === 'POST' && target.pathname === `${apiPath}/pulls/${pullNumber}/reviews`) {
          await state.beforePost?.(); assert.ok(payload && Array.isArray(payload.comments))
          if (state.mutationStatus !== 200) {
            if (state.mutationBodyMode === 'empty') return new Response(null, { status: state.mutationStatus })
            if (state.mutationBodyMode === 'broken') return new Response(new ReadableStream<Uint8Array>({
              start(controller) { controller.error(new Error('Fixture provider rejection body interrupted')) },
            }), { status: state.mutationStatus })
            return Response.json(state.mutationBody, { status: state.mutationStatus })
          }
          state.receipt = { id: reviewId, body: payload.body, user: { id: token.githubAccountId },
            html_url: `${pullUrl}#pullrequestreview-${reviewId}`, pull_request_url: `https://api.github.com${apiPath}/pulls/${pullNumber}`,
            commit_id: payload.commit_id, state: 'CHANGES_REQUESTED', submitted_at: new Date().toISOString() }
          assert.equal(payload.event, 'REQUEST_CHANGES')
          state.inline = payload.comments.map((value, index) => {
            const comment = value as { path: string; body: string; side: string; line: number; start_line?: number; start_side?: string }
            return { id: (9007199254741100n + BigInt(index)).toString(), pull_request_review_id: reviewId, user: { id: token.githubAccountId },
              pull_request_url: `https://api.github.com${apiPath}/pulls/${pullNumber}`, body: comment.body, path: comment.path, side: comment.side,
              start_side: comment.start_side ?? null, original_line: comment.line, original_start_line: comment.start_line ?? null,
              original_commit_id: String(payload.commit_id), in_reply_to_id: null }
          })
          await state.afterPost?.()
          if (state.throwAfterPost) throw new DOMException('Fixture lost an accepted provider response', 'TimeoutError')
          return Response.json(state.receipt)
        }
        if (method === 'GET' && target.pathname === `${apiPath}/pulls/${pullNumber}/reviews`)
          return Response.json(state.visible && state.receipt ? [state.receipt] : [])
        if (method === 'GET' && target.pathname === `${apiPath}/pulls/${pullNumber}/comments`) return Response.json(state.inline)
        throw new Error(`Unexpected fixture GitHub operation ${method} ${target.pathname}`)
      })
      const submission = (change: Partial<TaskReviewSubmission> = {}): TaskReviewSubmission => ({ reviewRef: reference(snapshot),
        comments: [{ path: 'alpha.txt', line: 1, side: 'new', body: '保留完整边界；please fix this changed line.' }],
        note: '请结合这条反馈继续原 Task，保留原分支。', attachedChecks: [], idempotencyKey: randomUUID(), ...change })
      const send = async (value: Record<string, unknown>, person = who, selectedTaskId = taskId) => {
        const request = new Request('http://127.0.0.1:3199/api/tasks/' + selectedTaskId + '/review/send', { method: 'POST' })
        const input: TaskReviewHttpInput = { request, actor: person, taskId: selectedTaskId, input: value,
          deps: { ...deps, ...(options.pr ? { external: githubDiffProvider(pool, person.userId, request.signal) } : {}) } }
        const result = await sendTaskReview(input)
        assert.ok(result.context)
        const rendered = await withReviewTransaction(pool, pool, person, result.context.scope.identity.runId, result.context.scope.identity.repoId,
          (tx, fresh) => result.render(tx, fresh))
        const body = rendered.body as SendProjection
        reviewBatchReceipt.parse(body.agent)
        if (body.github) reviewBatchReceipt.parse(body.github)
        return { status: rendered.status ?? result.status ?? 200, body }
      }
      const rows = async () => ({
        comments: (await pool.query<{ id: string; body: string; draft: boolean; anchor: Record<string, unknown> }>(
          'SELECT id,body,draft,anchor FROM coding_workspace_review_comments WHERE "boardId"=$1 ORDER BY id', [scope.boardId])).rows,
        batches: (await pool.query<ReviewBatchRow>('SELECT * FROM coding_workspace_review_batches WHERE "boardId"=$1 ORDER BY id', [scope.boardId])).rows,
        plans: (await pool.query<{ requestId: string; response: Plan }>('SELECT "requestId",response FROM coding_workspace_review_receipts WHERE "boardId"=$1 AND action=\'task_send\' ORDER BY "requestId"', [scope.boardId])).rows,
        receipts: (await pool.query('SELECT * FROM coding_workspace_review_receipts WHERE "boardId"=$1 ORDER BY "requestId"', [scope.boardId])).rows,
        messages: (await pool.query<{ id: string; runId: string; userId: string; text: string; origin: string; mailboxWakeDepth: number }>(
          'SELECT m.* FROM run_messages m JOIN agent_runs r ON r.id=m."runId" WHERE r."issueId"=$1 AND r."userId"=$2 ORDER BY m.id', [taskId, owner.id])).rows,
        children: (await pool.query('SELECT id FROM agent_runs WHERE "issueId"=$1 AND "userId"=$2 AND id<>$3', [taskId, owner.id, runId])).rows,
        operations: (await pool.query('SELECT * FROM operation_ledger WHERE "workspaceId"=$1 ORDER BY "operationId"', [workspaceId])).rows,
        revision: Number((await pool.query('SELECT revision FROM coding_workspace_review_boards WHERE id=$1', [scope.boardId])).rows[0].revision),
      })
      const posts = () => calls.filter(call => call.method === 'POST')
      return { owner, member, workspaceId, who, viewer, taskId, runId, repoId, scope, snapshot, source, state, worktree,
        headSha, submission, send, rows, calls, posts }
    }
    type Fixture = Awaited<ReturnType<typeof fixture>>
    async function noPreparation(f: Fixture) {
      const saved = await f.rows()
      for (const key of ['comments', 'batches', 'plans', 'receipts', 'messages', 'children', 'operations'] as const)
        assert.equal(saved[key].length, 0, key + ' must stay empty')
      assert.equal(saved.revision, 0); assert.equal(f.posts().length, 0)
    }
    async function oneMessage(f: Fixture, result: Awaited<ReturnType<Fixture['send']>>, input: TaskReviewSubmission) {
      assert.equal(result.status, 200); assert.equal(result.body.state, 'sent')
      assert.deepEqual(result.body.reviewRef, input.reviewRef); assert.equal(result.body.attempt, 1)
      assert.equal(result.body.agent.state, 'accepted'); assert.equal(result.body.agent.delivery?.runId, f.runId)
      const saved = await f.rows(), agent = saved.batches.find(row => row.destination === 'agent')!
      assert.equal(saved.messages.length, 1); assert.equal(saved.children.length, 0)
      assert.equal(saved.messages[0]!.id, result.body.messageId)
      assert.equal(result.body.messageId, result.body.agent.delivery?.messageId)
      assert.equal(saved.messages[0]!.runId, f.runId); assert.equal(saved.messages[0]!.userId, f.owner.id)
      assert.equal(saved.messages[0]!.origin, 'owner'); assert.equal(saved.messages[0]!.mailboxWakeDepth, -1)
      assert.equal(saved.messages[0]!.text, agent.input.agent!.text)
      assert.ok(saved.messages[0]!.text.includes(input.note!))
      for (const comment of input.comments) assert.ok(saved.messages[0]!.text.includes(comment.body))
      assert.ok(saved.comments.every(comment => !comment.draft)); assert.ok(f.source.reads >= 1)
    }

    await t.test('one checkpoint comment and note become exactly one real owner message and durable send plan', async t => {
      const f = await fixture(t), input = f.submission(), result = await f.send(input)
      assert.equal(f.snapshot.revision.source, 'checkpoint'); assert.equal(result.body.github, null)
      await oneMessage(f, result, input)
      const saved = await f.rows()
      assert.equal(saved.comments.length, 1); assert.equal(saved.batches.length, 1); assert.equal(saved.plans.length, 1)
      assert.equal(saved.plans[0]!.response.agent.batchId, result.body.agent.batchId)
      assert.equal(saved.plans[0]!.response.github, undefined); assert.equal(saved.operations.length, 0)
      assert.deepEqual(saved.batches[0]!.input.commentIds, [saved.comments[0]!.id])
      assert.deepEqual(saved.comments[0]!.anchor.snapshotId, f.snapshot.id)
      assert.equal(saved.comments[0]!.anchor.sourceVersion, f.snapshot.revision.version)
      assert.equal(saved.comments[0]!.anchor.side, 'RIGHT'); assert.equal(saved.comments[0]!.anchor.lineEnd, 1)
      assert.equal(saved.batches[0]!.input.agent!.note, input.note); assert.equal(f.calls.length, 0)
    })

    await t.test('Task teammates and actual owner PATs cannot send; an expired real session fails before preparation', async t => {
      const f = await fixture(t), input = f.submission(), patId = randomUUID()
      await pool.query(`INSERT INTO personal_access_tokens(id,"userId","workspaceId",name,"tokenHash",hint,"expiresAt")
        VALUES($1,$2,$3,'Task review PAT',$4,'test',now()+interval '1 hour')`, [patId, f.owner.id, f.workspaceId, digest(randomUUID())])
      for (const person of [f.viewer, { ...f.who, credential: { kind: 'pat' as const, id: patId } }])
        await assert.rejects(() => f.send(input, person), error => error instanceof TaskReviewDenied && error.reason === 'not_owner_send')
      await pool.query('UPDATE "session" SET "expiresAt"=now()-interval \'1 second\' WHERE id=$1', [f.owner.sessionId])
      await assert.rejects(() => f.send(input), code('workspace_not_found'))
      await noPreparation(f); assert.equal(f.source.reads, 0)
    })

    await t.test('missing, foreign and mixed-version references never create comments or delivery plans', async t => {
      const f = await fixture(t), input = f.submission(), { reviewRef: _reference, ...missing } = input
      await assert.rejects(() => f.send(missing), z.ZodError)
      await assert.rejects(() => f.send({ ...input, reviewRef: { ...input.reviewRef, snapshotId: randomUUID() } }), code('workspace_not_found'))
      await assert.rejects(() => f.send({ ...input, reviewRef: { ...input.reviewRef, sourceVersion: '0'.repeat(64) } }), code('workspace_snapshot_outdated'))
      await assert.rejects(() => f.send(input, f.who, randomUUID()), code('workspace_not_found'))
      await assert.rejects(() => f.send({ ...input, comments: [{ ...input.comments[0]!, line: 99 }] }), code('workspace_review_anchor_invalid'))
      await noPreparation(f)
    })

    await t.test('exact retries and reordered equal submissions under new keys reuse the same comments, plan and message', async t => {
      const f = await fixture(t), input = f.submission({ comments: [
        { path: 'alpha.txt', line: 1, side: 'new', body: 'Fix alpha.' }, { path: 'beta.txt', line: 1, side: 'new', body: 'Fix beta.' },
      ] }), first = await f.send(input)
      await oneMessage(f, first, input)
      const original = await f.rows(), reads = f.source.reads
      const exact = await f.send(input)
      assert.equal(exact.body.submissionId, first.body.submissionId); assert.equal(exact.body.messageId, first.body.messageId)
      await assert.rejects(() => f.send({ ...input, note: 'Changed payload under the same key.' }), code('workspace_review_conflict'))
      const alias = await f.send({ ...input, comments: [...input.comments].reverse(), idempotencyKey: randomUUID() })
      assert.equal(alias.body.submissionId, first.body.submissionId); assert.equal(alias.body.agent.batchId, first.body.agent.batchId)
      assert.equal(alias.body.messageId, first.body.messageId); assert.equal(f.source.reads, reads)
      const saved = await f.rows()
      assert.deepEqual(saved.comments, original.comments); assert.deepEqual(saved.messages, original.messages)
      assert.equal(saved.batches.length, 1); assert.equal(saved.plans.length, 2)
      assert.ok(saved.plans.every(plan => plan.response.agent.batchId === first.body.agent.batchId))
    })

    await t.test('concurrent equal submissions have one canonical plan, one frozen comment and one real effect', async t => {
      const f = await fixture(t), input = f.submission()
      const outcomes = await Promise.allSettled([f.send(input), f.send({ ...input, idempotencyKey: randomUUID() })])
      for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason
      const results = outcomes.map(outcome => (outcome as PromiseFulfilledResult<Awaited<ReturnType<Fixture['send']>>>).value)
      assert.ok(results.every(result => result.body.state === 'sent'))
      assert.equal(results[0]!.body.submissionId, results[1]!.body.submissionId)
      assert.equal(results[0]!.body.messageId, results[1]!.body.messageId)
      const saved = await f.rows()
      assert.equal(saved.comments.length, 1); assert.equal(saved.batches.length, 1); assert.equal(saved.messages.length, 1)
      assert.equal(saved.plans.length, 2); assert.equal(saved.children.length, 0)
    })

    for (const failure of ['checkpoint-plan', 'github-child', 'github-plan-commit'] as const)
      await t.test(`${failure} SQL failure atomically rolls back comments, parent plan, child batches and receipts`, async t => {
        const f = await fixture(t, { pr: failure !== 'checkpoint-plan' }), input = f.submission()
        const name = 'task_send_fault_' + randomUUID().replaceAll('-', ''), table = failure === 'github-child'
          ? 'coding_workspace_review_batches' : 'coding_workspace_review_receipts'
        const condition = failure === 'github-child' ? "NEW.destination='github'" : "NEW.action='task_send'"
        await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF NEW."boardId"='${f.scope.boardId}' AND ${condition} THEN
            RAISE EXCEPTION 'task_send_prepare_fixture' USING ERRCODE='P0001';
          END IF; RETURN NEW; END $$`)
        await pool.query(failure === 'github-plan-commit'
          ? `CREATE CONSTRAINT TRIGGER ${name} AFTER INSERT ON ${table} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${name}()`
          : `CREATE TRIGGER ${name} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`)
        try { await assert.rejects(() => f.send(input), sqlFault); await noPreparation(f); assert.equal(f.source.reads, 0) }
        finally { await pool.query(`DROP TRIGGER ${name} ON ${table}`); await pool.query(`DROP FUNCTION ${name}()`) }
        await oneMessage(f, await f.send(input), input)
        assert.equal(f.posts().length, failure === 'checkpoint-plan' ? 0 : 1)
      })

    await t.test('both child plans and the full comment are durable before one native REQUEST_CHANGES and one Agent message', async t => {
      const f = await fixture(t, { pr: true }), input = f.submission()
      let observed = false
      f.state.beforePost = async () => {
        const saved = await f.rows()
        assert.equal(saved.plans.length, 1); assert.equal(saved.batches.length, 2); assert.equal(saved.comments.length, 1)
        assert.equal(saved.messages.length, 0); assert.equal(saved.children.length, 0); assert.equal(f.source.reads, 0)
        const plan = saved.plans[0]!.response, agent = saved.batches.find(row => row.destination === 'agent')!, native = saved.batches.find(row => row.destination === 'github')!
        assert.equal(agent.id, plan.agent.batchId); assert.equal(native.id, plan.github!.batchId)
        assert.equal(agent.state, 'prepared'); assert.equal(native.state, 'delivering')
        assert.deepEqual(agent.input.commentIds, native.input.commentIds)
        assert.equal(agent.input.agent!.note, input.note)
        assert.ok(native.input.native?.write.kind === 'github_review')
        assert.equal(native.input.native.write.event, 'REQUEST_CHANGES'); assert.equal(native.input.native.write.note, input.note)
        assert.equal(native.input.native.write.comments[0]!.body, input.comments[0]!.body)
        assert.equal(native.input.native.write.comments[0]!.anchor.sourceVersion, input.reviewRef.sourceVersion)
        observed = true
      }
      const result = await f.send(input)
      assert.equal(observed, true); await oneMessage(f, result, input)
      assert.equal(result.body.github?.state, 'accepted'); assert.equal(result.body.github!.delivery?.id, reviewId)
      assert.equal(f.posts().length, 1); assert.equal(f.posts()[0]!.body!.commit_id, f.headSha)
      assert.equal(f.posts()[0]!.body!.event, 'REQUEST_CHANGES')
      const again = await f.send({ ...input, idempotencyKey: randomUUID() })
      assert.equal(again.body.messageId, result.body.messageId); assert.equal(f.posts().length, 1)
      assert.equal((await f.rows()).messages.length, 1)
    })

    await t.test('unknown native outcome holds the Agent and explicit positive reconciliation resumes it without a second POST', async t => {
      const f = await fixture(t, { pr: true }), input = f.submission()
      f.state.throwAfterPost = true; f.state.visible = false
      const pending = await f.send(input)
      assert.equal(pending.status, 202); assert.equal(pending.body.state, 'pending')
      assert.equal(pending.body.github?.state, 'uncertain'); assert.equal(pending.body.agent.state, 'prepared')
      assert.equal(f.posts().length, 1); assert.equal(f.source.reads, 0)
      for (const value of [input, { ...input, idempotencyKey: randomUUID() }]) {
        const again = await f.send(value)
        assert.equal(again.body.submissionId, pending.body.submissionId); assert.equal(again.body.state, 'pending')
      }
      assert.equal((await f.rows()).messages.length, 0); assert.equal((await f.rows()).children.length, 0)
      assert.equal(f.posts().length, 1); assert.equal(f.source.reads, 0)
      f.state.visible = true; f.state.throwAfterPost = false
      const recovered = await f.send(input)
      await oneMessage(f, recovered, input)
      assert.equal(recovered.body.github?.state, 'accepted'); assert.equal(recovered.body.submissionId, pending.body.submissionId)
      assert.equal(f.posts().length, 1)
      assert.equal((await f.send(input)).body.messageId, recovered.body.messageId)
      assert.equal((await f.rows()).messages.length, 1)
    })

    await t.test('an explicit native mutation rejection is projected honestly and never starts the prepared Agent', async t => {
      const f = await fixture(t, { pr: true }), input = f.submission()
      f.state.mutationStatus = 403
      const rejected = await f.send(input)
      assert.equal(rejected.status, 403); assert.equal(rejected.body.state, 'rejected')
      assert.equal(rejected.body.error, 'github_permission'); assert.equal(rejected.body.reason, 'github_permission')
      assert.equal(rejected.body.github?.state, 'rejected'); assert.equal(rejected.body.agent.state, 'prepared')
      assert.equal(rejected.body.messageId, undefined); assert.equal(rejected.body.attempt, undefined)
      assert.equal(f.posts().length, 1); assert.equal(f.source.reads, 0)
      const again = await f.send(input)
      assert.equal(again.body.submissionId, rejected.body.submissionId); assert.equal(again.body.state, 'rejected')
      assert.equal(again.status, 403); assert.equal(again.body.error, 'github_permission'); assert.equal(again.body.reason, 'github_permission')
      const saved = await f.rows()
      assert.equal(saved.messages.length, 0); assert.equal(saved.children.length, 0)
      assert.equal(saved.operations.length, 1); assert.equal(saved.operations[0]!.status, 'failed')
      assert.equal(f.posts().length, 1); assert.equal(f.source.reads, 0)
    })

    await t.test('self-authored REQUEST_CHANGES receives a terminal 422 refusal and replay never posts again or starts the Agent', async t => {
      for (const mode of ['json', 'empty', 'broken'] as const) await t.test(mode, async t => {
        const f = await fixture(t, { pr: true }), input = f.submission()
        const message = 'Can not request changes on your own pull request'
        f.state.pullAuthorId = tokens.get(f.owner.id)!.githubAccountId
        f.state.mutationStatus = 422
        f.state.mutationBodyMode = mode
        f.state.mutationBody = { message: 'Validation Failed', errors: [{ resource: 'PullRequestReview', code: 'custom', message }],
          documentation_url: 'https://docs.github.com/rest/pulls/reviews#create-a-review-for-a-pull-request', status: '422' }
        const rejected = await f.send(input)
        assert.equal(rejected.status, 409); assert.equal(rejected.body.state, 'rejected')
        assert.equal(rejected.body.error, 'workspace_review_github_unavailable')
        assert.equal(rejected.body.github?.state, 'rejected'); assert.equal(rejected.body.github?.reason, 'target_unavailable')
        assert.equal(rejected.body.github?.delivery, null); assert.equal(rejected.body.agent.state, 'prepared')
        assert.equal(rejected.body.messageId, undefined); assert.equal(rejected.body.attempt, undefined)
        assert.equal(f.posts().length, 1); assert.equal(f.posts()[0]!.body!.event, 'REQUEST_CHANGES')
        assert.equal(f.posts()[0]!.body!.commit_id, f.headSha); assert.equal(f.source.reads, 0)
        assert.equal(f.state.receipt, null); assert.equal(f.state.inline.length, 0)
        const again = await f.send(input)
        assert.equal(again.status, 409); assert.equal(again.body.state, 'rejected')
        assert.equal(again.body.submissionId, rejected.body.submissionId)
        assert.equal(again.body.github?.batchId, rejected.body.github!.batchId)
        assert.equal(again.body.github?.state, 'rejected'); assert.equal(again.body.github?.reason, 'target_unavailable')
        assert.equal(again.body.agent.batchId, rejected.body.agent.batchId); assert.equal(again.body.agent.state, 'prepared')
        assert.equal(again.body.messageId, undefined); assert.equal(again.body.attempt, undefined)
        assert.ok(!JSON.stringify([rejected.body, again.body]).includes(message), 'the raw provider error body is never projected')
        const saved = await f.rows()
        assert.equal(saved.comments.length, 1); assert.equal(saved.plans.length, 1); assert.equal(saved.batches.length, 2)
        assert.equal(saved.batches.find(row => row.destination === 'github')!.state, 'rejected')
        assert.equal(saved.batches.find(row => row.destination === 'agent')!.state, 'prepared')
        assert.equal(saved.operations.length, 1); assert.equal(saved.operations[0]!.status, 'failed')
        assert.equal(saved.operations[0]!.receipt, null)
        assert.equal(saved.messages.length, 0); assert.equal(saved.children.length, 0)
        assert.equal(f.posts().length, 1); assert.equal(f.source.reads, 0)
      })
    })

    await t.test('native acceptance followed by actual worktree drift produces durable partial success without sending the Agent', async t => {
      const f = await fixture(t, { pr: true }), input = f.submission()
      f.state.afterPost = () => writeFile(join(f.worktree, 'alpha.txt'), 'a different source after native acceptance\nstable\n')
      const partial = await f.send(input)
      assert.equal(partial.status, 409); assert.equal(partial.body.state, 'partial')
      assert.equal(partial.body.github?.state, 'accepted'); assert.equal(partial.body.agent.state, 'rejected')
      assert.equal(partial.body.agent.reason, 'source_changed'); assert.equal(partial.body.messageId, undefined)
      assert.equal(partial.body.attempt, undefined); assert.equal(f.posts().length, 1); assert.equal(f.source.reads, 1)
      for (const value of [input, { ...input, idempotencyKey: randomUUID() }]) {
        const again = await f.send(value)
        assert.equal(again.body.state, 'partial'); assert.equal(again.body.submissionId, partial.body.submissionId)
        assert.equal(again.body.github?.batchId, partial.body.github!.batchId)
      }
      const saved = await f.rows()
      assert.equal(saved.messages.length, 0); assert.equal(saved.children.length, 0); assert.equal(saved.batches.length, 2)
      assert.equal(saved.operations.length, 1); assert.equal(saved.operations[0]!.status, 'succeeded')
      assert.equal(f.posts().length, 1); assert.equal(f.source.reads, 1)
    })
  } finally {
    mock.restoreAll()
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
    await dropTestDatabase(admin, database, pool, appPool, workspacePool)
    await admin.end()
    await rm(directory, { recursive: true, force: true })
  }
})
