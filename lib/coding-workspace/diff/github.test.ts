import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { after, before, mock, test, type TestContext } from 'node:test'
import type { Pool } from 'pg'
import { CodingWorkspaceError } from '@mikka/protocol/coding-workspace'
import { diffSnapshot, WorkspaceReviewError, type DiffSnapshot } from '@mikka/protocol/coding-workspace-review'
import { GitHubAccessError } from '../../github/user-access-error'
import { CloudServiceError } from '../../cloud-services/errors'
import type { RequestBudget } from '../../request-budget'
import { createSecretMasker, identityMasker } from '../../secrets/mask'
import type { ReviewScope } from './authority'
import type { ExternalDiffProvider } from './service'
import { diffDigest, hunkFingerprint } from './patch'

const viewer = 'review-viewer', owner = 'run-owner', repositoryKey = 'v2/github.com/fixture/review'
const fullName = 'Fixture/Review', repositoryId = '61393725', number = 7
const apiPath = '/repos/fixture/review'
type Credential = Awaited<ReturnType<typeof import('../../github/user-access')['githubRepositoryReadCredential']>>
const credential = mock.fn(async (_userId: string, _key: string, _budget?: RequestBudget): Promise<Credential> => {
  throw new Error('A provider test must install its viewer credential')
})
const credentialModule = mock.module(new URL('../../github/user-access.ts', import.meta.url).href, { namedExports: {
  githubRepositoryReadCredential: credential, GitHubAccessError,
} })
let github: typeof import('./github')
before(async () => { github = await import('./github') })
after(() => credentialModule.restore())

const code = (expected: string) => (error: unknown) =>
  (error instanceof CodingWorkspaceError || error instanceof WorkspaceReviewError) && error.code === expected
const objectId = (kind: 'blob' | 'tree' | 'commit', bytes: Buffer) =>
  createHash('sha1').update(`${kind} ${bytes.length}\0`).update(bytes).digest('hex')
type Source = { path: string; bytes: Buffer; mode: string }
function gitTree(files: Source[]) {
  const entries = [...files].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
    .map(file => ({ path: file.path, sha: objectId('blob', file.bytes), mode: file.mode, type: 'blob', size: file.bytes.length }))
  // Real Git tree/commit/blob object IDs, including binary OIDs in tree bytes.
  const bytes = Buffer.concat(entries.flatMap(entry => [Buffer.from(`${entry.mode} ${entry.path}\0`), Buffer.from(entry.sha, 'hex')]))
  return { sha: objectId('tree', bytes), truncated: false, tree: entries }
}
function gitCommit(tree: string, message: string, parent?: string) {
  const bytes = Buffer.from(`tree ${tree}\n${parent ? `parent ${parent}\n` : ''}author Fixture <fixture@example.invalid> 0 +0000\ncommitter Fixture <fixture@example.invalid> 0 +0000\n\n${message}\n`)
  return { sha: objectId('commit', bytes), tree: { sha: tree } }
}
type NativeFile = { filename: string; status: 'added' | 'modified'; sha: string; additions: number; deletions: number;
  patch?: string; raw_url: string; contents_url: string }
type FactoryRow = { id: string; taskId: string; runId: string; sha: string | null; kind: string; repository: string;
  pullRequest: unknown; skill: boolean }
type Capture = Awaited<ReturnType<ExternalDiffProvider['capture']>>

