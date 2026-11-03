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
const noContext = async () => ({ text: '', used: [] })
const accessError = (code: string) => Object.assign(new Error(code), { name: 'GitHubAccessError', code, status: 409 })

test('one match dispatches straight away with owner/repo; the lister is asked for the dispatching user only', async () => {
  for (const name of ['Mikka_test', 'mikka-test', 'MIKKA.TEST']) {
    const list = lister(), dispatch = mock.fn(async (repo: string) => ({ runId: 'run', repo }))
    assert.deepEqual(await withResolvedRepository('alex', ISSUE, name, dispatch, list), { runId: 'run', repo: 'alexj11324/Mikka_test' })
    assert.deepEqual(dispatch.mock.calls.map(call => call.arguments), [['alexj11324/Mikka_test']])
    assert.deepEqual(list.mock.calls.map(call => call.arguments), [['alex']])
  }
})

test('a GitHub repository named by owner/repo or URL runs only when the person authorized it; other hosts go on as given', async () => {
  for (const repo of ['alexj11324/Mikka_test', 'https://github.com/alexj11324/Mikka_test', 'git@github.com:alexj11324/Mikka_test.git']) {
    const dispatch = mock.fn(async (value: string) => value)
    assert.equal(await withResolvedRepository('alex', ISSUE, repo, dispatch, lister(), noContext), repo)
  }
  const dispatch = mock.fn(async (value: string) => value)
  const foreign = await withResolvedRepository('alex', ISSUE, 'someone/secret-repo', dispatch, lister(), noContext) as { error?: string }
  assert.equal(foreign.error, 'repositoryNotFound', 'an owner/repo outside the authorized list is refused')
  assert.equal(dispatch.mock.callCount(), 0)
  const elsewhere = mock.fn<RepositoryLister>(async () => repos())
  assert.equal(await withResolvedRepository('alex', ISSUE, 'https://gitlab.example/team/app.git', dispatch, elsewhere, noContext), 'https://gitlab.example/team/app.git')
  assert.equal(elsewhere.mock.callCount(), 0, 'another host is not asked of GitHub')
  // No GitHub connection: no list to check against, the computer clones with its own credentials.
  assert.equal(await withResolvedRepository('alex', ISSUE, 'octo/repo', dispatch, async () => { throw accessError('githubNotConnected') }, noContext), 'octo/repo')
  for (const code of ['githubUnavailable', 'githubReconnectRequired'])
    assert.equal(await withResolvedRepository('alex', ISSUE, 'octo/repo', dispatch, async () => { throw accessError(code) }, noContext), 'octo/repo', `${code}: no list to check, it goes on as before`)
})

