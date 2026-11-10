import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import test, { mock, type TestContext } from 'node:test'
import { Pool } from 'pg'
import { z } from 'zod'
import { CodingWorkspaceError } from '@mikka/protocol/coding-workspace'
import { WorkspaceReviewError, type DiffFilePatch, type TaskReviewRef } from '@mikka/protocol/coding-workspace-review'
import { orderMigrations } from '../../../scripts/migration-order.mjs'
import { disposableDatabase, E2E_DB_RULE } from '../../../tests/helpers/e2e-target.mjs'
import { dropTestDatabase } from '../../../tests/support/drop-test-database'
import { GitHubAccessError } from '../../github/user-access-error'
import type { RequestBudget } from '../../request-budget'
import type { FactoryTask } from '../../factory/store'
import type { ReviewActor } from '../diff/authority'
import type { TaskReviewHttpInput } from './http'

const url = process.env.E2E_DATABASE_URL
if (url) assert.ok(disposableDatabase(process.env, url), E2E_DB_RULE)
else if (process.env.REQUIRE_DB === '1') assert.fail('REQUIRE_DB=1 needs an isolated E2E_DATABASE_URL')
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const code = (expected: string) => (error: unknown) =>
  (error instanceof CodingWorkspaceError || error instanceof WorkspaceReviewError) && error.code === expected
const fullName = 'mikka-fixtures/task-review-merge', repositoryKey = 'v2/github.com/' + fullName
const remote = `https://github.com/${fullName}.git`, repositoryId = '61393725', apiPath = '/repos/' + fullName
const number = 7, pullUrl = `https://github.com/${fullName}/pull/${number}`
const baseSha = 'a'.repeat(40), headSha = 'b'.repeat(40), mergeSha = 'c'.repeat(40), otherHeadSha = 'd'.repeat(40)
type Projection = { state: string; reviewRef: TaskReviewRef; mergeId?: string; merged?: boolean; reviewedHeadMerged?: boolean;
  expectedHeadSha?: string; actualHeadSha?: string | null; mergeCommitSha?: string | null; pullRequestUrl?: string;
  checksFingerprint?: string; failing?: number; error?: string; reason?: string }
type MergeRow = { id: string; taskId: string; candidateId: string; eventId: string; sha: string; status: string;
  headSha: string | null; mergeCommitSha: string | null; code: string | null }

/** All database migrations, human authority, frozen source, Factory store,
 * approval evidence/gates and merge receipts are real. Three completed Run
 * records model independent execute/review/verify evidence; they are fixtures,
 * not claimed CLI executions. Only upstream GitHub credentials and HTTP are
 * controlled; no fake Factory store, approval gate or merge success is used. */