function fixture(t: TestContext, options: { count?: number; added?: boolean; before?: string; after?: string; patch?: string } = {}) {
  const count = options.count ?? 1
  const beforeFiles: Source[] = [], afterFiles: Source[] = []
  const native: NativeFile[] = [], blobs = new Map<string, Buffer>()
  for (let index = 0; index < count; index++) {
    const path = `f${index}.txt`, old = Buffer.from(options.before ?? `before ${index}\n`), next = Buffer.from(options.after ?? `after ${index}\n`)
    if (!options.added) beforeFiles.push({ path, bytes: old, mode: '100644' })
    afterFiles.push({ path, bytes: next, mode: '100644' })
    blobs.set(objectId('blob', old), old); blobs.set(objectId('blob', next), next)
    native.push({ filename: path, status: options.added ? 'added' : 'modified', sha: objectId('blob', next), additions: 1,
      deletions: options.added ? 0 : 1, patch: options.patch ?? (options.added ? `@@ -0,0 +1 @@\n+after ${index}\n`
        : `@@ -1 +1 @@\n-before ${index}\n+after ${index}\n`),
      raw_url: `https://raw.githubusercontent.com/other/private/main/${path}`, contents_url: 'https://outside.invalid/contents' })
  }
  const beforeTree = gitTree(beforeFiles), afterTree = gitTree(afterFiles)
  const base = gitCommit(beforeTree.sha, 'common ancestor'), head = gitCommit(afterTree.sha, 'PR head', base.sha)
  const target = gitCommit(beforeTree.sha, 'current target branch', base.sha)
  const replacementHead = gitCommit(afterTree.sha, 'force pushed head', base.sha)
  const replacementBase = gitCommit(beforeTree.sha, 'advanced target branch', target.sha)
  const scope: ReviewScope = { identity: { version: 1, runId: randomUUID(), repoId: randomUUID(), ownerId: owner,
    workspaceId: randomUUID(), repositoryKey }, taskId: randomUUID(), boardId: diffDigest('fixture board'), status: 'stopped', stopped: true }
  const grant: Credential = { token: 'fixture-viewer-token', githubAccountId: '73', kind: 'user', repository: {
    id: repositoryId, installationId: '11', fullName, htmlUrl: `https://github.com/${fullName}`, private: true,
  } }
  const pull = { number, html_url: `https://github.com/${fullName}/pull/${number}`, state: 'open', merged: false,
    changed_files: count, base: { sha: target.sha, repo: { id: Number(repositoryId), full_name: fullName } }, head: { sha: head.sha } }
  const state = {
    grant, pull, native, beforeTree, afterTree, base, head, target, replacementHead, replacementBase, blobs,
    direct: [{ pullRequest: { url: `https://github.com/${fullName}/pull/${number}` } }] as { pullRequest: unknown }[],
    related: [] as FactoryRow[], pulls: 0,
    onRequest: undefined as ((url: URL) => Response | undefined) | undefined,
    onQuery: undefined as ((sql: string, values: unknown[]) => void) | undefined,
  }
  const queries: { sql: string; values: unknown[] }[] = []
  const database = { async query(sql: string, values: unknown[] = []) {
    queries.push({ sql, values }); state.onQuery?.(sql, values)
    assert.deepEqual(values, [scope.identity.runId, owner, scope.taskId, repositoryKey])
    const rows = sql.includes('WITH related AS') ? state.related : sql.includes('FROM run_publications p') ? state.direct : undefined
    assert.ok(rows, 'only immutable host publication/original Factory association queries are allowed')
    return { rows: structuredClone(rows), rowCount: rows.length, command: 'SELECT', fields: [], oid: 0 }
  } } as unknown as Pool
  credential.mock.resetCalls()
  credential.mock.mockImplementation(async (userId, key, budget) => {
    assert.equal(userId, viewer, 'GitHub credentials belong to the actual viewer, never the Run owner')
    assert.equal(key, repositoryKey)
    assert.ok(budget && Number.isFinite(budget.deadline))
    return state.grant
  })
  const requests: URL[] = []
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)); requests.push(url)
    assert.equal(url.origin, 'https://api.github.com')
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${state.grant.token}`)
    assert.equal(init?.redirect, 'error')
    assert.equal(init?.credentials, 'omit')
    assert.equal(init?.cache, 'no-store')
    const response = state.onRequest?.(url)
    if (response) return response
    if (url.pathname === `${apiPath}/pulls/${number}`) { state.pulls++; return Response.json(state.pull) }
    if (url.pathname === `${apiPath}/compare/${state.target.sha}...${state.head.sha}`) {
      assert.equal(url.search, '?per_page=1')
      return Response.json({ base_commit: { sha: state.target.sha }, merge_base_commit: { sha: state.base.sha },
        // This intentionally incomplete convenience list is not manifest proof.
        files: state.native.slice(0, 1), total_commits: 900, truncated: true })
    }
    if (url.pathname === `${apiPath}/pulls/${number}/files`) {
      assert.equal(url.searchParams.get('per_page'), '100')
      const page = Number(url.searchParams.get('page')), start = (page - 1) * 100
      return Response.json(state.native.slice(start, start + 100), { headers: start + 100 < state.native.length
        ? { link: '<https://outside.invalid/not-an-api-page>; rel="next"' } : {} })
    }
    const commit = [state.base, state.head].find(item => url.pathname === `${apiPath}/git/commits/${item.sha}`)
    if (commit) return Response.json(commit)
    const tree = [state.beforeTree, state.afterTree].find(item => url.pathname === `${apiPath}/git/trees/${item.sha}`)
    if (tree) { assert.equal(url.search, '?recursive=1'); return Response.json(tree) }
    const sha = url.pathname.split('/').at(-1)!, bytes = state.blobs.get(sha)
    if (url.pathname.startsWith(`${apiPath}/git/blobs/`) && bytes)
      return Response.json({ sha, size: bytes.length, encoding: 'base64', content: bytes.toString('base64') })
    throw new Error(`Unexpected fixture endpoint ${url.pathname}`)
  })
  const provider = github.githubDiffProvider(database, viewer)
  const capture = () => provider.capture(scope, { source: 'pull_request' }, identityMasker)
  const snapshot = (captured: Capture): DiffSnapshot => diffSnapshot.parse({ id: randomUUID(), identity: scope.identity,
    taskId: scope.taskId, revision: captured.revision, observedAt: new Date().toISOString(), isStale: false,
    availability: captured.files.length ? 'available' : 'empty', reason: null,
    counts: { files: captured.files.length, additions: 0, deletions: 0, complete: false },
    policy: captured.revision.source === 'commit' ? 'explicit_commits' : 'whole_pull_request',
    pullRequest: captured.pullRequest ?? null, ...(captured.sourceAccess ? { sourceAccess: captured.sourceAccess } : {}),
    ...(captured.factory ? { factory: captured.factory } : {}) })
  const candidate = (): FactoryRow => ({ id: randomUUID(), taskId: randomUUID(), runId: randomUUID(), sha: head.sha,
    kind: 'repository', repository: 'https://github.com/fixture/review.git',
    pullRequest: { url: `https://github.com/${fullName}/pull/${number}` }, skill: false })
  return { state, scope, database, queries, requests, provider, capture, snapshot, candidate }
}

