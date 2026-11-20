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
