import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { findRepository, resolveRepository, withResolvedRepository, type RepositoryLister } from './repository-resolution'
import { GITHUB_APP_INSTALL_URL } from '@/lib/github/repository-match'

const ISSUE = '550e8400-e29b-41d4-a716-446655440000'
const repos = (...names: string[]) => ({ repositories: names.map(fullName => ({ fullName, private: true })) })
/** Each user's own list; the lister is only ever asked for the dispatching user. */
const byUser: Record<string, ReturnType<typeof repos>> = {
  alex: repos('alexj11324/Mikka_test', 'alexj11324/Mikka', 'mikka-org/web'),
  other: repos('someone/secret-repo', 'someone/Mikka_test', 'org2/mikka-test'),
}
const lister = () => mock.fn<RepositoryLister>(async userId => byUser[userId] ?? repos())
const accessError = (code: string) => Object.assign(new Error(code), { name: 'GitHubAccessError', code, status: 409 })

test('one match dispatches straight away with owner/repo; the lister is asked for the dispatching user only', async () => {
  for (const name of ['Mikka_test', 'mikka-test', 'MIKKA.TEST']) {
    const list = lister(), dispatch = mock.fn(async (repo: string) => ({ runId: 'run', repo }))
    assert.deepEqual(await withResolvedRepository('alex', ISSUE, name, dispatch, list), { runId: 'run', repo: 'alexj11324/Mikka_test' })
    assert.deepEqual(dispatch.mock.calls.map(call => call.arguments), [['alexj11324/Mikka_test']])
    assert.deepEqual(list.mock.calls.map(call => call.arguments), [['alex']])
  }
})

test('owner/repo and URLs pass unchanged without asking GitHub', async () => {
  for (const repo of ['alexj11324/Mikka_test', 'https://github.com/alexj11324/Mikka_test', 'git@github.com:alexj11324/Mikka_test.git']) {
    const list = lister(), dispatch = mock.fn(async (value: string) => value)
    assert.equal(await withResolvedRepository('alex', ISSUE, repo, dispatch, list), repo)
    assert.equal(list.mock.callCount(), 0)
  }
})

test('several matches return the candidates as one choice card and dispatch nothing', async () => {
  const dispatch = mock.fn(async () => ({ runId: 'run' }))
  const list = mock.fn<RepositoryLister>(async () => repos('alexj11324/Mikka_test', 'mikka-org/mikka-test'))
  assert.deepEqual(await withResolvedRepository('alex', ISSUE, 'mikka.test', dispatch, list), {
    error: 'repositoryAmbiguous', issueId: ISSUE,
    card: { title: '多个仓库匹配 mikka.test', options: [{ value: 'alexj11324/Mikka_test', label: 'alexj11324/Mikka_test' }, { value: 'mikka-org/mikka-test', label: 'mikka-org/mikka-test' }] },
  })
  assert.equal(dispatch.mock.callCount(), 0)
})

test('no match returns the GitHub install option and dispatches nothing', async () => {
  const dispatch = mock.fn(async () => ({ runId: 'run' }))
  assert.deepEqual(await withResolvedRepository('alex', ISSUE, 'nothing-here', dispatch, lister()), {
    error: 'repositoryNotFound', issueId: ISSUE,
    card: { title: '已授权的仓库里没有叫 nothing-here 的', options: [{ value: 'githubInstall', label: '在 GitHub 上授权更多仓库', action: 'githubInstall' }] },
  })
  assert.equal(dispatch.mock.callCount(), 0)
  assert.equal(GITHUB_APP_INSTALL_URL, 'https://github.com/apps/mikka-github/installations/new')
})

test('another user\'s repositories are never matched', async () => {
  const list = lister(), dispatch = mock.fn(async (repo: string) => repo)
  const result = await withResolvedRepository('alex', ISSUE, 'secret-repo', dispatch, list)
  assert.equal('error' in Object(result) && (result as { error: string }).error, 'repositoryNotFound')
  assert.equal(dispatch.mock.callCount(), 0)
  // "Mikka_test" exists for the other user too, under two owners; alex still gets only his own one.
  assert.deepEqual(await resolveRepository('alex', 'Mikka_test', list), { repo: 'alexj11324/Mikka_test' })
  assert.deepEqual(list.mock.calls.map(call => call.arguments), [['alex'], ['alex']])
  assert.deepEqual(await findRepository('alex', 'secret-repo', list), { match: 'none', card: { title: '已授权的仓库里没有叫 secret-repo 的', options: [{ value: 'githubInstall', label: '在 GitHub 上授权更多仓库', action: 'githubInstall' }] } })
})

test('GitHub not connected or unavailable is a clear error and dispatches nothing; other failures still throw', async () => {
  const dispatch = mock.fn(async () => ({ runId: 'run' }))
  for (const code of ['githubNotConnected', 'githubNotConfigured', 'githubReconnectRequired', 'githubUnavailable']) {
    const list = mock.fn<RepositoryLister>(async () => { throw accessError(code) })
    assert.deepEqual(await withResolvedRepository('alex', ISSUE, 'Mikka_test', dispatch, list), { error: code, repository: 'Mikka_test', issueId: ISSUE })
    assert.deepEqual(await findRepository('alex', 'Mikka_test', list), { error: code })
  }
  assert.equal(dispatch.mock.callCount(), 0)
  await assert.rejects(resolveRepository('alex', 'Mikka_test', async () => { throw new Error('boom') }), /boom/)
})

test('find_repository lists the user\'s own repositories, matches a name, and an owner/repo exactly', async () => {
  assert.deepEqual(await findRepository('alex', undefined, lister()), { total: 3, repositories: ['alexj11324/Mikka_test', 'alexj11324/Mikka', 'mikka-org/web'] })
  assert.deepEqual(await findRepository('alex', '  ', lister()), { total: 3, repositories: ['alexj11324/Mikka_test', 'alexj11324/Mikka', 'mikka-org/web'] })
  const many = mock.fn<RepositoryLister>(async () => repos(...Array.from({ length: 70 }, (_, index) => `o/r${index}`)))
  const listed = await findRepository('alex', undefined, many) as { total: number; repositories: string[] }
  assert.deepEqual([listed.total, listed.repositories.length], [70, 50])
  assert.deepEqual(await findRepository('alex', 'mikka test', lister()), { match: 'one', repository: 'alexj11324/Mikka_test' })
  assert.deepEqual(await findRepository('alex', 'ALEXJ11324/mikka_test', lister()), { match: 'one', repository: 'alexj11324/Mikka_test' })
  assert.deepEqual(await findRepository('alex', 'https://github.com/mikka-org/web.git', lister()), { match: 'one', repository: 'mikka-org/web' })
  const several = await findRepository('other', 'mikka.test', lister()) as { match: string; candidates: string[] }
  assert.deepEqual([several.match, several.candidates], ['several', ['someone/Mikka_test', 'org2/mikka-test']])
})