test('several matches return the candidates as one choice card and dispatch nothing', async () => {
  const dispatch = mock.fn(async () => ({ runId: 'run' }))
  const list = mock.fn<RepositoryLister>(async () => repos('alexj11324/Mikka_test', 'mikka-org/mikka-test'))
  assert.deepEqual(await withResolvedRepository('alex', ISSUE, 'mikka.test', dispatch, list, noContext), {
    error: 'repositoryAmbiguous', issueId: ISSUE,
    candidates: [{ fullName: 'alexj11324/Mikka_test', description: null, homepage: null, usedByThisWorkspace: false }, { fullName: 'mikka-org/mikka-test', description: null, homepage: null, usedByThisWorkspace: false }],
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
  assert.deepEqual(await findRepository('alex', undefined, lister()), { total: 3, repositories: [{ fullName: 'alexj11324/Mikka_test', description: null, homepage: null }, { fullName: 'alexj11324/Mikka', description: null, homepage: null }, { fullName: 'mikka-org/web', description: null, homepage: null }] })
  assert.deepEqual(await findRepository('alex', '  ', lister()), { total: 3, repositories: [{ fullName: 'alexj11324/Mikka_test', description: null, homepage: null }, { fullName: 'alexj11324/Mikka', description: null, homepage: null }, { fullName: 'mikka-org/web', description: null, homepage: null }] })
  const many = mock.fn<RepositoryLister>(async () => repos(...Array.from({ length: 70 }, (_, index) => `o/r${index}`)))
  const listed = await findRepository('alex', undefined, many) as { total: number; repositories: unknown[] }
  assert.deepEqual([listed.total, listed.repositories.length], [70, 50])
  assert.deepEqual(await findRepository('alex', 'mikka test', lister()), { match: 'one', repository: 'alexj11324/Mikka_test', description: null, homepage: null })
  assert.deepEqual(await findRepository('alex', 'ALEXJ11324/mikka_test', lister()), { match: 'one', repository: 'alexj11324/Mikka_test', description: null, homepage: null })
  assert.deepEqual(await findRepository('alex', 'https://github.com/mikka-org/web.git', lister()), { match: 'one', repository: 'mikka-org/web', description: null, homepage: null })
  const several = await findRepository('other', 'mikka.test', lister()) as { match: string; candidates: { fullName: string }[] }
  assert.deepEqual([several.match, several.candidates.map(item => item.fullName)], ['several', ['someone/Mikka_test', 'org2/mikka-test']])
})

// Production (Acme): find_repository {name:"mikka"} returned match "one" (alexj11324/Mikka, an exact hit) and hid
// mikka-web, whose homepage is the site the person meant (「the How it works section on the Mikka site」).
const acme = () => mock.fn<RepositoryLister>(async () => ({ repositories: [
  { fullName: 'alexj11324/Mikka', private: true, description: 'Mikka app: bots, threads and the Coordinator', homepage: 'https://app.mikka.example' },
  { fullName: 'alexj11324/mikka-web', private: true, description: 'The Mikka marketing site', homepage: 'https://mikka.example' },
  { fullName: 'acme/mikka-enterprise', private: true, description: null, homepage: null },
] }))

test('an exact name never hides the others: every candidate comes back with its description and homepage', async () => {
  const found = await findRepository('alex', 'mikka', acme())
  assert.equal((found as { match: string }).match, 'several')
  assert.deepEqual((found as { candidates: unknown[] }).candidates, [
    { fullName: 'alexj11324/Mikka', description: 'Mikka app: bots, threads and the Coordinator', homepage: 'https://app.mikka.example', usedByThisWorkspace: false },
    { fullName: 'alexj11324/mikka-web', description: 'The Mikka marketing site', homepage: 'https://mikka.example', usedByThisWorkspace: false },
    { fullName: 'acme/mikka-enterprise', description: null, homepage: null, usedByThisWorkspace: false },
  ])
  assert.equal((await findRepository('alex', 'Mikka site', acme()) as { match: string }).match, 'several', 'no synonym decides "site"')
  assert.deepEqual(await findRepository('alex', 'alexj11324/mikka-web', acme()), { match: 'one', repository: 'alexj11324/mikka-web', description: 'The Mikka marketing site', homepage: 'https://mikka.example' })
})

test('dispatch_run with a bare name that several fit dispatches nothing; this workspace\'s repositories only come first', async () => {
  const dispatch = mock.fn(async (repo: string) => ({ runId: 'run', repo }))
  const result = await withResolvedRepository('alex', ISSUE, 'Mikka', dispatch, acme(), async () => ({ used: ['alexj11324/mikka-web'] })) as { error: string; candidates: { fullName: string; usedByThisWorkspace: boolean }[]; card: { options: { value: string }[] } }
  assert.equal(result.error, 'repositoryAmbiguous')
  assert.deepEqual(result.candidates.map(item => [item.fullName, item.usedByThisWorkspace]), [['alexj11324/mikka-web', true], ['alexj11324/Mikka', false], ['acme/mikka-enterprise', false]])
  assert.deepEqual(result.card.options.map(option => option.value), ['alexj11324/mikka-web', 'alexj11324/Mikka', 'acme/mikka-enterprise'])
  assert.equal(dispatch.mock.callCount(), 0, 'the workspace\'s own use orders the candidates; it never chooses')
  // The Coordinator judged them and passes owner/repo: dispatched as named.
  assert.deepEqual(await withResolvedRepository('alex', ISSUE, 'alexj11324/mikka-web', dispatch, acme(), noContext), { runId: 'run', repo: 'alexj11324/mikka-web' })
  const unreadable = await withResolvedRepository('alex', ISSUE, 'Mikka', dispatch, acme(), async () => { throw new Error('context unavailable') })
  assert.equal((unreadable as { error?: string }).error, 'repositoryAmbiguous')
})

test('sameRepository tells a named repository from the thread\'s', async () => {
  const { sameRepository } = await import('./repository-resolution')
  assert.equal(await sameRepository('alex', 'mikka-web', 'https://github.com/alexj11324/Mikka.git', acme()), false)
  assert.equal(await sameRepository('alex', 'alexj11324/Mikka', 'https://github.com/alexj11324/Mikka.git', acme()), true)
  assert.equal(await sameRepository('alex', 'Mikka', 'https://github.com/alexj11324/Mikka.git', acme()), null, 'a name several fit is not one repository yet')
})
