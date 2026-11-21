import '../../tests/support/server-only.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { githubMergeApi } from '../factory/merge'
import { mergePullRequest } from './pull-merge'
import type { PullDetail } from '../pull-directory'
import { githubFixture } from '../../tests/fakes/github-fixture.mjs'

const repo = 'mikka-e2e/core-loop', number = 41, token = 'mikka-local-synthetic-user-token'
const detail = (headSha: string): PullDetail => ({ url: `https://github.com/${repo}/pull/${number}`, title: 'HTTP fixture', state: 'open',
  repo, number, author: 'fixture', authorAvatar: null, updatedAt: '2026-11-20T00:00:00Z', createdAt: '2026-11-20T00:00:00Z', body: '',
  head: 'mikka/http-1', base: 'trunk', headSha, checks: 'SUCCESS', mergeState: 'CLEAN', reviewDecision: null, labels: [], changedFiles: 1,
  mergeable: 'MERGEABLE', checkRuns: [], moreChecks: false, reviews: [],
})

test('the GitHub directory/detail HTTP contracts expose the current Git head and review policy', async t => {
  const fixture = await githubFixture()
  t.after(() => fixture.close())
  const request = async (operation: string, variables: object) => {
    const response = await fixture.fetch('https://api.github.com/graphql', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: `query ${operation} { repository { nameWithOwner } }`, variables: { owner: 'mikka-e2e', name: 'core-loop', ...variables } }) })
    assert.equal(response.status, 200)
    return (await response.json()).data.repository
  }
  const list = (await request('PullDirectory', { states: ['OPEN'] })).pullRequests
  assert.equal(list.totalCount, 1)
  assert.equal(list.nodes[0].headRefOid, fixture.head)
  assert.equal(list.nodes[0].title, 'HTTP fake acceptance')
  assert.deepEqual(list.pageInfo, { hasNextPage: false, endCursor: null })
  fixture.github.rules.set(number, { requiredReview: true })
  const pending = (await request('PullDetail', { number })).pullRequest
  assert.equal(pending.reviewDecision, 'REVIEW_REQUIRED')
  assert.equal(pending.mergeStateStatus, 'BLOCKED')
  fixture.github.rules.set(number, { requiredReview: true, approved: true })
  const approved = (await request('PullDetail', { number })).pullRequest
  assert.equal(approved.reviews.nodes[0].state, 'APPROVED')
  assert.equal(approved.mergeStateStatus, 'CLEAN')
})

test('S3 merge reaches the real GitHub HTTP client and creates a two-parent Git commit', async t => {
  const fixture = await githubFixture()
  t.after(() => fixture.close())
  const originalBase = await fixture.currentBase()
  const result = await mergePullRequest('person', { repo, number, expectedHeadSha: fixture.head }, {
    detail: async () => detail(fixture.head), userToken: async () => token, github: githubMergeApi(fixture.fetch),
  })
  assert.equal(result.kind, 'merged')
  if (result.kind !== 'merged') return
  assert.equal(await fixture.currentBase(), result.mergeCommitSha)
  assert.equal(await fixture.parents(result.mergeCommitSha!), `${originalBase} ${fixture.head}`)
  const sent = fixture.github.requests.find((request: { method: string; path: string }) => request.method === 'PUT' && request.path.endsWith('/merge'))
  assert.deepEqual(sent.body, { sha: fixture.head, merge_method: 'merge' })
  assert.equal(sent.headers['x-github-api-version'], '2022-11-28')
})

test('GitHub review and protected-branch refusals keep S3 open without changing the base', async t => {
  const fixture = await githubFixture()
  t.after(() => fixture.close())
  const originalBase = await fixture.currentBase()
  for (const rule of [{ requiredReview: true }, { protected: true }]) {
    fixture.github.rules.set(number, rule)
    const result = await mergePullRequest('person', { repo, number, expectedHeadSha: fixture.head }, {
      detail: async () => detail(fixture.head), userToken: async () => token, github: githubMergeApi(fixture.fetch),
    })
    assert.deepEqual(result, { kind: 'refused', code: 'githubMergeBlocked' })
    assert.equal(await fixture.currentBase(), originalBase)
    assert.equal(fixture.pulls[0].state, 'open')
  }
})

test('a real Git merge conflict is refused and a wrong authorization never merges', async t => {
  const fixture = await githubFixture({ conflict: true })
  t.after(() => fixture.close())
  const originalBase = await fixture.currentBase(), github = githubMergeApi(fixture.fetch)
  const result = await mergePullRequest('person', { repo, number, expectedHeadSha: fixture.head }, {
    detail: async () => detail(fixture.head), userToken: async () => token, github,
  })
  assert.deepEqual(result, { kind: 'refused', code: 'githubMergeConflict' })
  assert.equal(await fixture.currentBase(), originalBase)
  assert.deepEqual(await github.merge('mvp-synthetic-installation-write', repo, number, { sha: fixture.head, method: 'merge' }), { merged: false, status: 403 })
})