test('Task review merge uses the real Factory receipt and exact source on PostgreSQL 17', { skip: !url, timeout: 240_000 }, async t => {
  const admin = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000 })
  const database = 'task_review_merge_' + randomUUID().replaceAll('-', '') + '_e2e'
  const version = Number((await admin.query('SHOW server_version_num')).rows[0].server_version_num)
  assert.ok(version >= 170000 && version < 180000, 'Task review merge acceptance requires PostgreSQL 17')
  await admin.query('CREATE DATABASE "' + database + '" TEMPLATE template0')
  const target = new URL(url!); target.pathname = '/' + database
  const pool = new Pool({ connectionString: target.toString(), max: 16, connectionTimeoutMillis: 5000 })
  const environment = { MIKKA_DATABASE_URL: target.toString(), DATABASE_URL: target.toString(), ORVILO_DATABASE_URL: target.toString(),
    E2E_DATABASE_URL: target.toString(), BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
    BETTER_AUTH_URL: 'http://127.0.0.1:3199', WORKSPACE_SECRETS_KEY: randomBytes(32).toString('hex'),
    GITHUB_CLIENT_ID: 'fixture-client', GITHUB_CLIENT_SECRET: 'fixture-client-secret' }
  const previous = Object.fromEntries(Object.keys(environment).map(name => [name, process.env[name]]))
  Object.assign(process.env, environment)
  let appPool: Pool | undefined, workspacePool: Pool | undefined
  const tokens = new Map<string, { token: string; githubAccountId: string; expiresAt: Date }>()
  const deniedCredentials = new Set<string>(), credentialReads: string[] = []
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
    const userAccess = await import('../../github/user-access')
    mock.module(new URL('../../github/user-access.ts', import.meta.url).href, { namedExports: { ...userAccess,
      githubTokenForUser: async (userId: string, options: { minValidityMs?: number; budget?: RequestBudget } = {}) => {
        credentialReads.push(userId)
        if (deniedCredentials.has(userId)) throw new GitHubAccessError('githubReconnectRequired', 401)
        const token = tokens.get(userId)
        assert.ok(token, 'merge must acquire the actual owner user credential')
        assert.equal(options.minValidityMs, 60_000); assert.ok(options.budget && options.budget.deadline > Date.now())
        return token
      },
    } })
    const { saveGitHubConnection } = await import('../../github/connection')
    const { factoryHumanStore } = await import('../../factory/server')
    const { approvalEvidence } = await import('../../factory/evidence')
    const { ensureReviewScope } = await import('../diff/service')
    const { withReviewTransaction } = await import('../diff/authority')
    const { retainDiffSnapshot, manifestRevision } = await import('../diff/store')
    const { buildGitHubManifest } = await import('../diff/github-manifest')
    const { buildGitHubFilePatch } = await import('../diff/github-patch')
    const { gitBlobHash } = await import('../diff/patch')
    const { secretMaskerFor } = await import('../../secrets/runtime')
    const { mergeTaskReview, taskReviewMergeRequest } = await import('./merge')
    const { TaskReviewDenied } = await import('./http')
    appPool = (await import('../../db')).pool; workspacePool = (await import('../../workspace-db')).workspacePool
    type MergeInput = z.infer<typeof taskReviewMergeRequest>
    async function user() {
      const id = 'task-merge-' + randomUUID(), sessionId = randomUUID()
      await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())',
        [id, id + '@example.invalid'])
      await pool.query('INSERT INTO "session"(id,token,"userId","expiresAt","createdAt","updatedAt") VALUES($1,$2,$3,now()+interval \'1 hour\',now(),now())',
        [sessionId, randomUUID(), id])
      return { id, sessionId }
    }
    type User = Awaited<ReturnType<typeof user>>
    const actor = (person: User, workspaceId: string): ReviewActor => ({ userId: person.id, workspaceId,
      credential: { kind: 'session', id: person.sessionId } })
    async function fixture(context: TestContext) {
      const owner = await user(), member = await user(), workspaceId = randomUUID(), teamId = randomUUID()
      await pool.query('INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,$2,\'Task merge fixture\')', [workspaceId, owner.id])
      for (const person of [owner, member]) await pool.query(`INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status)
        VALUES($1,$2,$2,$3,$4,'active')`, [workspaceId, person.id, person.id + '@example.invalid', person === owner ? 'admin' : 'member'])
      await pool.query('INSERT INTO mikka_teams(id,"workspaceId","userId",name,identifier) VALUES($1,$2,$3,\'Task merge fixture\',$4)',
        [teamId, workspaceId, owner.id, 'M' + randomUUID().replaceAll('-', '').slice(0, 7).toUpperCase()])
      await pool.query('INSERT INTO mikka_team_members("teamId","userId",role) VALUES($1,$2,\'owner\')', [teamId, owner.id])
      const who = actor(owner, workspaceId), viewer = actor(member, workspaceId), issueId = randomUUID(), taskId = randomUUID(),
        deviceId = randomUUID(), repoId = randomUUID(), agentId = randomUUID(), sourceEventId = randomUUID(),
        candidateId = randomUUID(), approvalId = randomUUID()
      await pool.query('INSERT INTO issues(id,"userId","workspaceId",title,content,status,priority,scope) VALUES($1,$2,$3,\'Task merge\',\'{"type":"doc","content":[]}\',\'review\',\'normal\',\'workspace\')', [issueId, owner.id, workspaceId])
      await pool.query('INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId") VALUES($1,$2,$3,$4)', [issueId, teamId, workspaceId, owner.id])
      await pool.query('INSERT INTO devices(id,"ownerId",name,kind) VALUES($1,$2,\'Task merge fixture\',\'local\')', [deviceId, owner.id])
      await pool.query('INSERT INTO agents(id,"userId",name,harness,"deviceId") VALUES($1,$2,$3,\'codex\',$4)',
        [agentId, owner.id, 'Task merge ' + issueId, deviceId])
      await pool.query('INSERT INTO device_repos(id,"userId","deviceId","repoPath","remoteUrl") VALUES($1,$2,$3,$4,$5)',
        [repoId, owner.id, deviceId, repositoryKey, remote])
      async function completedRun(stage: string, sha = headSha) {
        const id = randomUUID(), sessionId = 'fixture-native-' + randomUUID()
        const report = stage === 'execute' ? { sourceCommit: baseSha, publish: { commit: sha, pushed: true },
          verify: { status: 'passed' }, summary: 'Completed repository candidate.' } : { summary: 'Independent ' + stage + ' passed.' }
        const { rows: [row] } = await pool.query<{ finishedAt: Date }>(`INSERT INTO agent_runs
          (id,"userId","issueId","agentId","deviceId","deviceRepoId",status,"sessionId","startedAt","finishedAt","stopReason",report,"agentDefinition")
          VALUES($1,$2,$3,$4,$5,$6,'succeeded',$7,clock_timestamp()-interval '1 minute',clock_timestamp()-interval '30 seconds','submitted',$8,$9)
          RETURNING "finishedAt"`, [id, owner.id, issueId, agentId, deviceId, repoId, sessionId, report,
          { executionIdentity: { workspaceId }, repositoryAdmission: { workspaceId, remoteKey: repositoryKey } }])
        return { id, sessionId, recordedAt: new Date(row!.finishedAt.getTime() + 1000).toISOString() }
      }
      const producer = await completedRun('execute'), reviewer = await completedRun('review'), verifier = await completedRun('verify')
      const tx = await pool.connect()
      try {
        await tx.query('BEGIN')
        await tx.query('INSERT INTO coordinator_events(id,"userId","issueId",kind,"dedupeKey",payload) VALUES($1::uuid,$2,$3,\'user_message\',$1::text,$4)',
          [sourceEventId, owner.id, issueId, { text: 'Review and merge the exact candidate.' }])
        await tx.query(`INSERT INTO factory_tasks(id,"userId","issueId","sourceEventId",route,stage,status,revision,"attemptId",reason,"scopeVersion")
          VALUES($1,$2,$3,$4,$5,'approval','waiting',7,$6,'Awaiting owner acceptance',1)`,
        [taskId, owner.id, issueId, sourceEventId, { issueId, eventId: randomUUID(), sourceEventId,
          rationale: 'Fixture existing repository flow', missingInformation: [], missingPermissions: [], needsSpec: false }, approvalId])
        await tx.query(`INSERT INTO factory_candidates(id,"taskId",sha,repository,environment,scope,"runId",kind)
          VALUES($1,$2,$3,$4,'preview','Task merge fixture',$5,'repository')`, [candidateId, taskId, headSha, fullName, producer.id])
        for (const [position, stage, run] of [[1, 'execute', producer], [2, 'review', reviewer], [3, 'verify', verifier]] as const) {
          const evidence = { artifact: 'run-report:' + run.id, kind: 'report', runId: run.id, sessionId: run.sessionId,
            candidateId, sha: headSha, environment: 'preview', recordedAt: run.recordedAt }
          await tx.query(`INSERT INTO factory_attempts(id,"taskId",stage,ordinal,position,status,"candidateId","runId","sessionId",reason,evidence,output,"finishedAt")
            VALUES($1,$2,$3,1,$4,'passed',$5,$6,$7,'Completed independent fixture',$8,'{}',now())`,
          [randomUUID(), taskId, stage, position, candidateId, run.id, run.sessionId, JSON.stringify([evidence])])
        }
        await tx.query(`INSERT INTO factory_attempts(id,"taskId",stage,ordinal,position,status,"candidateId",reason)
          VALUES($1,$2,'approval',1,4,'waiting',$3,'Awaiting owner acceptance')`, [approvalId, taskId, candidateId])
        await tx.query('UPDATE factory_tasks SET "candidateId"=$2 WHERE id=$1', [taskId, candidateId])
        await tx.query('COMMIT')
      } catch (error) { await tx.query('ROLLBACK'); throw error } finally { tx.release() }
      const proof = await pool.connect()
      try {
        await proof.query('BEGIN')
        const task = await factoryHumanStore.lockTask(proof, owner.id, taskId)
        assert.equal((await approvalEvidence(proof, task)).evidence.length, 3, 'real independent artifacts satisfy the production approval evidence reader')
        await proof.query('ROLLBACK')
      } catch (error) { await proof.query('ROLLBACK'); throw error } finally { proof.release() }
      const token = { token: 'fixture-merge-' + randomUUID(), githubAccountId: String(1_000_000 + tokens.size),
        expiresAt: new Date(Date.now() + 3_600_000) }
      tokens.set(owner.id, token)
      await saveGitHubConnection(owner.id, { githubAccountId: token.githubAccountId, githubLogin: 'merge-fixture' },
        { access_token: token.token, expires_in: 3600 })
      await pool.query(`INSERT INTO run_publications("runId","userId","issueId","remoteUrl","remoteKey",branch,status,"pullRequest")
        VALUES($1,$2,$3,$4,$5,'mikka/original-task','published',$6)`, [producer.id, owner.id, issueId, remote, repositoryKey, { url: pullUrl }])
      const deps = { database: pool, membership: pool }, scope = await ensureReviewScope(deps, who, producer.id, repoId)
      const before = Buffer.from('before\nstable\n'), after = Buffer.from('after\nstable\n'), nativePatch = '@@ -1,2 +1,2 @@\n-before\n+after\n stable\n'
      const tree = (bytes: Buffer) => new Map([['alpha.txt', { sha: gitBlobHash(bytes, headSha), mode: '100644', size: bytes.length }]])
      const files = buildGitHubManifest({ repoId, repositoryId, baseSha, headSha, before: tree(before), after: tree(after), nativeFiles: [{
        path: 'alpha.txt', previousPath: null, status: 'modified', sha: gitBlobHash(after, headSha), additions: 1, deletions: 1, patchSha256: digest(nativePatch), page: 1,
      }] })
      const sourceAccess = { kind: 'github' as const, repositoryId, pullRequestNumber: number, pullRequestBaseSha: baseSha, manifestComplete: true as const }
      const revision = manifestRevision('pull_request', baseSha, headSha, null, files, sourceAccess)
      const mask = await secretMaskerFor({ workspaceId, ownerId: owner.id }), patches = new Map<string, DiffFilePatch>()
      patches.set('alpha.txt', buildGitHubFilePatch({ snapshotId: randomUUID(), sourceVersion: revision.version,
        file: files[0]!, before, after, nativePatch }, mask))
      const snapshot = await withReviewTransaction(pool, pool, who, producer.id, repoId, (client, fresh) => retainDiffSnapshot(client, fresh, {
        revision, files, patches, sourceAccess, pullRequest: { number, url: pullUrl, baseSha, headSha, state: 'open' },
        factory: { taskId, candidateId, producerRunId: producer.id, sha: headSha },
      }, mask))
      const binding = { taskId, issueId, candidateId, attemptId: approvalId, revision: 7 }
      const state = { head: headSha, merged: false, mergeCommit: null as string | null,
        check: 'passed' as 'passed' | 'failed' | 'pending', checkLog: 'The selected commit was checked.',
        putMode: 'success' as 'success' | 'timeout' | 'http503' | 'forbidden', putReached: false,
        beforePut: undefined as (() => Promise<void>) | undefined, onPull: undefined as (() => Promise<void>) | undefined,
        onChecks: undefined as (() => Promise<void>) | undefined }
      const calls: { method: string; path: string; body?: Record<string, unknown> }[] = []
      context.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const target = new URL(String(input)), method = init.method ?? 'GET'
        assert.equal(target.origin, 'https://api.github.com'); assert.equal(init.redirect, 'error')
        assert.equal(new Headers(init.headers).get('authorization'), 'Bearer ' + token.token)
        const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
        calls.push({ method, path: target.pathname, body })
        if (method === 'GET' && target.pathname === apiPath) return Response.json({ id: repositoryId, full_name: fullName,
          allow_merge_commit: false, allow_squash_merge: true, allow_rebase_merge: false })
        if (method === 'GET' && target.pathname === `${apiPath}/pulls/${number}`) {
          await state.onPull?.()
          return Response.json({ number, html_url: pullUrl, state: state.merged ? 'closed' : 'open', merged: state.merged,
            changed_files: 1, base: { sha: baseSha, repo: { id: repositoryId, full_name: fullName } }, head: { sha: state.head },
            mergeable_state: 'clean', merge_commit_sha: state.mergeCommit })
        }
        const commit = `${apiPath}/commits/${headSha}`
        if (method === 'GET' && target.pathname === commit + '/check-suites') {
          await state.onChecks?.()
          return Response.json({ total_count: 1 })
        }
        if (method === 'GET' && target.pathname === commit + '/check-runs') return Response.json({ total_count: 1, check_runs: [{
          id: '9007199254741001', head_sha: headSha, name: 'Build exact candidate', status: state.check === 'pending' ? 'in_progress' : 'completed',
          conclusion: state.check === 'pending' ? null : state.check === 'passed' ? 'success' : 'failure',
          completed_at: state.check === 'pending' ? null : '2026-11-08T10:00:00Z', output: { title: 'Build result', summary: state.checkLog, text: null },
        }] })
        if (method === 'GET' && target.pathname === commit + '/status') return Response.json({ sha: headSha, total_count: 0,
          repository: { id: repositoryId, full_name: fullName }, statuses: [] })
        if (method === 'PUT' && target.pathname === `${apiPath}/pulls/${number}/merge`) {
          state.putReached = true; await state.beforePut?.()
          assert.deepEqual(body, { sha: headSha, merge_method: 'squash' })
          if (state.putMode === 'timeout') throw new DOMException('Fixture lost the native merge response', 'TimeoutError')
          if (state.putMode === 'http503') return Response.json({ message: 'Fixture provider unavailable' }, { status: 503 })
          if (state.putMode === 'forbidden') return Response.json({ message: 'Fixture permission refused' }, { status: 403 })
          state.merged = true; state.mergeCommit = mergeSha
          return Response.json({ merged: true, sha: mergeSha })
        }
        throw new Error(`Unexpected fixture GitHub operation ${method} ${target.pathname}`)
      })
      const input = (change: Partial<MergeInput> = {}): MergeInput => ({ reviewRef: { snapshotId: snapshot.id, sourceVersion: snapshot.revision.version },
        binding, expectedHeadSha: headSha, idempotencyKey: randomUUID(), confirmFailedChecks: false, ...change })
      const merge = async (value: Record<string, unknown>, person = who) => {
        const request: TaskReviewHttpInput = { request: new Request(`http://127.0.0.1:3199/api/tasks/${issueId}/review/merge`, { method: 'POST' }),
          deps, actor: person, taskId: issueId, input: value }
        const result = await mergeTaskReview(request)
        assert.ok(result.context)
        const rendered = await withReviewTransaction(pool, pool, person, result.context.scope.identity.runId, result.context.scope.identity.repoId,
          (client, fresh) => result.render(client, fresh))
        return { status: rendered.status ?? result.status ?? 200, body: rendered.body as Projection }
      }
      const rows = async () => ({
        merges: (await pool.query<MergeRow>('SELECT * FROM factory_merges WHERE "taskId"=$1 ORDER BY "createdAt",id', [taskId])).rows,
        receipts: (await pool.query<{ requestId: string; response: { eventId: string } }>(
          'SELECT "requestId",response FROM coding_workspace_review_receipts WHERE "boardId"=$1 AND action=\'task_merge\' ORDER BY "requestId"', [scope.boardId])).rows,
        task: (await pool.query<FactoryTask>('SELECT * FROM factory_tasks WHERE id=$1', [taskId])).rows[0]!,
        attempts: (await pool.query('SELECT * FROM factory_attempts WHERE "taskId"=$1 ORDER BY position', [taskId])).rows,
        events: (await pool.query('SELECT * FROM factory_events WHERE "taskId"=$1 ORDER BY "eventId"', [taskId])).rows,
      })
      const puts = () => calls.filter(call => call.method === 'PUT')
      async function replaceCandidate() {
        const run = await completedRun('execute', otherHeadSha), nextCandidate = randomUUID(), attemptId = randomUUID()
        const client = await pool.connect()
        try {
          await client.query('BEGIN')
          await client.query(`INSERT INTO factory_candidates(id,"taskId",sha,repository,environment,scope,"runId",kind)
            VALUES($1,$2,$3,$4,'preview','Later candidate fixture',$5,'repository')`, [nextCandidate, taskId, otherHeadSha, fullName, run.id])
          await client.query(`INSERT INTO factory_attempts(id,"taskId",stage,ordinal,position,status,"candidateId",reason)
            SELECT $1::uuid,$2::uuid,'approval',coalesce(max(ordinal) FILTER (WHERE stage='approval'),0)+1,max(position)+1,'waiting',$3::uuid,'Later candidate'
            FROM factory_attempts WHERE "taskId"=$2::uuid`, [attemptId, taskId, nextCandidate])
          await client.query('UPDATE factory_tasks SET "candidateId"=$2,"attemptId"=$3,revision=revision+1,stage=\'approval\',status=\'waiting\' WHERE id=$1',
            [taskId, nextCandidate, attemptId])
          await client.query('COMMIT')
        } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
        return { candidateId: nextCandidate, runId: run.id, attemptId }
      }
      return { owner, member, workspaceId, who, viewer, issueId, taskId, candidateId, approvalId, runId: producer.id,
        repoId, scope, snapshot, binding, state, calls, puts, input, merge, rows, replaceCandidate }
    }
    type Fixture = Awaited<ReturnType<typeof fixture>>
    async function unclaimed(f: Fixture) {
      const saved = await f.rows()
      assert.equal(saved.merges.length, 0); assert.equal(saved.receipts.length, 0); assert.equal(saved.events.length, 0)
      assert.equal(saved.task.stage, 'approval'); assert.equal(saved.task.status, 'waiting'); assert.equal(f.puts().length, 0)
    }
    async function merged(f: Fixture, result: Awaited<ReturnType<Fixture['merge']>>) {
      assert.equal(result.status, 200); assert.equal(result.body.state, 'merged')
      assert.equal(result.body.merged, true); assert.equal(result.body.reviewedHeadMerged, true)
      assert.equal(result.body.expectedHeadSha, headSha); assert.equal(result.body.actualHeadSha, headSha)
      assert.equal(result.body.mergeCommitSha, mergeSha); assert.equal(result.body.pullRequestUrl, pullUrl)
      assert.deepEqual(result.body.reviewRef, f.input().reviewRef)
      const saved = await f.rows()
      assert.equal(saved.merges.length, 1); assert.equal(saved.merges[0]!.id, result.body.mergeId)
      assert.equal(saved.merges[0]!.status, 'merged'); assert.equal(saved.merges[0]!.sha, headSha)
      assert.equal(saved.task.stage, 'publish'); assert.equal(saved.task.status, 'passed')
      assert.equal(saved.attempts.find(attempt => attempt.id === f.approvalId)!.status, 'passed')
      assert.equal(saved.attempts.at(-1)!.stage, 'publish'); assert.equal(saved.attempts.at(-1)!.status, 'passed')
      assert.equal(saved.events.length, 3, 'the real Factory store finished approval, advanced and finished publication')
    }

    // Each case calls the production facade and renders under a fresh real
    // authority transaction. No database service is replaced with a stub.
    await t.test('the exact Factory claim and Task receipt commit before the only PUT; real approval and publish gates complete', async t => {
      const f = await fixture(t), input = f.input()
      let observed = false
      f.state.beforePut = async () => {
        // A separate connection can see these rows only after claim COMMIT.
        const saved = await f.rows()
        assert.equal(saved.merges.length, 1); assert.equal(saved.receipts.length, 1)
        assert.equal(saved.merges[0]!.status, 'merging'); assert.equal(saved.merges[0]!.sha, headSha)
        assert.equal(saved.merges[0]!.candidateId, f.candidateId)
        assert.equal(saved.receipts[0]!.requestId, saved.merges[0]!.eventId)
        assert.equal(saved.receipts[0]!.response.eventId, saved.merges[0]!.eventId)
        assert.equal(saved.task.stage, 'approval'); assert.equal(saved.task.status, 'waiting')
        assert.equal(saved.events.length, 0); observed = true
      }
      const result = await f.merge(input)
      assert.equal(observed, true); await merged(f, result); assert.equal(f.puts().length, 1)
      assert.equal((await f.merge(input)).body.mergeId, result.body.mergeId)
      const alias = await f.merge({ ...input, idempotencyKey: randomUUID() })
      assert.equal(alias.body.mergeId, result.body.mergeId); assert.equal(alias.body.reviewedHeadMerged, true)
      assert.equal(f.puts().length, 1); assert.equal((await f.rows()).receipts.length, 2)
    })

    await t.test('only the owner human session may merge, regardless of Task visibility or a valid owner PAT', async t => {
      const f = await fixture(t), input = f.input(), patId = randomUUID()
      await pool.query(`INSERT INTO personal_access_tokens(id,"userId","workspaceId",name,"tokenHash",hint,"expiresAt")
        VALUES($1,$2,$3,'Task merge PAT',$4,'test',now()+interval '1 hour')`, [patId, f.owner.id, f.workspaceId, digest(randomUUID())])
      for (const person of [f.viewer, { ...f.who, credential: { kind: 'pat' as const, id: patId } }])
        await assert.rejects(() => f.merge(input, person), error => error instanceof TaskReviewDenied && error.reason === 'not_owner_merge')
      await pool.query('UPDATE "session" SET "expiresAt"=now()-interval \'1 second\' WHERE id=$1', [f.owner.sessionId])
      await assert.rejects(() => f.merge(input), code('workspace_not_found'))
      await unclaimed(f); assert.equal(f.calls.length, 0); assert.ok(!credentialReads.includes(f.owner.id))
    })

    await t.test('snapshot, source version, candidate and expected HEAD must all match the selected immutable review', async t => {
      const f = await fixture(t), input = f.input(), { reviewRef: _reference, ...missing } = input
      await assert.rejects(() => f.merge(missing), z.ZodError)
      await assert.rejects(() => f.merge({ ...input, reviewRef: { ...input.reviewRef, snapshotId: randomUUID() } }), code('workspace_not_found'))
      await assert.rejects(() => f.merge({ ...input, reviewRef: { ...input.reviewRef, sourceVersion: '0'.repeat(64) } }), code('workspace_snapshot_outdated'))
      await assert.rejects(() => f.merge({ ...input, expectedHeadSha: otherHeadSha }), code('workspace_snapshot_outdated'))
      for (const field of ['taskId', 'issueId', 'candidateId'] as const)
        await assert.rejects(() => f.merge({ ...input, binding: { ...input.binding, [field]: randomUUID() } }), code('workspace_snapshot_outdated'))
      for (const binding of [{ ...input.binding, revision: input.binding.revision + 1 }, { ...input.binding, attemptId: randomUUID() }])
        await assert.rejects(() => f.merge({ ...input, binding }), code('workspace_review_conflict'))
      await unclaimed(f)
    })

    await t.test('failed checks require the exact observed fingerprint and cannot be confirmed with a bare boolean', async t => {
      const f = await fixture(t), input = f.input(); f.state.check = 'failed'
      const needs = await f.merge(input)
      assert.equal(needs.status, 409); assert.equal(needs.body.state, 'needs_confirm'); assert.equal(needs.body.error, 'needs_confirm')
      assert.equal(needs.body.failing, 1); assert.match(needs.body.checksFingerprint!, /^[a-f0-9]{64}$/)
      await unclaimed(f)
      await assert.rejects(() => f.merge({ ...input, confirmFailedChecks: true }), z.ZodError)
      const wrong = await f.merge({ ...input, confirmFailedChecks: true, confirmedChecksFingerprint: '0'.repeat(64) })
      assert.equal(wrong.body.state, 'needs_confirm'); assert.equal(wrong.body.checksFingerprint, needs.body.checksFingerprint)
      await unclaimed(f)
      const confirmed = await f.merge({ ...input, idempotencyKey: randomUUID(), confirmFailedChecks: true,
        confirmedChecksFingerprint: needs.body.checksFingerprint })
      await merged(f, confirmed); assert.equal(f.puts().length, 1)
    })

    await t.test('a correct failed-check confirmation cannot approve a replacement Factory candidate', async t => {
      const f = await fixture(t), input = f.input(); f.state.check = 'failed'
      const needs = await f.merge(input), replacement = await f.replaceCandidate()
      assert.notEqual(replacement.candidateId, f.candidateId)
      await assert.rejects(() => f.merge({ ...input, idempotencyKey: randomUUID(), confirmFailedChecks: true,
        confirmedChecksFingerprint: needs.body.checksFingerprint }), code('workspace_review_conflict'))
      await unclaimed(f)
      assert.equal((await f.rows()).task.candidateId, replacement.candidateId)
    })

    await t.test('new check evidence after claim invalidates an earlier confirmation before any PUT', async t => {
      const f = await fixture(t), input = f.input(); f.state.check = 'failed'
      const needs = await f.merge(input)
      f.state.onChecks = async () => {
        if ((await f.rows()).merges.length) f.state.checkLog = 'A different failure discovered after confirmation.'
      }
      const changed = await f.merge({ ...input, idempotencyKey: randomUUID(), confirmFailedChecks: true,
        confirmedChecksFingerprint: needs.body.checksFingerprint })
      assert.equal(changed.status, 409); assert.equal(changed.body.state, 'needs_confirm')
      assert.notEqual(changed.body.checksFingerprint, needs.body.checksFingerprint)
      const saved = await f.rows()
      assert.equal(saved.merges.length, 1); assert.equal(saved.merges[0]!.status, 'failed')
      assert.equal(saved.merges[0]!.code, 'githubMergeBlocked'); assert.equal(saved.receipts.length, 1)
      assert.equal(saved.task.stage, 'approval'); assert.equal(saved.task.status, 'waiting')
      assert.equal(saved.events.length, 0); assert.equal(f.puts().length, 0)
    })

    await t.test('pending checks are refused even when the caller supplies a confirmation fingerprint', async t => {
      const f = await fixture(t); f.state.check = 'pending'
      for (const input of [f.input(), f.input({ confirmFailedChecks: true, confirmedChecksFingerprint: '0'.repeat(64) })]) {
        const pending = await f.merge(input)
        assert.equal(pending.status, 409); assert.equal(pending.body.state, 'checks_pending')
        assert.equal(pending.body.error, 'workspace_review_unavailable')
      }
      await unclaimed(f)
    })

    await t.test('a deferred claim COMMIT failure leaves no merge, request receipt or PUT and the same request can retry', async t => {
      const f = await fixture(t), input = f.input(), name = 'task_merge_fault_' + randomUUID().replaceAll('-', '')
      await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW."boardId"='${f.scope.boardId}' AND NEW.action='task_merge' THEN
          RAISE EXCEPTION 'task_merge_claim_fixture' USING ERRCODE='P0001';
        END IF; RETURN NEW; END $$`)
      await pool.query(`CREATE CONSTRAINT TRIGGER ${name} AFTER INSERT ON coding_workspace_review_receipts
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${name}()`)
      try {
        await assert.rejects(() => f.merge(input), error => error !== null && typeof error === 'object'
          && 'code' in error && error.code === 'P0001' && 'message' in error && error.message === 'task_merge_claim_fixture')
        await unclaimed(f)
      } finally {
        await pool.query(`DROP TRIGGER ${name} ON coding_workspace_review_receipts`)
        await pool.query(`DROP FUNCTION ${name}()`)
      }
      await merged(f, await f.merge(input)); assert.equal(f.puts().length, 1)
    })

    for (const mode of ['timeout', 'http503'] as const)
      await t.test(`${mode} after PUT stays unknown; explicit retries only read back until a positive merge receipt appears`, async t => {
        const f = await fixture(t), input = f.input(); f.state.putMode = mode
        const pending = await f.merge(input)
        assert.equal(pending.status, 202); assert.equal(pending.body.state, 'pending')
        assert.equal(pending.body.merged, false); assert.equal(pending.body.reviewedHeadMerged, false)
        assert.equal(f.puts().length, 1); assert.equal((await f.rows()).merges[0]!.status, 'merging')
        // Exercise the established stale-claim readback without adding a wait or polling loop.
        await pool.query('UPDATE factory_merges SET "createdAt"=now()-interval \'61 seconds\' WHERE id=$1', [pending.body.mergeId])
        const before = f.calls.length, negative = await f.merge(input)
        assert.equal(negative.status, 202); assert.equal(negative.body.mergeId, pending.body.mergeId)
        assert.equal(negative.body.state, 'pending'); assert.ok(f.calls.slice(before).every(call => call.method === 'GET'))
        const alias = await f.merge({ ...input, idempotencyKey: randomUUID() })
        assert.equal(alias.body.mergeId, pending.body.mergeId); assert.equal(alias.body.state, 'pending')
        assert.equal(f.puts().length, 1); assert.equal((await f.rows()).merges.length, 1)
        f.state.merged = true; f.state.mergeCommit = mergeSha
        const recovered = await f.merge(input)
        await merged(f, recovered); assert.equal(recovered.body.mergeId, pending.body.mergeId)
        assert.equal(f.puts().length, 1)
        assert.equal((await f.merge(input)).body.mergeId, recovered.body.mergeId)
        assert.equal(f.puts().length, 1)
      })

    await t.test('HEAD movement after the committed claim prevents a PUT and is recorded as a real refusal', async t => {
      const f = await fixture(t)
      f.state.onPull = async () => { if ((await f.rows()).merges.length) f.state.head = otherHeadSha }
      const result = await f.merge(f.input())
      assert.equal(result.status, 409); assert.equal(result.body.state, 'rejected')
      assert.equal(result.body.reviewedHeadMerged, false); assert.equal(result.body.error, 'githubMergeHeadMoved')
      assert.equal(f.puts().length, 0)
      const saved = await f.rows()
      assert.equal(saved.merges.length, 1); assert.equal(saved.merges[0]!.status, 'failed')
      assert.equal(saved.task.stage, 'approval'); assert.equal(saved.task.status, 'waiting'); assert.equal(saved.events.length, 0)
    })

    await t.test('an actual external merge of another HEAD is never reported as the reviewed HEAD having merged', async t => {
      const f = await fixture(t), input = f.input(); f.state.putMode = 'timeout'
      const pending = await f.merge(input)
      await pool.query('UPDATE factory_merges SET "createdAt"=now()-interval \'61 seconds\' WHERE id=$1', [pending.body.mergeId])
      f.state.merged = true; f.state.head = otherHeadSha; f.state.mergeCommit = 'e'.repeat(40)
      const elsewhere = await f.merge(input)
      assert.equal(elsewhere.status, 409); assert.equal(elsewhere.body.state, 'merged_elsewhere')
      assert.equal(elsewhere.body.merged, true); assert.equal(elsewhere.body.reviewedHeadMerged, false)
      assert.equal(elsewhere.body.expectedHeadSha, headSha); assert.equal(elsewhere.body.actualHeadSha, otherHeadSha)
      assert.equal(elsewhere.body.mergeCommitSha, 'e'.repeat(40)); assert.equal(elsewhere.body.mergeId, pending.body.mergeId)
      assert.equal((await f.rows()).merges[0]!.headSha, otherHeadSha); assert.equal(f.puts().length, 1)
      const reads = f.calls.length
      assert.deepEqual((await f.merge(input)).body, elsewhere.body)
      assert.equal(f.calls.length, reads); assert.equal(f.puts().length, 1)
    })

    await t.test('an original merged receipt remains bound to its historical candidate after replacement and credential revocation', async t => {
      const f = await fixture(t), input = f.input(), first = await f.merge(input)
      await merged(f, first)
      const replacement = await f.replaceCandidate(), calls = f.calls.length, credentials = credentialReads.length
      f.state.head = otherHeadSha; deniedCredentials.add(f.owner.id)
      const historical = await f.merge(input)
      assert.equal(historical.status, 200); assert.deepEqual(historical.body, first.body)
      assert.equal((await f.rows()).task.candidateId, replacement.candidateId)
      assert.equal(f.calls.length, calls); assert.equal(credentialReads.length, credentials); assert.equal(f.puts().length, 1)
      await assert.rejects(() => f.merge({ ...input, confirmFailedChecks: true, confirmedChecksFingerprint: '0'.repeat(64) }),
        code('workspace_review_conflict'))
      assert.equal((await f.rows()).receipts.length, 1); assert.equal(f.puts().length, 1)
    })

    await t.test('native mutation permission refusal and its exact replay retain the same explicit permission error', async t => {
      const f = await fixture(t), input = f.input(); f.state.putMode = 'forbidden'
      const refused = await f.merge(input)
      assert.equal(refused.status, 403); assert.equal(refused.body.state, 'rejected')
      assert.equal(refused.body.error, 'github_permission'); assert.equal(refused.body.reason, 'github_permission')
      assert.equal(refused.body.merged, false); assert.equal(refused.body.reviewedHeadMerged, false)
      const calls = f.calls.length, again = await f.merge(input)
      assert.equal(again.status, 403); assert.deepEqual(again.body, refused.body)
      assert.equal(f.calls.length, calls); assert.equal(f.puts().length, 1)
      const saved = await f.rows()
      assert.equal(saved.merges[0]!.status, 'failed'); assert.equal(saved.merges[0]!.code, 'githubMergeForbidden')
      assert.equal(saved.task.stage, 'approval'); assert.equal(saved.task.status, 'waiting'); assert.equal(saved.events.length, 0)
    })
  } finally {
    mock.restoreAll()
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
    await dropTestDatabase(admin, database, pool, appPool, workspacePool)
    await admin.end()
  }
})