test('a whole PR uses the viewer credential, every native page and both complete immutable trees', async t => {
  const f = fixture(t, { count: 101 }), captured = await f.capture()
  assert.equal(credential.mock.callCount(), 1)
  assert.equal(credential.mock.calls[0]!.arguments[0], viewer)
  assert.notEqual(viewer, f.scope.identity.ownerId)
  assert.equal(captured.files.length, 101)
  assert.equal(captured.revision.baseSha, f.state.base.sha)
  assert.equal(captured.revision.headSha, f.state.head.sha)
  assert.notEqual(captured.revision.baseSha, f.state.target.sha, 'the PR target tip and validated merge-base are distinct')
  assert.deepEqual(captured.sourceAccess, { kind: 'github', repositoryId, manifestComplete: true,
    pullRequestNumber: number, pullRequestBaseSha: f.state.target.sha })
  assert.equal(captured.pullRequest?.baseSha, f.state.target.sha)
  assert.equal(captured.files.find(file => file.path === 'f100.txt')?.github?.page, 2)
  assert.deepEqual(f.requests.filter(url => url.pathname.endsWith('/files')).map(url => url.search),
    ['?per_page=100&page=1', '?per_page=100&page=2'])
  assert.deepEqual(f.requests.filter(url => url.pathname.includes('/git/commits/')).map(url => url.pathname.split('/').at(-1)).sort(),
    [f.state.base.sha, f.state.head.sha].sort())
  assert.equal(f.requests.filter(url => url.pathname.includes('/git/trees/')).length, 2)
  assert.ok(!f.requests.some(url => /raw|contents|branches|refs/.test(url.pathname)))
  assert.equal(f.state.pulls, 2, 'PR identity is checked again after the complete tree comparison')
  assert.ok(!JSON.stringify(captured).includes(f.state.grant.token))
})

test('the native PR limit accepts all 3000 small files and rejects 3001 before pagination', async t => {
  await t.test('3000', async t => {
    const f = fixture(t, { count: 3000, added: true }), captured = await f.capture()
    assert.equal(captured.files.length, 3000)
    assert.equal(f.requests.filter(url => url.pathname.endsWith('/files')).length, 30)
    assert.ok(f.requests.length <= 48)
  })
  await t.test('3001', async t => {
    const f = fixture(t); f.state.pull.changed_files = 3001
    await assert.rejects(f.capture(), code('workspace_limit_exceeded'))
    assert.equal(f.requests.length, 1)
  })
})

