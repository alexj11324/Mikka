import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import test, { mock, type TestContext } from 'node:test'
import { Pool } from 'pg'
import { CodingWorkspaceError } from '@mikka/protocol/coding-workspace'
import { WorkspaceReviewError, type DiffFileMetadata, type DiffFilePatch, type GitHubReviewMutation,
  type ReviewAnchor, type ReviewBatchReceipt } from '@mikka/protocol/coding-workspace-review'
import { GitHubAccessError } from '../../github/user-access-error'
import type { RequestBudget } from '../../request-budget'
import type { ReviewActor } from './authority'
import { orderMigrations } from '../../../scripts/migration-order.mjs'
import { disposableDatabase, E2E_DB_RULE } from '../../../tests/helpers/e2e-target.mjs'
import { dropTestDatabase } from '../../../tests/support/drop-test-database'

const url = process.env.E2E_DATABASE_URL
if (url) assert.ok(disposableDatabase(process.env, url), E2E_DB_RULE)
else if (process.env.REQUIRE_DB === '1') assert.fail('REQUIRE_DB=1 needs an isolated E2E_DATABASE_URL')
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const code = (expected: string) => (error: unknown) =>
  (error instanceof CodingWorkspaceError || error instanceof WorkspaceReviewError) && error.code === expected
const sqlCode = (expected: string) => (error: unknown) => error !== null && typeof error === 'object' && 'code' in error && error.code === expected
const repositoryKey = 'v2/github.com/mikka-fixtures/delivery', fullName = 'mikka-fixtures/delivery', repositoryId = '61393725'
const apiPath = '/repos/' + fullName, number = 7, publicPull = `https://github.com/${fullName}/pull/${number}`
const baseSha = 'a'.repeat(40), headSha = 'b'.repeat(40), targetSha = 'c'.repeat(40)
const reviewId = '9007199254741001'
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
async function bounded<T>(promise: Promise<T>, milliseconds = 7000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Timed out waiting for the controlled delivery boundary')), milliseconds)
  })]) } finally { clearTimeout(timer) }
}

/** Real PostgreSQL migrations, authorization, encrypted GitHub connections,
 * full-source patches, immutable batches and operation ledger. Only upstream
 * user-token acquisition and GitHub HTTP responses are controlled. This does
 * not replace DB execution with an in-memory ledger or a fake success. */