test('page lengths, continuations, uniqueness and the complete tree delta must agree', async t => {
  for (const failure of ['short page', 'missing next', 'extra next', 'duplicate path', 'tree omits native', 'native omits tree'] as const)
    await t.test(failure, async t => {
      const f = fixture(t, { count: failure === 'native omits tree' ? 2 : 101 })
      if (failure === 'native omits tree') { f.state.pull.changed_files = 1; f.state.native.splice(1) }
      else if (failure === 'tree omits native') f.state.afterTree.tree.pop()
      else if (failure === 'duplicate path') f.state.native[100] = { ...f.state.native[0]! }
      else f.state.onRequest = url => {
        if (!url.pathname.endsWith('/files')) return
        const page = Number(url.searchParams.get('page'))
        if (failure === 'short page' && page === 1) return Response.json(f.state.native.slice(0, 99), { headers: { link: '<https://outside.invalid>; rel="next"' } })
        if (failure === 'missing next' && page === 1) return Response.json(f.state.native.slice(0, 100))
        if (failure === 'extra next' && page === 2) return Response.json(f.state.native.slice(100), { headers: { link: '<https://outside.invalid>; rel="next"' } })
      }
      await assert.rejects(f.capture(), code('workspace_snapshot_unavailable'))
      assert.ok(!f.requests.some(url => url.pathname.includes('/git/blobs/')), 'manifest capture never fetches partial file bodies')
    })
})

test('a compare merge-base is only a candidate until complete tree identities and coverage validate', async t => {
  for (const failure of ['wrong compare base', 'wrong commit identity', 'wrong tree identity', 'truncated tree'] as const)
    await t.test(failure, async t => {
      const f = fixture(t)
      f.state.onRequest = url => {
        if (failure === 'wrong compare base' && url.pathname.includes('/compare/'))
          return Response.json({ base_commit: { sha: f.state.replacementBase.sha }, merge_base_commit: { sha: f.state.base.sha } })
        if (failure === 'wrong commit identity' && url.pathname === `${apiPath}/git/commits/${f.state.base.sha}`)
          return Response.json({ ...f.state.base, sha: f.state.replacementBase.sha })
        if (url.pathname === `${apiPath}/git/trees/${f.state.beforeTree.sha}`) {
          if (failure === 'wrong tree identity') return Response.json({ ...f.state.beforeTree, sha: f.state.afterTree.sha })
          if (failure === 'truncated tree') return Response.json({ ...f.state.beforeTree, truncated: true })
        }
      }
      await assert.rejects(f.capture(), code('workspace_snapshot_unavailable'))
    })
})

test('lazy PR files use immutable verified blobs and preserve the native hunk anchors', async t => {
  const f = fixture(t), captured = await f.capture(), snapshot = f.snapshot(captured), file = captured.files[0]!
  const patch = await f.provider.file(f.scope, snapshot, file, identityMasker)
  assert.equal(patch.format, 'text')
  assert.equal(patch.file.fileVersion, file.fileVersion)
  assert.ok(patch.patch?.endsWith(f.state.native[0]!.patch!))
  assert.equal(patch.hunks.length, 1)
  assert.deepEqual(patch.hunks[0]!.lines, ['-before 0', '+after 0'])
  assert.equal(patch.hunks[0]!.fingerprint, hunkFingerprint(snapshot.revision.version, file.fileVersion, patch.hunks[0]!))
  assert.deepEqual(f.requests.filter(url => url.pathname.includes('/git/blobs/')).map(url => url.pathname.split('/').at(-1)).sort(),
    [file.oldBlob, file.newBlob].sort())
  assert.equal(patch.file.additions, 1)
  assert.equal(patch.file.deletions, 1)
  assert.ok(!JSON.stringify(patch).includes('base64'))
})

test('a missing native patch remains unavailable and is never replaced with a synthesized anchor', async t => {
  const f = fixture(t); delete f.state.native[0]!.patch
  const captured = await f.capture(), snapshot = f.snapshot(captured)
  const patch = await f.provider.file(f.scope, snapshot, captured.files[0]!, identityMasker)
  assert.equal(patch.format, 'unavailable')
  assert.equal(patch.patch, null)
  assert.deepEqual(patch.hunks, [])
  assert.equal(f.requests.filter(url => url.pathname.includes('/git/blobs/')).length, 2)
})

test('blob identities, canonical base64 and exact full lengths are checked before any patch returns', async t => {
  for (const failure of ['hash', 'object id', 'declared size', 'body size', 'base64', 'encoding'] as const)
    await t.test(failure, async t => {
      const f = fixture(t), captured = await f.capture(), snapshot = f.snapshot(captured), file = captured.files[0]!
      const bytes = f.state.blobs.get(file.newBlob!)!
      f.state.onRequest = url => {
        if (url.pathname !== `${apiPath}/git/blobs/${file.newBlob}`) return
        const value = { sha: file.newBlob, size: bytes.length, encoding: 'base64', content: bytes.toString('base64') }
        if (failure === 'hash') value.content = Buffer.alloc(bytes.length, 120).toString('base64')
        if (failure === 'object id') value.sha = file.oldBlob
        if (failure === 'declared size') value.size++
        if (failure === 'body size') value.content = Buffer.concat([bytes, Buffer.from('x')]).toString('base64')
        if (failure === 'base64') value.content += '!'
        if (failure === 'encoding') value.encoding = 'utf8'
        return Response.json(value)
      }
      await assert.rejects(f.provider.file(f.scope, snapshot, file, identityMasker), code('workspace_snapshot_unavailable'))
    })
})

test('native patch agreement does not replace whole-source masking or byte validation', async t => {
  await t.test('multiline secret outside the hunk', async t => {
    const secret = 'private-first-line\nprivate-second-line'
    const f = fixture(t, { before: `${secret}\nbefore\n`, after: `${secret}\nafter\n`, patch: '@@ -3 +3 @@\n-before\n+after\n' })
    const captured = await f.capture(), snapshot = f.snapshot(captured)
    assert.ok(!f.state.native[0]!.patch!.includes(secret))
    await assert.rejects(f.provider.file(f.scope, snapshot, captured.files[0]!, createSecretMasker([{ name: 'MULTILINE', value: secret }])),
      code('workspace_path_unavailable'))
  })
  await t.test('hash-bound native patch with incorrect coordinates', async t => {
    const f = fixture(t); f.state.native[0]!.patch = '@@ -2 +2 @@\n-before 0\n+after 0\n'
    const captured = await f.capture(), snapshot = f.snapshot(captured)
    assert.equal(captured.files[0]!.github?.patchSha256, diffDigest(f.state.native[0]!.patch!))
    await assert.rejects(f.provider.file(f.scope, snapshot, captured.files[0]!, identityMasker), code('workspace_snapshot_unavailable'))
  })
})

test('capture rejects force-pushes, base changes and publication changes observed at its final fence', async t => {
  for (const change of ['head', 'base', 'publication'] as const) await t.test(change, async t => {
    const f = fixture(t)
    if (change === 'publication') f.state.onQuery = sql => {
      if (sql.includes('FROM run_publications p') && f.queries.filter(item => item.sql.includes('FROM run_publications p')).length === 2)
        f.state.direct = [{ pullRequest: { url: `https://github.com/${fullName}/pull/8` } }]
    }
    else f.state.onRequest = url => {
      if (url.pathname === `${apiPath}/pulls/${number}` && f.state.pulls === 1) {
        if (change === 'head') f.state.pull.head.sha = f.state.replacementHead.sha
        else f.state.pull.base.sha = f.state.replacementBase.sha
      }
    }
    await assert.rejects(f.capture(), code('workspace_snapshot_outdated'))
  })
})

test('lazy reads refuse head/base changes both before reading blobs and after the complete blob fetch', async t => {
  for (const change of ['head', 'base'] as const) for (const when of ['before', 'during'] as const)
    await t.test(`${change} ${when}`, async t => {
      const f = fixture(t), captured = await f.capture(), snapshot = f.snapshot(captured)
      const mutate = () => {
        if (change === 'head') f.state.pull.head.sha = f.state.replacementHead.sha
        else f.state.pull.base.sha = f.state.replacementBase.sha
      }
      if (when === 'before') mutate()
      else f.state.onRequest = url => { if (url.pathname.includes('/git/blobs/')) mutate() }
      await assert.rejects(f.provider.file(f.scope, snapshot, captured.files[0]!, identityMasker), code('workspace_snapshot_outdated'))
      assert.equal(f.requests.filter(url => url.pathname.includes('/git/blobs/')).length, when === 'before' ? 0 : 2)
    })
})