test('native GitHub review delivery and reconciliation on PostgreSQL 17', { skip: !url, timeout: 240_000 }, async t => {
  const admin = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000 })
  const database = `github_review_delivery_${randomUUID().replaceAll('-', '')}_e2e`
  const version = Number((await admin.query('SHOW server_version_num')).rows[0].server_version_num)
  assert.ok(version >= 170000 && version < 180000, 'native delivery acceptance requires PostgreSQL 17')
  await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`)
  const target = new URL(url!); target.pathname = `/${database}`
  const pool = new Pool({ connectionString: target.toString(), max: 16, connectionTimeoutMillis: 5000 })
  const environment = { MIKKA_DATABASE_URL: target.toString(), DATABASE_URL: target.toString(), ORVILO_DATABASE_URL: target.toString(),
    E2E_DATABASE_URL: target.toString(), BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
    BETTER_AUTH_URL: 'http://127.0.0.1:3199', WORKSPACE_SECRETS_KEY: randomBytes(32).toString('hex'),
    GITHUB_CLIENT_ID: 'fixture-client', GITHUB_CLIENT_SECRET: 'fixture-client-secret' }
  const previous = Object.fromEntries(Object.keys(environment).map(name => [name, process.env[name]]))
  Object.assign(process.env, environment)
  let appPool: Pool | undefined, workspacePool: Pool | undefined
  const tokens = new Map<string, { token: string; githubAccountId: string; expiresAt: Date }>()
  try {
    const directory = new URL('../../../drizzle/', import.meta.url)
    for (const name of orderMigrations((await readdir(directory)).filter(name => name.endsWith('.sql'))))
      await pool.query(await readFile(new URL(name, directory), 'utf8'))
    const next = await import('next/server')
    mock.module('next/server', { namedExports: { ...next, after() {} } })
    mock.module('next/headers', { namedExports: { headers: async () => new Headers(), cookies: async () => ({
      get: () => undefined, getAll: () => [], has: () => false, set() {}, delete() {},
    }) } })
    mock.module('next-intl/server', { namedExports: { getLocale: async () => 'en',
      getTranslations: async () => Object.assign((key: string) => key, { has: () => true }) } })
    const userToken = mock.fn(async (userId: string, options: { minValidityMs?: number; budget?: RequestBudget } = {}) => {
      const value = tokens.get(userId)
      assert.ok(value, 'native writes must request the actual fixture user credential')
      assert.equal(options.minValidityMs, 45_000); assert.ok(options.budget && options.budget.deadline > Date.now())
      return value
    })
    mock.module(new URL('../../github/user-access.ts', import.meta.url).href, { namedExports: {
      githubTokenForUser: userToken, GitHubAccessError,
      githubRepositoryReadCredential: async () => { throw new Error('An installation/read credential cannot authorize native publishing') },
    } })
    const { saveGitHubConnection } = await import('../../github/connection')
    const { ensureReviewScope } = await import('./service')
    const { withReviewTransaction } = await import('./authority')
    const { retainDiffSnapshot, manifestRevision, readStoredDiffFile } = await import('./store')
    const { buildGitHubManifest } = await import('./github-manifest')
    const { buildGitHubFilePatch } = await import('./github-patch')
    const { buildDiffFilePatch, diffFileVersion, gitBlobHash, validateReviewAnchor } = await import('./patch')
    const { deliverGitHubReview } = await import('./github-delivery')
    const { secretMaskerFor } = await import('../../secrets/runtime')
    const { sealSecret, userSecretAad } = await import('../../secrets/crypto')
    appPool = (await import('../../db')).pool; workspacePool = (await import('../../workspace-db')).workspacePool

    async function user() {
      const id = `review-delivery-${randomUUID()}`, sessionId = randomUUID()
      await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt")
        VALUES($1,$1,$2,true,now(),now())`, [id, `${id}@example.invalid`])
      await pool.query(`INSERT INTO "session"(id,token,"userId","expiresAt","createdAt","updatedAt")
        VALUES($1,$2,$3,now()+interval '1 hour',now(),now())`, [sessionId, randomUUID(), id])
      const credential = { token: `fixture-native-${randomUUID()}`, githubAccountId: String(1_000_000 + tokens.size),
        expiresAt: new Date(Date.now() + 3_600_000) }
      tokens.set(id, credential)
      await saveGitHubConnection(id, { githubAccountId: credential.githubAccountId, githubLogin: 'delivery-fixture' },
        { access_token: credential.token, expires_in: 3600 })
      return { id, sessionId, credential }
    }
    type User = Awaited<ReturnType<typeof user>>
    async function workspace(owner: User, member: User) {
      const id = randomUUID(), teamId = randomUUID()
      await pool.query('INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,$2,\'Delivery fixture\')', [id, owner.id])
      for (const person of [owner, member]) await pool.query(`INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status)
        VALUES($1,$2,$2,$3,$4,'active')`, [id, person.id, `${person.id}@example.invalid`, person === owner ? 'admin' : 'member'])
      await pool.query(`INSERT INTO mikka_teams(id,"workspaceId","userId",name,identifier)
        VALUES($1,$2,$3,'Delivery fixture',$4)`, [teamId, id, owner.id, `D${randomUUID().replaceAll('-', '').slice(0, 7).toUpperCase()}`])
      await pool.query('INSERT INTO mikka_team_members("teamId","userId",role) VALUES($1,$2,\'owner\')', [teamId, owner.id])
      return { id, teamId }
    }
    const actor = (person: User, workspaceId: string): ReviewActor => ({ userId: person.id, workspaceId,
      credential: { kind: 'session', id: person.sessionId } })

    async function fixture(context: TestContext, options: { local?: boolean; count?: number; body?: string } = {}) {
      const owner = await user(), member = await user(), outsider = await user()
      const where = await workspace(owner, member), elsewhere = await workspace(owner, member)
      const who = actor(owner, where.id), runId = randomUUID(), repoId = randomUUID(), taskId = randomUUID(),
        deviceId = randomUUID(), agentId = randomUUID()
      await pool.query(`INSERT INTO issues(id,"userId","workspaceId",title,content,status,priority,scope)
        VALUES($1,$2,$3,'Delivery task','{"type":"doc","content":[]}','doing','normal','workspace')`, [taskId, owner.id, where.id])
      await pool.query('INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId") VALUES($1,$2,$3,$4)',
        [taskId, where.teamId, where.id, owner.id])
      await pool.query('INSERT INTO devices(id,"ownerId",name,kind) VALUES($1,$2,\'Delivery fixture\',\'local\')', [deviceId, owner.id])
      await pool.query('INSERT INTO agents(id,"userId",name,harness,"deviceId") VALUES($1,$2,\'Delivery fixture\',\'codex\',$3)', [agentId, owner.id, deviceId])
      await pool.query('INSERT INTO device_repos(id,"userId","deviceId","repoPath","remoteUrl") VALUES($1,$2,$3,$4,$5)',
        [repoId, owner.id, deviceId, repositoryKey, `https://github.com/${fullName}.git`])
      await pool.query(`INSERT INTO agent_runs(id,"userId","issueId","agentId","deviceId","deviceRepoId",status,"stopRequestedAt","finishedAt","agentDefinition")
        VALUES($1,$2,$3,$4,$5,$6,'stopped',now(),now(),$7)`, [runId, owner.id, taskId, agentId, deviceId, repoId,
        { executionIdentity: { workspaceId: where.id }, repositoryAdmission: { workspaceId: where.id, remoteKey: repositoryKey } }])
      await pool.query(`INSERT INTO run_publications("runId","userId","issueId","remoteUrl","remoteKey",status,"pullRequest")
        VALUES($1,$2,$3,$4,$5,'published',$6)`, [runId, owner.id, taskId, `https://github.com/${fullName}.git`, repositoryKey, { url: publicPull }])
      const deps = { database: pool, membership: pool }, scope = await ensureReviewScope(deps, who, runId, repoId)
      const source = ['alpha.txt', 'beta.txt'].map(path => {
        const before = Buffer.from(`before ${path}\nstable\n`), after = Buffer.from(`after ${path}\nstable\n`)
        const patch = `@@ -1,2 +1,2 @@\n-before ${path}\n+after ${path}\n stable\n`
        return { path, before, after, patch }
      })
      const tree = (side: 'before' | 'after') => new Map(source.map(file => [file.path,
        { sha: gitBlobHash(file[side], headSha), mode: '100644', size: file[side].length }]))
      let files: DiffFileMetadata[] = buildGitHubManifest({ repoId, repositoryId, baseSha, headSha, before: tree('before'), after: tree('after'),
        nativeFiles: source.map(file => ({ path: file.path, previousPath: null, status: 'modified', sha: gitBlobHash(file.after, headSha),
          additions: 1, deletions: 1, patchSha256: digest(file.patch), page: 1 })) })
      if (options.local) files = files.map(({ github: _github, ...file }) => ({ ...file, fileVersion: diffFileVersion(repoId, { baseSha, headSha }, file) }))
      const access = options.local ? undefined : { kind: 'github' as const, repositoryId, pullRequestNumber: number,
        pullRequestBaseSha: targetSha, manifestComplete: true as const }
      const revision = manifestRevision(options.local ? 'commit' : 'pull_request', baseSha, headSha, null, files, access)
      const mask = await secretMaskerFor({ workspaceId: where.id, ownerId: owner.id }), patches = new Map<string, DiffFilePatch>()
      for (const file of files) {
        const bytes = source.find(value => value.path === file.path)!
        const input = { snapshotId: randomUUID(), sourceVersion: revision.version, file, before: bytes.before, after: bytes.after }
        patches.set(file.path, options.local ? buildDiffFilePatch(input, mask) : buildGitHubFilePatch({ ...input, nativePatch: bytes.patch }, mask))
      }
      const snapshot = await withReviewTransaction(pool, pool, who, runId, repoId, (client, fresh) => retainDiffSnapshot(client, fresh,
        { revision, files, patches, ...(access ? { sourceAccess: access, pullRequest: {
          number, url: publicPull, headSha, baseSha: targetSha, state: 'open' as const } } : {}) }, mask))
      const comments: { id: string; anchor: ReviewAnchor; body: string; userId: string }[] = []
      const boardRevision = async () => Number((await pool.query('SELECT revision FROM coding_workspace_review_boards WHERE id=$1', [scope.boardId])).rows[0].revision)
      async function addComment(person = owner, body = `Check the changed line ${comments.length + 1}.`) {
        const id = randomUUID(), path = files[comments.length % files.length]!.path
        await withReviewTransaction(pool, pool, actor(person, where.id), runId, repoId, async (client, fresh) => {
          const stored = await readStoredDiffFile(client, fresh, snapshot, path, mask)
          assert.ok(stored.patch?.hunks[0])
          const anchor = validateReviewAnchor({ snapshotId: snapshot.id, sourceVersion: revision.version, path,
            side: 'RIGHT', lineStart: 1, lineEnd: 1, hunkFingerprint: stored.patch.hunks[0].fingerprint }, stored.patch)
          await client.query(`INSERT INTO coding_workspace_review_comments(id,"threadId","boardId","snapshotId","userId",anchor,body,draft)
            VALUES($1,$1,$2,$3,$4,$5,$6,true)`, [id, scope.boardId, snapshot.id, person.id, anchor, body])
          await client.query('UPDATE coding_workspace_review_boards SET revision=revision+1 WHERE id=$1', [scope.boardId])
          comments.push({ id, anchor, body, userId: person.id })
        })
        return id
      }
      for (let index = 0; index < (options.count ?? 2); index++) await addComment(owner, options.body)
      type Inline = { id: string; pull_request_review_id: string; user: { id: string }; pull_request_url: string;
        body: string; path: string; side: string; start_side: string | null; original_line: number;
        original_start_line: number | null; original_commit_id: string; in_reply_to_id: null }
      const state = { head: headSha, base: targetSha, throwAfterPost: false, visible: true, repositoryStatus: 200,
        mutationStatus: 200, commentsStatus: 200,
        inlineLimit: undefined as number | undefined, inline: [] as Inline[], receipt: null as Record<string, unknown> | null,
        onRepository: undefined as (() => Promise<void>) | undefined, onPull: undefined as (() => Promise<void>) | undefined,
        beforePost: undefined as (() => Promise<void>) | undefined }
      const calls: { method: string; pathname: string; body?: Record<string, unknown> }[] = []
      context.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = new URL(String(input)), method = init.method ?? 'GET'
        assert.equal(url.origin, 'https://api.github.com'); assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit')
        const credential = [...tokens.values()].find(value => `Bearer ${value.token}` === new Headers(init.headers).get('authorization'))
        assert.ok(credential, 'the wire credential is a real encrypted fixture user connection')
        const payload = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
        calls.push({ method, pathname: url.pathname, body: payload })
        if (method === 'GET' && url.pathname === apiPath) {
          await state.onRepository?.()
          return Response.json(state.repositoryStatus === 200 ? { id: repositoryId, full_name: fullName }
            : { message: 'Fixture provider authorization refused' }, { status: state.repositoryStatus })
        }
        if (method === 'GET' && url.pathname === `${apiPath}/pulls/${number}`) {
          await state.onPull?.()
          return Response.json({ number, html_url: publicPull, state: 'open', merged: false, changed_files: 2,
            base: { sha: state.base, repo: { id: repositoryId, full_name: fullName } }, head: { sha: state.head } })
        }
        if (method === 'POST' && url.pathname === `${apiPath}/pulls/${number}/reviews`) {
          await state.beforePost?.(); assert.ok(payload && Array.isArray(payload.comments))
          if (state.mutationStatus !== 200)
            return Response.json({ message: 'Fixture native review mutation is forbidden' }, { status: state.mutationStatus })
          state.receipt = { id: reviewId, body: payload.body, user: { id: credential.githubAccountId },
            html_url: `${publicPull}#pullrequestreview-${reviewId}`, pull_request_url: `https://api.github.com${apiPath}/pulls/${number}`,
            commit_id: payload.commit_id, state: payload.event === 'REQUEST_CHANGES' ? 'CHANGES_REQUESTED' : payload.event === 'APPROVE' ? 'APPROVED' : 'COMMENTED',
            submitted_at: new Date().toISOString() }
          state.inline = payload.comments.map((value, index) => {
            const item = value as { path: string; body: string; side: string; line: number; start_line?: number; start_side?: string }
            return { id: (9007199254741100n + BigInt(index)).toString(), pull_request_review_id: reviewId,
              user: { id: credential.githubAccountId }, pull_request_url: `https://api.github.com${apiPath}/pulls/${number}`,
              body: item.body, path: item.path, side: item.side, start_side: item.start_side ?? null,
              original_line: item.line, original_start_line: item.start_line ?? null, original_commit_id: String(payload.commit_id), in_reply_to_id: null }
          })
          if (state.throwAfterPost) throw new DOMException('Fixture lost an accepted provider response', 'TimeoutError')
          return Response.json(state.receipt)
        }
        if (method === 'GET' && url.pathname === `${apiPath}/pulls/${number}/reviews`)
          return Response.json(state.visible && state.receipt ? [state.receipt] : [])
        if (method === 'GET' && url.pathname === `${apiPath}/pulls/${number}/comments`)
          return Response.json(state.commentsStatus === 200 ? state.inline.slice(0, state.inlineLimit)
            : { message: 'Fixture native review readback is forbidden' }, { status: state.commentsStatus })
        throw new Error(`Unexpected fixture GitHub operation ${method} ${url.pathname}`)
      })
      const input = async (change: Partial<Extract<GitHubReviewMutation, { action: 'publish' }>> = {}) => ({
        action: 'publish' as const, requestId: randomUUID(), batchId: randomUUID(), expectedRevision: await boardRevision(),
        sourceVersion: revision.version, event: 'COMMENT' as const, note: '', commentIds: comments.filter(value => value.userId === owner.id).map(value => value.id), ...change,
      })
      const deliver = (value: unknown, person = who) => deliverGitHubReview(deps, person, runId, repoId, snapshot.id, value)
      const rows = async () => ({
        batches: (await pool.query('SELECT * FROM coding_workspace_review_batches WHERE "boardId"=$1 ORDER BY id', [scope.boardId])).rows,
        operations: (await pool.query('SELECT * FROM operation_ledger WHERE "workspaceId"=$1 ORDER BY "operationId"', [where.id])).rows,
        comments: (await pool.query('SELECT id,draft FROM coding_workspace_review_comments WHERE "boardId"=$1 ORDER BY id', [scope.boardId])).rows,
      })
      const posts = () => calls.filter(call => call.method === 'POST')
      return { owner, member, outsider, where, elsewhere, who, runId, repoId, taskId, deviceId, snapshot, scope, state,
        comments, addComment, input, deliver, rows, posts, calls, boardRevision }
    }

    // Subtests below intentionally call the real public delivery service. The
    // fixture creates only validated retained patches and local draft rows.

    await t.test('two selected comments produce one native review and exact plus semantic retries never write twice', async t => {
      const f = await fixture(t), input = await f.input(), first = await f.deliver(input)
      assert.equal(first.state, 'accepted'); assert.equal(first.batchId, input.batchId)
      assert.equal(first.delivery?.kind, 'github_review'); assert.equal(first.delivery?.id, reviewId)
      assert.equal(first.delivery?.commitSha, headSha); assert.equal(first.delivery?.headSha, headSha)
      assert.equal(f.posts().length, 1)
      const post = f.posts()[0]!.body!
      assert.equal(post.commit_id, headSha); assert.equal(post.event, 'COMMENT')
      const inline = post.comments as { path: string; body: string; line: number; side: string }[]
      assert.equal(inline.length, 2)
      const material = (value: { path: string; body: string; line: number; side: string }) => JSON.stringify([value.path, value.body, value.line, value.side])
      assert.deepEqual(inline.map(material).sort(), f.comments.map(value => material({
        path: value.anchor.path, body: value.body, line: value.anchor.lineEnd, side: value.anchor.side })).sort())
      const repeated = await f.deliver(input)
      assert.equal(repeated.state, 'accepted'); assert.equal(repeated.batchId, first.batchId)
      const another = { ...input, requestId: randomUUID(), batchId: randomUUID() }
      assert.ok(another.expectedRevision < await f.boardRevision(), 'a genuine double click retains its old CAS revision')
      const duplicate = await f.deliver(another)
      assert.equal(duplicate.state, 'accepted'); assert.equal(duplicate.batchId, first.batchId)
      assert.equal(f.posts().length, 1)
      const rows = await f.rows()
      assert.equal(rows.batches.length, 1); assert.equal(rows.operations.length, 1)
      assert.equal(rows.batches[0]!.state, 'accepted'); assert.equal(rows.operations[0]!.status, 'succeeded')
      assert.ok(rows.operations[0]!.invokedAt); assert.equal(rows.operations[0]!.runId, null)
      assert.equal(rows.operations[0]!.binding.executionRunId, undefined)
      assert.equal(rows.operations[0]!.receipt.providerObjectId, reviewId)
      assert.ok(rows.comments.every(value => !value.draft))
      const receipts = (await pool.query(`SELECT response FROM coding_workspace_review_receipts
        WHERE "boardId"=$1 AND action='batch_github' ORDER BY "requestId"`, [f.scope.boardId])).rows
      assert.equal(receipts.length, 2); assert.ok(receipts.every(value => value.response.batchId === first.batchId))
      await assert.rejects(() => f.deliver({ ...input, note: 'A changed command under the same request ID' }), code('workspace_review_conflict'))
      await assert.rejects(() => f.deliver({ ...another, requestId: randomUUID(), batchId: randomUUID(), note: 'Different semantic intent' }), code('workspace_review_conflict'))
      await assert.rejects(() => pool.query('UPDATE coding_workspace_review_batches SET input=input || \'{"version":2}\'::jsonb WHERE id=$1', [first.batchId]), sqlCode('55000'))
      await assert.rejects(() => pool.query('UPDATE coding_workspace_review_batches SET state=\'prepared\' WHERE id=$1', [first.batchId]), sqlCode('55000'))
      assert.equal(f.posts().length, 1)
      assert.ok(!JSON.stringify(first).includes(f.owner.credential.token))
    })

    await t.test('concurrent exact and semantic submissions share the durable once-only invocation', async t => {
      const f = await fixture(t), input = await f.input(), entered = deferred(), release = deferred()
      f.state.beforePost = async () => { entered.resolve(); await release.promise }
      const duplicate = { ...input, requestId: randomUUID(), batchId: randomUUID() }
      const results = Promise.allSettled([f.deliver(input), f.deliver(duplicate)])
      let boundaryError: unknown
      try {
        await bounded(Promise.race([entered.promise, results.then(() => assert.fail('No concurrent request reached the provider gate'))]))
        const rows = (await pool.query('SELECT "operationId",status,"invokedAt","runId" FROM operation_ledger WHERE "workspaceId"=$1', [f.where.id])).rows
        assert.equal(rows.length, 1)
        const row = rows[0]
        assert.ok(row); assert.equal(row.status, 'executing'); assert.ok(row.invokedAt); assert.equal(row.runId, null)
        assert.ok([input.batchId, duplicate.batchId].includes(row.operationId))
      } catch (error) { boundaryError = error }
      finally { release.resolve() }
      // Drain both calls before a failed assertion can restore the fetch mock.
      const completed = await bounded(results, 25_000)
      if (boundaryError) throw boundaryError
      const batches = new Set<string>(), states: ReviewBatchReceipt['state'][] = []
      for (const result of completed) {
        assert.equal(result.status, 'fulfilled', result.status === 'rejected' ? String(result.reason) : undefined)
        if (result.status === 'fulfilled') {
          assert.ok(['delivering', 'uncertain', 'accepted'].includes(result.value.state))
          batches.add(result.value.batchId); states.push(result.value.state)
        }
      }
      assert.equal(batches.size, 1); assert.ok(states.includes('accepted'))
      const retried = await f.deliver(input)
      assert.equal(retried.state, 'accepted'); assert.ok(batches.has(retried.batchId))
      assert.equal(f.posts().length, 1)
      const rows = await f.rows(); assert.equal(rows.batches.length, 1); assert.equal(rows.operations.length, 1)
    })

    await t.test('an unknown accepted POST recovers only from positive complete readback and never issues a second POST', async t => {
      const f = await fixture(t), input = await f.input()
      f.state.throwAfterPost = true
      const unknown = await f.deliver(input)
      assert.equal(unknown.state, 'uncertain'); assert.equal(unknown.delivery, null); assert.equal(f.posts().length, 1)
      let rows = await f.rows()
      assert.equal(rows.operations[0]!.status, 'uncertain'); assert.ok(rows.operations[0]!.invokedAt)
      assert.equal(rows.operations[0]!.receipt, null); assert.ok(rows.comments.every(value => value.draft))
      f.state.visible = false
      assert.equal((await f.deliver(input)).state, 'uncertain', 'absence is not proof that the original POST failed')
      const semanticInput = { ...input, requestId: randomUUID(), batchId: randomUUID() }
      const semantic = await f.deliver(semanticInput)
      assert.equal(semantic.state, 'uncertain'); assert.equal(semantic.batchId, unknown.batchId)
      assert.equal(f.posts().length, 1, 'new request IDs cannot turn an unknown effect into another POST')
      rows = await f.rows(); assert.equal(rows.batches.length, 1); assert.equal(rows.operations.length, 1)
      f.state.visible = true; f.state.inlineLimit = 1
      assert.equal((await f.deliver(input)).state, 'uncertain', 'a matching marker without both inline comments is insufficient')
      assert.equal(f.posts().length, 1)
      f.state.inlineLimit = undefined
      const recovered = await f.deliver(input)
      assert.equal(recovered.state, 'accepted'); assert.equal(recovered.delivery?.id, reviewId)
      rows = await f.rows()
      assert.equal(rows.batches[0]!.state, 'accepted'); assert.equal(rows.operations[0]!.status, 'succeeded')
      assert.equal(rows.operations[0]!.receipt.providerObjectId, reviewId); assert.ok(rows.comments.every(value => !value.draft))
      assert.equal(f.posts().length, 1)
      const semanticRecovered = await f.deliver(semanticInput)
      assert.equal(semanticRecovered.state, 'accepted'); assert.equal(semanticRecovered.batchId, recovered.batchId)
      assert.equal(f.posts().length, 1)
    })

    await t.test('an explicit mutation 403 rejects that request and permits one new request after write permission recovers', async t => {
      const f = await fixture(t), input = await f.input()
      f.state.mutationStatus = 403
      assert.equal(f.state.repositoryStatus, 200, 'the credential and repository grant preflight remains authorized')
      await assert.rejects(() => f.deliver(input), code('workspace_review_github_forbidden'))
      assert.equal(f.posts().length, 1); assert.equal(f.posts()[0]!.pathname, `${apiPath}/pulls/${number}/reviews`)
      assert.equal(f.state.receipt, null); assert.equal(f.state.inline.length, 0, 'the refused mutation created no provider object')
      let rows = await f.rows()
      assert.equal(rows.batches.length, 1); assert.equal(rows.batches[0].state, 'rejected')
      assert.equal(rows.batches[0].receipt.reason, 'authorization_changed')
      assert.equal(rows.operations.length, 1); assert.equal(rows.operations[0].status, 'failed')
      assert.ok(rows.operations[0].invokedAt); assert.equal(rows.operations[0].receipt, null)
      assert.ok(rows.comments.every(value => value.draft))
      const refusedAgain = await f.deliver(input)
      assert.equal(refusedAgain.state, 'rejected'); assert.equal(refusedAgain.batchId, input.batchId)
      f.state.mutationStatus = 200
      const oldAfterRecovery = await f.deliver(input)
      assert.equal(oldAfterRecovery.state, 'rejected'); assert.equal(oldAfterRecovery.batchId, input.batchId)
      assert.equal(f.posts().length, 1, 'permission recovery does not replay an immutable refused request')

      const retry = { ...input, requestId: randomUUID(), batchId: randomUUID(), expectedRevision: await f.boardRevision() }
      const accepted = await f.deliver(retry)
      assert.equal(accepted.state, 'accepted'); assert.equal(accepted.batchId, retry.batchId)
      assert.equal(accepted.delivery?.id, reviewId); assert.notEqual(accepted.batchId, input.batchId)
      for (const request of [retry, { ...retry, requestId: randomUUID(), batchId: randomUUID() }]) {
        const repeated = await f.deliver(request)
        assert.equal(repeated.state, 'accepted'); assert.equal(repeated.batchId, accepted.batchId)
        assert.equal(repeated.delivery?.id, accepted.delivery?.id)
      }
      assert.equal(f.posts().length, 2, 'one refused POST and one successful explicit retry, without transport retries')
      rows = await f.rows()
      assert.equal(rows.batches.length, 2); assert.equal(rows.operations.length, 2)
      assert.equal(rows.operations.find(row => row.operationId === input.batchId)?.status, 'failed')
      assert.equal(rows.operations.find(row => row.operationId === accepted.batchId)?.status, 'succeeded')
      assert.ok(rows.comments.every(value => !value.draft))
    })

    await t.test('a readback 403 after an accepted POST remains uncertain and never authorizes another POST', async t => {
      const f = await fixture(t), input = await f.input()
      f.state.commentsStatus = 403
      assert.equal(f.state.repositoryStatus, 200); assert.equal(f.state.mutationStatus, 200)
      const unknown = await f.deliver(input)
      assert.equal(unknown.state, 'uncertain'); assert.equal(unknown.delivery, null)
      assert.equal(f.posts().length, 1); assert.equal(f.state.receipt?.id, reviewId); assert.equal(f.state.inline.length, 2)
      const posted = f.calls.findIndex(call => call.method === 'POST')
      const readback = f.calls.findIndex(call => call.method === 'GET' && call.pathname === `${apiPath}/pulls/${number}/comments`)
      assert.ok(posted >= 0 && readback > posted, 'the 403 occurs on GET comments after the mutation was accepted')
      let rows = await f.rows()
      assert.equal(rows.batches[0].state, 'uncertain'); assert.equal(rows.operations[0].status, 'uncertain')
      assert.ok(rows.operations[0].invokedAt); assert.equal(rows.operations[0].receipt, null)
      assert.ok(rows.comments.every(value => value.draft))
      const semantic = { ...input, requestId: randomUUID(), batchId: randomUUID() }
      for (const request of [input, semantic]) {
        const repeated = await f.deliver(request)
        assert.equal(repeated.state, 'uncertain'); assert.equal(repeated.batchId, unknown.batchId)
        assert.equal(repeated.delivery, null)
      }
      assert.equal(f.posts().length, 1)
      rows = await f.rows(); assert.equal(rows.batches.length, 1); assert.equal(rows.operations.length, 1)
      assert.equal(rows.batches[0].state, 'uncertain'); assert.equal(rows.operations[0].status, 'uncertain')

      f.state.commentsStatus = 200
      const recovered = await f.deliver(semantic)
      assert.equal(recovered.state, 'accepted'); assert.equal(recovered.batchId, unknown.batchId)
      assert.equal(recovered.delivery?.id, reviewId)
      rows = await f.rows()
      assert.equal(rows.batches.length, 1); assert.equal(rows.batches[0].state, 'accepted')
      assert.equal(rows.operations.length, 1); assert.equal(rows.operations[0].status, 'succeeded')
      assert.equal(rows.operations[0].receipt.providerObjectId, reviewId); assert.ok(rows.comments.every(value => !value.draft))
      assert.equal((await f.deliver(input)).batchId, recovered.batchId)
      assert.equal(f.posts().length, 1, 'restored reads reconcile the original effect without retrying the mutation')
    })

    await t.test('foreign tenants, non-members, owner private drafts and non-session credentials cannot publish', async t => {
      const f = await fixture(t), input = await f.input()
      const patId = randomUUID(), deviceTokenId = randomUUID()
      await pool.query(`INSERT INTO personal_access_tokens(id,"userId","workspaceId",name,"tokenHash",hint,"expiresAt")
        VALUES($1,$2,$3,'Delivery PAT',$4,'test',now()+interval '1 hour')`, [patId, f.owner.id, f.where.id, digest(randomUUID())])
      await pool.query(`INSERT INTO device_tokens(id,"userId","tokenHash","expiresAt","boundDeviceId","boundWorkspaceId")
        VALUES($1,$2,$3,now()+interval '1 hour',$4,$5)`, [deviceTokenId, f.owner.id, digest(randomUUID()), f.deviceId, f.where.id])
      await pool.query('UPDATE agent_runs SET "deviceTokenId"=$2 WHERE id=$1', [f.runId, deviceTokenId])
      for (const [who, expected] of [
        [actor(f.owner, f.elsewhere.id), 'workspace_not_found'], [actor(f.outsider, f.where.id), 'workspace_not_found'],
        [actor(f.member, f.where.id), 'workspace_review_unavailable'],
        [{ ...f.who, credential: { kind: 'pat', id: patId } }, 'workspace_review_unavailable'],
        [{ ...f.who, credential: { kind: 'device', id: deviceTokenId, deviceId: f.deviceId } }, 'workspace_review_unavailable'],
      ] as const) await assert.rejects(() => f.deliver(input, who), code(expected))
      const rows = await f.rows()
      assert.equal(rows.batches.length, 0); assert.equal(rows.operations.length, 0); assert.equal(f.posts().length, 0)
      assert.ok(rows.comments.every(value => value.draft))
    })

    await t.test('a legitimate Task member may publish their own comments with their independently bound GitHub user account', async t => {
      const f = await fixture(t), id = await f.addComment(f.member, 'Member-owned feedback.')
      const receipt = await f.deliver(await f.input({ commentIds: [id] }), actor(f.member, f.where.id))
      assert.equal(receipt.state, 'accepted'); assert.equal(f.posts().length, 1)
      assert.equal(f.state.receipt!.user && (f.state.receipt!.user as { id: string }).id, f.member.credential.githubAccountId)
      const rows = await f.rows()
      assert.equal(rows.operations[0]!.ownerId, f.member.id)
      assert.equal(rows.operations[0]!.binding.accountId, f.member.credential.githubAccountId)
      assert.equal(rows.comments.find(value => value.id === id)!.draft, false)
      assert.ok(rows.comments.filter(value => value.id !== id).every(value => value.draft), 'publishing one member draft never exposes owner drafts')
    })

    await t.test('a local-only retained snapshot cannot be promoted into a native GitHub review', async t => {
      const f = await fixture(t, { local: true })
      assert.equal(f.snapshot.sourceAccess, undefined); assert.equal(f.snapshot.pullRequest, null)
      await assert.rejects(async () => f.deliver(await f.input()), code('workspace_snapshot_outdated'))
      assert.equal(f.calls.length, 0); assert.equal((await f.rows()).batches.length, 0)
    })

    for (const revoked of ['session', 'membership', 'task scope', 'GitHub connection', 'GitHub encrypted token'] as const)
      await t.test(`revoking ${revoked} during the remote credential check prevents the effect`, async t => {
        const f = await fixture(t), input = await f.input()
        f.state.onRepository = async () => {
          f.state.onRepository = undefined
          if (revoked === 'session') await pool.query('UPDATE "session" SET "expiresAt"=now()-interval \'1 second\' WHERE id=$1', [f.owner.sessionId])
          else if (revoked === 'membership') await pool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [f.where.id, f.owner.id])
          else if (revoked === 'task scope') await pool.query('UPDATE mikka_team_issues SET "workspaceId"=$2,"teamId"=$3 WHERE "issueId"=$1', [f.taskId, f.elsewhere.id, f.elsewhere.teamId])
          else if (revoked === 'GitHub connection') await pool.query('DELETE FROM github_connections WHERE "userId"=$1', [f.owner.id])
          else await saveGitHubConnection(f.owner.id, { githubAccountId: f.owner.credential.githubAccountId, githubLogin: 'delivery-fixture' },
            { access_token: `fixture-replaced-${randomUUID()}`, expires_in: 3600 })
        }
        await assert.rejects(() => f.deliver(input), code(revoked.startsWith('GitHub') ? 'workspace_review_github_forbidden' : 'workspace_not_found'))
        assert.equal(f.posts().length, 0)
        const rows = await f.rows(); assert.equal(rows.operations.length, 0)
        assert.ok(rows.batches.every(value => value.state === 'prepared'))
        assert.ok(rows.comments.every(value => value.draft))
      })

    await t.test('fresh GitHub repository denial is not bypassed by a valid local session or retained batch evidence', async t => {
      const f = await fixture(t)
      f.state.repositoryStatus = 403
      await assert.rejects(async () => f.deliver(await f.input()), code('workspace_review_github_forbidden'))
      assert.equal(f.posts().length, 0); assert.equal((await f.rows()).batches.length, 0)
    })

    await t.test('source movement before the durable send gate rejects the frozen anchors without posting', async t => {
      const f = await fixture(t), input = await f.input()
      f.state.head = 'd'.repeat(40)
      await assert.rejects(() => f.deliver(input), code('workspace_snapshot_outdated'))
      assert.equal(f.posts().length, 0)
      const rows = await f.rows()
      assert.equal(rows.batches[0]!.state, 'rejected'); assert.equal(rows.operations[0]!.status, 'failed')
      assert.equal(rows.operations[0]!.receipt, null); assert.ok(rows.comments.every(value => value.draft))
    })

    await t.test('a proven before-send rejection permits a new explicit request after restoration while the old request stays rejected', async t => {
      const f = await fixture(t), input = await f.input()
      f.state.head = 'd'.repeat(40)
      await assert.rejects(() => f.deliver(input), code('workspace_snapshot_outdated'))
      let rows = await f.rows()
      assert.equal(f.posts().length, 0); assert.equal(rows.batches.length, 1); assert.equal(rows.operations.length, 1)
      assert.equal(rows.batches[0].state, 'rejected'); assert.equal(rows.operations[0].status, 'failed')
      assert.equal(rows.operations[0].receipt, null)
      const rejected = await f.deliver(input)
      assert.equal(rejected.state, 'rejected'); assert.equal(rejected.batchId, input.batchId); assert.equal(rejected.delivery, null)
      f.state.head = headSha
      const restoredOldRequest = await f.deliver(input)
      assert.equal(restoredOldRequest.state, 'rejected'); assert.equal(restoredOldRequest.batchId, rejected.batchId)
      assert.equal(f.posts().length, 0, 'a refused request ID is immutable even when its target recovers')

      const retry = { ...input, requestId: randomUUID(), batchId: randomUUID(), expectedRevision: await f.boardRevision() }
      const accepted = await f.deliver(retry)
      assert.equal(accepted.state, 'accepted'); assert.equal(accepted.batchId, retry.batchId)
      assert.notEqual(accepted.batchId, rejected.batchId); assert.equal(accepted.delivery?.id, reviewId)
      const repeated = await f.deliver(retry)
      const semantic = await f.deliver({ ...retry, requestId: randomUUID(), batchId: randomUUID() })
      for (const receipt of [repeated, semantic]) {
        assert.equal(receipt.state, 'accepted'); assert.equal(receipt.batchId, accepted.batchId)
        assert.equal(receipt.delivery?.id, accepted.delivery?.id)
      }
      const oldAfterAcceptance = await f.deliver(input)
      assert.equal(oldAfterAcceptance.state, 'rejected'); assert.equal(oldAfterAcceptance.batchId, rejected.batchId)
      rows = await f.rows()
      assert.equal(f.posts().length, 1); assert.equal(rows.batches.length, 2); assert.equal(rows.operations.length, 2)
      const old = rows.batches.find(row => row.id === rejected.batchId), current = rows.batches.find(row => row.id === accepted.batchId)
      assert.ok(old && current)
      assert.equal(old.state, 'rejected'); assert.equal(current.state, 'accepted')
      assert.equal(old.fingerprint, current.fingerprint); assert.deepEqual(old.input, current.input)
      const failed = rows.operations.find(row => row.operationId === rejected.batchId), succeeded = rows.operations.find(row => row.operationId === accepted.batchId)
      assert.ok(failed && succeeded)
      assert.equal(failed.status, 'failed'); assert.equal(failed.receipt, null)
      assert.equal(succeeded.status, 'succeeded'); assert.equal(succeeded.receipt.providerObjectId, reviewId)
      assert.ok(rows.comments.every(value => !value.draft))
    })

    await t.test('publication replacement before the effect lease wins and prevents a POST to the previous pull request', async t => {
      const f = await fixture(t), input = await f.input(), replacement = `https://github.com/${fullName}/pull/8`
      let changed = false
      f.state.onRepository = async () => {
        f.state.onRepository = undefined
        const result = await pool.query('UPDATE run_publications SET "pullRequest"=$2 WHERE "runId"=$1',
          [f.runId, { url: replacement }])
        assert.equal(result.rowCount, 1); changed = true
      }
      await assert.rejects(() => f.deliver(input), code('workspace_snapshot_outdated'))
      assert.equal(changed, true, 'the publication changes after the initial association read and before the effect lease')
      assert.equal(f.posts().length, 0)
      const rows = await f.rows()
      assert.equal(rows.operations.length, 0); assert.ok(rows.batches.every(value => value.state === 'prepared'))
      assert.ok(rows.comments.every(value => value.draft))
      assert.equal((await pool.query('SELECT "pullRequest" FROM run_publications WHERE "runId"=$1', [f.runId])).rows[0].pullRequest.url, replacement)
    })

    await t.test('the effect lease keeps the publication fixed while remote preflight and the native POST are in flight', async t => {
      const f = await fixture(t), input = await f.input(), entered = deferred(), release = deferred()
      const replacement = `https://github.com/${fullName}/pull/8`, writer = await pool.connect()
      let update: Promise<PromiseSettledResult<unknown>[]> | undefined, updateFinished = false
      let boundaryError: unknown, completed: PromiseSettledResult<ReviewBatchReceipt>[] = [], changed: PromiseSettledResult<unknown>[] = []
      try {
        await writer.query("SET statement_timeout='12s'")
        const pid = Number((await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
        const isBlocked = async () => Boolean((await pool.query<{ blocked: boolean }>(
          'SELECT cardinality(pg_blocking_pids($1))>0 AS blocked', [pid])).rows[0]?.blocked)
        f.state.onPull = async () => { f.state.onPull = undefined; entered.resolve(); await release.promise }
        f.state.beforePost = async () => {
          assert.equal(updateFinished, false, 'the publication update must still wait at the actual POST')
          assert.equal(await isBlocked(), true)
        }
        const delivery = Promise.allSettled([f.deliver(input)])
        try {
          await bounded(Promise.race([entered.promise, delivery.then(() => assert.fail('Delivery did not reach the remote preflight boundary'))]))
          update = Promise.allSettled([writer.query('UPDATE run_publications SET "pullRequest"=$2 WHERE "runId"=$1',
            [f.runId, { url: replacement }]).finally(() => { updateFinished = true })])
          let blocked = false
          const deadline = Date.now() + 3000
          while (Date.now() < deadline && !updateFinished) {
            if (await isBlocked()) { blocked = true; break }
            await new Promise(resolve => setTimeout(resolve, 10))
          }
          assert.equal(blocked, true, 'the actual publication UPDATE must wait for the authority transaction')
          assert.equal(updateFinished, false)
          assert.equal((await pool.query('SELECT "pullRequest" FROM run_publications WHERE "runId"=$1', [f.runId])).rows[0].pullRequest.url, publicPull)
        } catch (error) { boundaryError = error }
        finally { release.resolve() }
        // Both operations must finish before the fixture restores the fetch mock.
        completed = await bounded(delivery, 25_000)
      } finally {
        release.resolve()
        try { if (update) changed = await bounded(update, 15_000) }
        finally {
          try { await writer.query('RESET statement_timeout') }
          finally { writer.release() }
        }
      }
      if (boundaryError) throw boundaryError
      assert.ok(update, 'the concurrent replacement was attempted')
      assert.equal(changed[0]?.status, 'fulfilled', changed[0]?.status === 'rejected' ? String(changed[0].reason) : undefined)
      assert.equal(completed[0]?.status, 'fulfilled', completed[0]?.status === 'rejected' ? String(completed[0].reason) : undefined)
      if (completed[0]?.status === 'fulfilled') {
        assert.equal(completed[0].value.state, 'accepted'); assert.equal(completed[0].value.delivery?.id, reviewId)
      }
      assert.equal(f.posts().length, 1)
      const rows = await f.rows()
      assert.equal(rows.batches[0]!.state, 'accepted'); assert.equal(rows.operations[0]!.status, 'succeeded')
      assert.equal((await pool.query('SELECT "pullRequest" FROM run_publications WHERE "runId"=$1', [f.runId])).rows[0].pullRequest.url, replacement)
    })

    await t.test('a newly encrypted secret policy between preparation and send invalidates the complete-source proof', async t => {
      const f = await fixture(t), input = await f.input()
      const prior = await secretMaskerFor({ workspaceId: f.where.id, ownerId: f.owner.id })
      f.state.onPull = async () => {
        f.state.onPull = undefined
        const secret = `delivery-private-${randomUUID()}`, row = { id: randomUUID(), userId: f.owner.id,
          name: 'DELIVERY_POLICY_TEST', kind: 'secret' }
        const sealed = sealSecret(secret, userSecretAad(row))
        await pool.query(`INSERT INTO user_secrets(id,"userId",name,kind,ciphertext,iv,"keyVersion")
          VALUES($1,$2,$3,$4,$5,$6,$7)`, [row.id, row.userId, row.name, row.kind, sealed.ciphertext, sealed.iv, sealed.keyVersion])
        const current = await secretMaskerFor({ workspaceId: f.where.id, ownerId: f.owner.id })
        assert.notEqual(current.sourcePolicy, prior.sourcePolicy); assert.notEqual(current(secret), secret)
      }
      await assert.rejects(() => f.deliver(input), code('workspace_path_unavailable'))
      assert.equal(f.posts().length, 0)
      const rows = await f.rows()
      assert.equal(rows.batches[0]!.state, 'rejected'); assert.equal(rows.operations[0]!.status, 'failed')
      assert.ok(rows.comments.every(value => value.draft))
    })

    await t.test('the 32 KiB immutable batch bound measures JSON UTF-8 bytes and refuses the whole selected set', async t => {
      const f = await fixture(t, { count: 10, body: '界'.repeat(1200) }), input = await f.input()
      assert.ok(f.comments.reduce((sum, value) => sum + Buffer.byteLength(value.body), 0) > 32_768)
      await assert.rejects(() => f.deliver(input), code('workspace_limit_exceeded'))
      const rows = await f.rows()
      assert.equal(rows.batches.length, 0); assert.equal(rows.operations.length, 0)
      assert.equal(rows.comments.length, 10); assert.ok(rows.comments.every(value => value.draft))
      assert.equal(f.posts().length, 0); assert.equal(await f.boardRevision(), input.expectedRevision)
    })

    for (const failure of ['projection', 'ledger commit'] as const)
      await t.test(`a real ${failure} transaction failure never reports accepted and recovers without another POST`, async t => {
        const f = await fixture(t), input = await f.input(), name = `delivery_fixture_${randomUUID().replaceAll('-', '')}`
        const table = failure === 'projection' ? 'coding_workspace_review_batches' : 'operation_ledger'
        const identity = failure === 'projection' ? 'id' : 'operationId', status = failure === 'projection' ? 'state' : 'status'
        const succeeded = failure === 'projection' ? 'accepted' : 'succeeded'
        await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $fixture$
          BEGIN IF NEW."${identity}"='${input.batchId}'::uuid AND NEW.${status}='${succeeded}' THEN
            RAISE EXCEPTION 'controlled_delivery_commit_failure' USING ERRCODE='P0001'; END IF; RETURN NEW; END
          $fixture$`)
        await pool.query(failure === 'projection'
          ? `CREATE TRIGGER ${name} BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`
          : `CREATE CONSTRAINT TRIGGER ${name} AFTER UPDATE ON ${table} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${name}()`)
        try {
          let receipt: ReviewBatchReceipt | undefined
          try { receipt = await f.deliver(input) }
          catch (error) { assert.ok(code('workspace_review_delivery_uncertain')(error), String(error)) }
          if (receipt) { assert.equal(receipt.state, 'uncertain'); assert.equal(receipt.delivery, null) }
          const rows = await f.rows()
          assert.ok(['delivering', 'uncertain'].includes(rows.batches[0]!.state))
          assert.ok(['executing', 'uncertain'].includes(rows.operations[0]!.status))
          assert.equal(rows.operations[0]!.receipt, null); assert.ok(rows.operations[0]!.invokedAt)
          assert.ok(rows.comments.every(value => value.draft)); assert.equal(f.posts().length, 1)
        } finally {
          await pool.query(`DROP TRIGGER ${name} ON ${table}`)
          await pool.query(`DROP FUNCTION ${name}()`)
        }
        const recovered = await f.deliver(input)
        assert.equal(recovered.state, 'accepted'); assert.equal(recovered.delivery?.id, reviewId)
        assert.equal(f.posts().length, 1)
        const rows = await f.rows()
        assert.equal(rows.batches[0]!.state, 'accepted'); assert.equal(rows.operations[0]!.status, 'succeeded')
        assert.ok(rows.comments.every(value => !value.draft))
      })
  } finally {
    mock.restoreAll()
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
    await dropTestDatabase(admin, database, pool, appPool, workspacePool)
    await admin.end()
  }
})