test('a native patch that moves without its frozen PR head cannot silently re-anchor a lazy file', async t => {
  const f = fixture(t), captured = await f.capture(), snapshot = f.snapshot(captured)
  f.state.native[0]!.patch = '@@ -1 +1 @@ different context\n-before 0\n+after 0\n'
  await assert.rejects(f.provider.file(f.scope, snapshot, captured.files[0]!, identityMasker), code('workspace_snapshot_outdated'))
  assert.equal(f.requests.filter(url => url.pathname.includes('/git/blobs/')).length, 0)
})

test('GitHub commit source remains authenticated after Stop without any device or publication lookup', async t => {
  const f = fixture(t)
  const captured = await f.provider.capture(f.scope, { source: 'commit', baseSha: f.state.base.sha, headSha: f.state.head.sha }, identityMasker)
  assert.deepEqual(captured.sourceAccess, { kind: 'github', repositoryId, manifestComplete: true })
  assert.equal(captured.pullRequest, undefined)
  const snapshot = f.snapshot(captured)
  const fresh = github.githubDiffProvider(f.database, viewer)
  assert.deepEqual(await fresh.verify(f.scope, snapshot), { isStale: false })
  const patch = await fresh.file(f.scope, snapshot, captured.files[0]!, identityMasker)
  assert.equal(patch.format, 'text')
  assert.equal(f.scope.stopped, true)
  assert.ok(!('deviceId' in f.scope.identity))
  assert.equal(f.queries.length, 0, 'a stopped GitHub commit never falls back to a device or Task latest PR')
  assert.equal(credential.mock.callCount(), 2, 'a later request reauthorizes the actual viewer')
  credential.mock.mockImplementation(async () => { throw new GitHubAccessError('githubRepositoryForbidden', 403) })
  const denied = github.githubDiffProvider(f.database, viewer), count = f.requests.length
  await assert.rejects(denied.verify(f.scope, snapshot), code('workspace_review_github_forbidden'))
  assert.equal(f.requests.length, count)
})

test('repository ID replacement under the same owner/name cannot authorize a retained snapshot', async t => {
  for (const source of ['pull_request', 'commit'] as const) await t.test(source, async t => {
    const f = fixture(t), captured = source === 'pull_request' ? await f.capture()
      : await f.provider.capture(f.scope, { source, baseSha: f.state.base.sha, headSha: f.state.head.sha }, identityMasker)
    const snapshot = f.snapshot(captured), before = f.requests.length
    f.state.grant = { ...f.state.grant, repository: { ...f.state.grant.repository, id: '61393726' } }
    const fresh = github.githubDiffProvider(f.database, viewer)
    await assert.rejects(fresh.verify(f.scope, snapshot), code('workspace_review_github_forbidden'))
    assert.equal(f.requests.length, before, 'same-name replacement cannot even fetch the old file')
  })
})

test('a PR envelope must match the authorized numeric repository identity and canonical publication', async t => {
  for (const change of ['repository id', 'full name', 'number', 'URL'] as const) await t.test(change, async t => {
    const f = fixture(t)
    if (change === 'repository id') f.state.pull.base.repo.id++
    if (change === 'full name') f.state.pull.base.repo.full_name = 'Other/Review'
    if (change === 'number') f.state.pull.number++
    if (change === 'URL') f.state.pull.html_url = 'https://outside.invalid/pull/7'
    await assert.rejects(f.capture(), code('workspace_snapshot_unavailable'))
    assert.equal(f.requests.length, 1)
  })
})

test('host publication association is frozen to this Run/owner/Task/repository and never a Task latest PR', async t => {
  const f = fixture(t)
  assert.deepEqual(await github.associatedGitHubPull(f.database, f.scope), { number })
  assert.equal(f.queries.length, 2)
  const direct = f.queries.find(query => query.sql.includes('FROM run_publications p'))!
  assert.match(direct.sql, /r\.id=\$1/)
  assert.match(direct.sql, /r\."userId"=\$2/)
  assert.match(direct.sql, /r\."issueId"=\$3/)
  assert.match(direct.sql, /p\."remoteKey"=\$4/)
  assert.match(direct.sql, /p\.status='published'/)
  assert.ok(f.queries.every(query => !/ORDER BY|currentCandidateId|latestPullRequest|FROM issues\b/i.test(query.sql)))
  f.state.direct = []
  await assert.rejects(github.associatedGitHubPull(f.database, f.scope), code('workspace_snapshot_unavailable'))
  assert.equal(f.requests.length, 0)
})

test('Factory review stays on the original candidate/producer and its host publication', async t => {
  const f = fixture(t), candidate = f.candidate()
  f.state.direct = []; f.state.related = [candidate]
  assert.notEqual(candidate.runId, f.scope.identity.runId, 'the reviewed Run may be a later attempt')
  const association = await github.associatedGitHubPull(f.database, f.scope)
  assert.deepEqual(association, { number, factory: { taskId: candidate.taskId, candidateId: candidate.id,
    producerRunId: candidate.runId, sha: candidate.sha } })
  const related = f.queries.find(query => query.sql.includes('WITH related AS'))!
  assert.match(related.sql, /factory_candidates c WHERE c\."runId"=\$1/)
  assert.match(related.sql, /factory_attempts a JOIN factory_candidates c ON c\.id=a\."candidateId"/)
  assert.match(related.sql, /a\."runId"=\$1/)
  assert.match(related.sql, /p\."runId"=producer\.id/)
  assert.doesNotMatch(related.sql, /currentCandidateId|ORDER BY|LIMIT 1/)
  const captured = await f.capture()
  assert.deepEqual(captured.factory, association.factory)
  f.state.pull.head.sha = f.state.replacementHead.sha
  await assert.rejects(f.capture(), code('workspace_snapshot_outdated'), 'a changed head cannot be relabeled as the original Factory candidate')
})

test('ambiguous, untrusted or mismatched publication/candidate associations fail closed', async t => {
  for (const change of ['missing Task', 'direct duplicate', 'candidate duplicate', 'foreign URL', 'raw URL', 'unsafe PR number',
    'skill candidate', 'non-repository candidate', 'candidate repository', 'candidate sha', 'conflicting publications'] as const)
    await t.test(change, async t => {
      const f = fixture(t), candidate = f.candidate()
      if (change === 'missing Task') f.scope.taskId = null
      else if (change === 'direct duplicate') f.state.direct.push(f.state.direct[0]!)
      else if (change === 'foreign URL') f.state.direct[0]!.pullRequest = { url: 'https://github.com/other/private/pull/7' }
      else if (change === 'raw URL') f.state.direct[0]!.pullRequest = { url: 'https://raw.githubusercontent.com/fixture/review/pull/7' }
      else if (change === 'unsafe PR number') f.state.direct[0]!.pullRequest = { url: `https://github.com/${fullName}/pull/9007199254740992` }
      else {
        f.state.related = [candidate]
        if (change === 'candidate duplicate') f.state.related.push({ ...candidate, id: randomUUID() })
        if (change === 'skill candidate') candidate.skill = true
        if (change === 'non-repository candidate') candidate.kind = 'skill'
        if (change === 'candidate repository') candidate.repository = 'https://github.com/other/private.git'
        if (change === 'candidate sha') candidate.sha = 'not-an-immutable-oid'
        if (change === 'conflicting publications') candidate.pullRequest = { url: `https://github.com/${fullName}/pull/8` }
      }
      await assert.rejects(github.associatedGitHubPull(f.database, f.scope), code('workspace_snapshot_unavailable'))
      assert.equal(f.requests.length, 0)
    })
})

test('viewer credential failure has no owner fallback and sends no GitHub source request', async t => {
  for (const [failure, expected] of [
    [new GitHubAccessError('githubRepositoryForbidden', 403), 'workspace_review_github_forbidden'],
    [new GitHubAccessError('githubNotConnected', 409), 'workspace_review_github_forbidden'],
    [new GitHubAccessError('githubUnavailable', 502), 'workspace_review_github_unavailable'],
    [new GitHubAccessError('githubNotConfigured', 503), 'workspace_review_github_unavailable'],
    [new CloudServiceError('cloud_access_denied'), 'workspace_review_github_forbidden'],
    [new CloudServiceError('cloud_unavailable'), 'workspace_review_github_unavailable'],
  ] as const) await t.test(failure.code, async t => {
    const f = fixture(t)
    credential.mock.mockImplementation(async userId => { assert.equal(userId, viewer); throw failure })
    await assert.rejects(f.capture(), code(expected))
    assert.equal(credential.mock.callCount(), 1)
    assert.equal(f.requests.length, 0)
    assert.equal(f.queries.length, 0)
  })
})
