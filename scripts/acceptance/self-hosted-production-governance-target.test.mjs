import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'
import { CORE_MODE, CORE_WORKFLOW, CORE_ISSUES } from './self-hosted-production-target.mjs'
import { GOVERNANCE_ISSUE, GOVERNANCE_PR, GOVERNANCE_BRANCH, GOVERNANCE_ORIGIN_PR, GOVERNANCE_ORIGIN_BRANCH,
  GOVERNANCE_ORIGIN_MERGE, GOVERNANCE_ORIGIN_HEAD, GovernanceSelectionError, governanceWindowProof,
  governanceSelectionFailure, selectGovernanceProduction } from './self-hosted-production-governance-target.mjs'

const SOURCE = 'a'.repeat(40), HEAD = 'b'.repeat(40), PREVIOUS = 'c'.repeat(40)
const API = 'https://api.github.com/repos/alexj11324/Mikka'
const NOW = Date.parse('2026-11-10T03:20:00Z')
const repository = { full_name: 'alexj11324/Mikka', owner: { login: 'alexj11324' } }
const stepNames = ['Verify the official runtime stays on the cloud edition', 'Build (runs migrations last, as the Vercel build did)',
  'Upload the prebuilt output to production', 'Verify the public production version before releasing the deployment queue']
const marker = (patch = {}) => '<!-- mikka-governance-followup-1856 ' + JSON.stringify({ schema: 1, state: 'active',
  issue: 1608, pr: 1856, branch: GOVERNANCE_BRANCH, headSha: HEAD, sourceSha: SOURCE,
  originPr: 1831, originMergeSha: GOVERNANCE_ORIGIN_MERGE, originHeadSha: GOVERNANCE_ORIGIN_HEAD,
  startsAt: '2026-11-10T03:19:00Z', expiresAt: '2026-11-10T04:19:00Z', phase: 'owner-audit', ...patch }) + ' -->'
const reference = (patch = {}) => ({ schema: 1, purpose: 'mikka1856-governance-journal-recovery',
  runId: 17, attempt: 1, jobId: 91, journalSha256: 'd'.repeat(64), ...patch })

function metadata(options = {}) {
  const calls = [], env = { MIKKA_ACCEPTANCE_TARGET_MODE: CORE_MODE, GITHUB_REPOSITORY: repository.full_name,
    GITHUB_REPOSITORY_OWNER: 'alexj11324', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_run',
    GITHUB_SHA: SOURCE, GITHUB_RUN_ID: '17', GITHUB_RUN_ATTEMPT: String(options.attempt ?? 1), GH_TOKEN: 'synthetic-metadata-token',
    GITHUB_WORKFLOW_REF: repository.full_name + '/' + CORE_WORKFLOW + '@refs/heads/main' }
  for (const key of ['SMOKE_OWNER_EMAIL', 'SMOKE_OWNER_PASSWORD', 'INFISICAL_CLIENT_SECRET'])
    Object.defineProperty(env, key, { get() { return assert.fail('selector must not read ' + key) } })
  const release = { id: 51, run_attempt: 1, repository, head_repository: repository, url: API + '/actions/runs/51',
    name: 'Web deploy', path: '.github/workflows/web-deploy.yml', event: 'push', head_branch: 'main', head_sha: SOURCE,
    status: 'completed', conclusion: 'success' }
  const event = { action: 'completed', repository, workflow_run: structuredClone(release) }
  const comment = { id: 1608001, user: { login: 'alexj11324' }, body: marker(options.marker) }
  const pr = { number: GOVERNANCE_PR, user: { login: 'alexj11324' }, merged: true, merge_commit_sha: SOURCE,
    base: { ref: 'main', sha: GOVERNANCE_ORIGIN_MERGE, repo: repository },
    head: { ref: GOVERNANCE_BRANCH, sha: HEAD, repo: repository } }
  const original = { number: GOVERNANCE_ORIGIN_PR, merged: true, merge_commit_sha: GOVERNANCE_ORIGIN_MERGE,
    base: { ref: 'main', repo: repository }, head: { ref: GOVERNANCE_ORIGIN_BRANCH, sha: GOVERNANCE_ORIGIN_HEAD, repo: repository } }
  const job = { id: 61, name: 'deploy', run_id: 51, run_attempt: 1, run_url: API + '/actions/runs/51', head_sha: SOURCE,
    head_branch: 'main', status: 'completed', conclusion: 'success', steps: stepNames.map(name => ({ name, status: 'completed', conclusion: 'success' })) }
  const state = { main: SOURCE, version: SOURCE, clock: NOW, pr, original, release, job,
    driver: { id: 17, run_attempt: options.attempt ?? 1, repository, head_repository: repository, url: API + '/actions/runs/17',
      path: CORE_WORKFLOW, event: 'workflow_run', head_branch: 'main', head_sha: SOURCE, status: 'in_progress', conclusion: null },
    issue: { number: 1608, url: API + '/issues/1608', repository_url: API, state: 'open' }, comment, comments: [comment],
    commits: new Map([[SOURCE, { sha: SOURCE, parents: [{ sha: PREVIOUS }, { sha: HEAD }] }],
      [PREVIOUS, { sha: PREVIOUS, parents: [{ sha: GOVERNANCE_ORIGIN_MERGE }] }],
      [GOVERNANCE_ORIGIN_MERGE, { sha: GOVERNANCE_ORIGIN_MERGE, parents: [{ sha: 'e'.repeat(40) }, { sha: GOVERNANCE_ORIGIN_HEAD }] }]]) }
  const fetchImpl = async (input, init) => {
    const url = new URL(input), headers = new Headers(init.headers)
    const path = url.origin === 'https://api.github.com' ? url.href.slice(API.length) : url.pathname
    calls.push(url.href); assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error')
    assert.equal(init.cache, 'no-store'); assert.equal(headers.get('cache-control'), 'no-store'); assert.equal(headers.has('cookie'), false)
    options.onRead?.(path, state)
    if (url.origin === 'https://app.aspectlylabs.com') {
      assert.equal(url.pathname, '/mikka/api/version'); assert.equal(headers.has('authorization'), false)
      return Response.json({ build: state.version })
    }
    assert.equal(url.origin, 'https://api.github.com'); assert.equal(headers.get('authorization'), 'Bearer synthetic-metadata-token')
    if (options.respond) {
      const response = await options.respond(path, state)
      if (response) return response
    }
    if (path === '/pulls/1856') return Response.json(pr)
    if (path === '/pulls/1831') return Response.json(original)
    if (path.startsWith('/git/commits/')) {
      const value = state.commits.get(path.slice('/git/commits/'.length)); assert.ok(value, 'unexpected commit read')
      return Response.json(value)
    }
    if (path === '/issues/1608') return Response.json(state.issue)
    if (path === '/issues/1752') return Response.json({ number: 1752, url: API + path, repository_url: API,
      pull_request: { url: API + '/pulls/1752' }, comments: state.comments.length })
    if (path.startsWith('/issues/1752/comments?')) {
      const page = Number(url.searchParams.get('page'))
      return Response.json(state.comments.slice((page - 1) * 100, page * 100))
    }
    if (path.startsWith('/issues/comments/')) {
      const value = state.comments.find(row => row.id === Number(path.slice('/issues/comments/'.length)))
      assert.ok(value); return Response.json(value)
    }
    if (path === '/actions/runs/17') return Response.json(state.driver)
    if (path === '/git/ref/heads/main') return Response.json({ ref: 'refs/heads/main', object: { type: 'commit', sha: state.main } })
    if (path === '/actions/runs/51') return Response.json(release)
    if (path === `/actions/runs/51/attempts/${release.run_attempt}/jobs?per_page=100`)
      return Response.json(state.listing ?? { total_count: 1, jobs: [job] })
    return assert.fail('unexpected metadata request ' + path)
  }
  const args = { env, event, fetchImpl, now: () => state.clock }
  return { args, state, calls, options, select: expectedSelection => selectGovernanceProduction({ ...args, expectedSelection }) }
}

test('only registered ordinary 1856, real Team first-parent history and its current successful Web select before credentials', async () => {
  for (const direct of [false, true]) {
    const f = metadata()
    if (direct) f.state.commits.get(SOURCE).parents[0].sha = GOVERNANCE_ORIGIN_MERGE
    const proof = await f.select()
    assert.equal(proof.purpose, 'governance-1608-followup-selection'); assert.equal(proof.selected, true)
    assert.equal(proof.issue, GOVERNANCE_ISSUE); assert.equal(proof.pr, 1856); assert.equal(proof.branch, GOVERNANCE_BRANCH)
    assert.equal(proof.applicationSha, SOURCE); assert.equal(proof.headSha, HEAD); assert.equal(proof.driverRevision, SOURCE)
    assert.equal(proof.driverRunId, 17); assert.equal(proof.driverRunAttempt, 1)
    assert.equal(proof.originPr, 1831); assert.equal(proof.originMergeSha, GOVERNANCE_ORIGIN_MERGE)
    assert.equal(proof.originHeadSha, GOVERNANCE_ORIGIN_HEAD); assert.equal(proof.firstParentDepth, direct ? 0 : 1)
    assert.equal(proof.webDeployRunId, 51); assert.equal(proof.webAttempt, 1); assert.equal(proof.webDeployJobId, 61)
    assert.equal(proof.window.phase, 'owner-audit'); assert.equal(proof.window.recovery, null)
    assert.equal(proof.window.commentId, f.state.comment.id); assert.match(proof.window.markerSha256, /^[a-f0-9]{64}$/)
    assert.equal(proof.attestation, undefined); assert.equal(proof.openIssues, undefined)
    assert.equal(f.calls.filter(url => url.endsWith('/mikka/api/version')).length, 2)
    assert.ok(f.calls.includes(API + '/git/commits/' + GOVERNANCE_ORIGIN_MERGE))
    assert.ok(f.calls.every(url => !url.includes('/api/auth/') && !url.includes('/api/organizations')))
  }
})

test('selection is independent of closed Core/Inbox/1642 issues and never reads them or smoke credentials', async () => {
  const f = metadata(), proof = await selectGovernanceProduction({ ...f.args,
    attestation: { status: 'skipped', readable: false, code: 'core_issues_closed', openIssues: [] } })
  assert.equal(proof.selected, true)
  assert.deepEqual([...new Set(f.calls.filter(url => /^.*\/issues\/\d+$/.test(url)))], [API + '/issues/1608', API + '/issues/1752'])
  for (const number of [1608, 1642, 1856]) assert.equal(CORE_ISSUES.includes(number), false)
})

test('unrelated main, unmerged or wrong author/branch/fork PR and nonordinary merge decline without owner traffic', async () => {
  const mutations = [f => { f.state.pr.merged = false }, f => { f.state.pr.number = 1857 },
    f => { f.state.pr.merge_commit_sha = PREVIOUS }, f => { f.state.pr.user.login = 'other-owner' },
    f => { f.state.pr.head.ref = 'another-branch' }, f => { f.state.pr.base.ref = 'release' },
    f => { f.state.pr.head.repo = { full_name: 'someone/fork' } }, f => { f.state.pr.base.repo = { full_name: 'someone/fork' } },
    f => { f.state.commits.get(SOURCE).parents = [{ sha: HEAD }] },
    f => { f.state.commits.get(SOURCE).parents[1].sha = PREVIOUS },
    f => { f.state.commits.get(SOURCE).parents = [{ sha: HEAD }, { sha: HEAD }] }]
  for (const mutate of mutations) {
    const f = metadata(); mutate(f)
    assert.equal((await f.select()).selected, false)
    assert.equal(f.calls.some(url => url.startsWith('https://app.aspectlylabs.com')), false)
  }
})

test('original 1831 metadata and raw ordinary 083 merge are exact', async () => {
  for (const mutate of [f => { f.state.original.merged = false }, f => { f.state.original.number = 1830 },
    f => { f.state.original.merge_commit_sha = PREVIOUS }, f => { f.state.original.head.sha = HEAD },
    f => { f.state.original.head.ref = 'almost-the-same-branch' }, f => { f.state.original.head.repo = { full_name: 'someone/fork' } },
    f => { f.state.commits.get(GOVERNANCE_ORIGIN_MERGE).parents = [{ sha: GOVERNANCE_ORIGIN_HEAD }] },
    f => { f.state.commits.get(GOVERNANCE_ORIGIN_MERGE).parents[1].sha = HEAD }]) {
    const f = metadata(); mutate(f); assert.equal((await f.select()).selected, false)
    assert.equal(f.calls.some(url => url.includes('/mikka/')), false)
  }
})

test('only the real first-parent chain counts; second-parent-only, cyclic and malformed ancestry decline', async () => {
  for (const kind of ['second-parent', 'cycle', 'missing-sha', 'octopus']) {
    const f = metadata(), previous = f.state.commits.get(PREVIOUS), foreign = 'f'.repeat(40)
    if (kind === 'second-parent') { previous.parents = [{ sha: foreign }, { sha: GOVERNANCE_ORIGIN_MERGE }]; f.state.commits.set(foreign, { sha: foreign, parents: [] }) }
    if (kind === 'cycle') previous.parents = [{ sha: PREVIOUS }]
    if (kind === 'missing-sha') previous.sha = foreign
    if (kind === 'octopus') previous.parents = [{ sha: GOVERNANCE_ORIGIN_MERGE }, { sha: HEAD }, { sha: foreign }]
    assert.equal((await f.select()).reason, 'original_not_on_first_parent_chain')
  }
})

test('first-parent walk accepts the 64-link bound and refuses a 65th link', async () => {
  for (const length of [64, 65]) {
    const f = metadata(), id = index => index.toString(16).padStart(40, '0')
    f.state.commits.get(SOURCE).parents[0].sha = id(1)
    for (let index = 1; index <= length; index++) f.state.commits.set(id(index), { sha: id(index),
      parents: [{ sha: index === length ? GOVERNANCE_ORIGIN_MERGE : id(index + 1) }] })
    const proof = await f.select(); assert.equal(proof.selected, length === 64)
    if (proof.selected) assert.equal(proof.firstParentDepth, 64)
    assert.equal(f.calls.includes(API + '/git/commits/' + id(65)), false)
  }
})

test('only open issue1608 grants governance scope; a PR or wrong-repository issue cannot grant it', async () => {
  const f = metadata(), proof = await f.select(); f.state.issue.state = 'closed'
  assert.equal((await f.select()).reason, 'governance_issue_closed')
  await assert.rejects(f.select(proof), /governance_selection_changed/)
  for (const patch of [{ pull_request: {} }, { number: 1642 }, { repository_url: API + '-fork' }, { url: API + '/issues/1642' }]) {
    const f = metadata(); Object.assign(f.state.issue, patch)
    await assert.rejects(f.select(), error => error.detail === 'issue')
  }
})

test('wrong workflow, dispatch, repository or event is refused before metadata', async () => {
  for (const patch of [{ GITHUB_EVENT_NAME: 'workflow_dispatch' }, { GITHUB_REF: 'refs/heads/feature' },
    { GITHUB_WORKFLOW_REF: repository.full_name + '/.github/workflows/other.yml@refs/heads/main' },
    { GITHUB_REPOSITORY_OWNER: 'other-owner' }, { GITHUB_RUN_ATTEMPT: '0' }]) {
    const f = metadata(); Object.assign(f.args.env, patch)
    await assert.rejects(f.select(), /governance_configuration/); assert.equal(f.calls.length, 0)
  }
  for (const patch of [{ event: 'workflow_dispatch' }, { conclusion: 'failure' }, { head_sha: PREVIOUS },
    { head_repository: { full_name: 'someone/fork' } }]) {
    const f = metadata(); Object.assign(f.args.event.workflow_run, patch)
    await assert.rejects(f.select(), /governance_configuration/); assert.equal(f.calls.length, 0)
  }
})

test('the actual driver run, attempt, repository, source and workflow are independently checked', async () => {
  for (const patch of [{ id: 18 }, { run_attempt: 2 }, { event: 'push' }, { head_branch: 'feature' },
    { head_sha: PREVIOUS }, { path: '.github/workflows/other.yml' }, { status: 'completed', conclusion: 'failure' },
    { url: API + '/actions/runs/18' }, { repository: { full_name: 'someone/fork' } }]) {
    const f = metadata(); Object.assign(f.state.driver, patch)
    await assert.rejects(f.select(), error => error.code === 'governance_selection_invalid' && error.detail === 'driver')
  }
})

test('actual Web must be the successful push publication for this source and exact deployment job attempt', async () => {
  for (const patch of [{ event: 'workflow_dispatch' }, { head_sha: PREVIOUS }, { conclusion: 'failure' },
    { path: '.github/workflows/e2b-official-runtime.yml' }, { name: 'Some other workflow' },
    { head_repository: { full_name: 'someone/fork' } }, { run_attempt: 0 }]) {
    const f = metadata(); Object.assign(f.state.release, patch)
    await assert.rejects(f.select(), error => error.detail === 'web')
  }
  for (const patch of [{ run_id: 52 }, { run_attempt: 2 }, { run_url: API + '/actions/runs/52' }, { head_branch: 'feature' },
    { head_sha: PREVIOUS }, { status: 'in_progress' }, { conclusion: 'failure' }]) {
    const f = metadata(); Object.assign(f.state.job, patch)
    await assert.rejects(f.select(), error => error.detail === 'jobs')
  }
})

test('truncated or duplicate Web jobs and missing, failed or duplicate publication steps cannot prove deployment', async () => {
  for (const kind of ['truncated', 'duplicate', 'empty', 'wrong-step', 'failed-step', 'duplicate-step', 'non-array-steps']) {
    const f = metadata()
    if (kind === 'truncated') f.state.listing = { total_count: 2, jobs: [f.state.job] }
    if (kind === 'duplicate') f.state.listing = { total_count: 2, jobs: [f.state.job, { ...f.state.job, id: 62 }] }
    if (kind === 'empty') f.state.listing = { total_count: 0, jobs: [] }
    if (kind === 'wrong-step') f.state.job.steps[2].name = 'Upload staging'
    if (kind === 'failed-step') f.state.job.steps[2].conclusion = 'failure'
    if (kind === 'duplicate-step') f.state.job.steps.push({ ...f.state.job.steps[2], conclusion: 'failure' })
    if (kind === 'non-array-steps') f.state.job.steps = {}
    await assert.rejects(f.select(), error => ['jobs', 'steps'].includes(error.detail))
  }
})

test('current main and public version are pinned before and after Web plus window reads', async () => {
  for (const kind of ['main', 'version']) {
    const f = metadata(); f.state[kind] = PREVIOUS
    assert.equal((await f.select()).reason, kind === 'main' ? 'main_moved' : 'deployment_changed')
    const late = metadata({ onRead(path, state) { if (path.startsWith('/issues/comments/')) state[kind] = PREVIOUS } })
    assert.equal((await late.select()).selected, false)
  }
})

test('in-flight source, PR, issue, Web attempt and deployment job changes throw instead of silently deselecting', async () => {
  for (const mutate of [f => { f.state.main = PREVIOUS }, f => { f.state.version = PREVIOUS },
    f => { f.state.pr.merged = false }, f => { f.state.pr.head.sha = PREVIOUS }, f => { f.state.issue.state = 'closed' },
    f => { f.state.release.run_attempt = 2; f.state.job.run_attempt = 2 }, f => { f.state.job.id = 62 }]) {
    const f = metadata(), proof = await f.select(); mutate(f)
    await assert.rejects(f.select(proof), /governance_selection_changed|governance_target_changed/)
  }
})

test('expected proof cannot be imported from Inbox, another source/run/attempt or another original merge', async () => {
  const f = metadata(), proof = await f.select()
  for (const patch of [{ purpose: 'inbox-1820-followup-selection' }, { selected: false }, { pr: 1822 },
    { issue: 1642 }, { branch: 'arbitrary-branch' }, { applicationSha: PREVIOUS }, { driverRunId: 18 },
    { driverRunAttempt: 2 }, { originMergeSha: PREVIOUS }, { originHeadSha: HEAD },
    { window: { ...proof.window, markerSha256: 'invalid' } }, { checkedAt: '2026-11-10T03:21:00Z' }])
    await assert.rejects(f.select({ ...proof, ...patch }), /governance_selection_changed/)
  await assert.rejects(f.select(null), /governance_selection_changed/)
})

test('no opt-in, wrong marker scope, unknown fields or overlong/future/expired windows never select', async () => {
  for (const patch of [{ state: 'released' }, { schema: 2 }, { issue: 1820 }, { pr: 1831 },
    { branch: 'other' }, { headSha: PREVIOUS }, { sourceSha: PREVIOUS }, { originPr: 1822 },
    { originMergeSha: PREVIOUS }, { originHeadSha: HEAD }, { phase: undefined }, { phase: 'inventory' },
    { fixture: {} }, { secret: 'private-marker-canary' }, { startsAt: '2026-11-10T03:21:00Z' },
    { expiresAt: '2026-11-10T03:20:00Z' }, { expiresAt: '2026-11-10T05:19:00.001Z' },
    { startsAt: 1 }, { expiresAt: 'not-a-time' }]) {
    const f = metadata({ marker: patch }), proof = await f.select()
    assert.equal(proof.selected, false); assert.equal(proof.reason, 'window_not_active')
    assert.equal(JSON.stringify(proof).includes('private-marker-canary'), false)
  }
  for (const kind of ['none', 'foreign', 'duplicate', 'malformed-duplicate']) {
    const f = metadata()
    if (kind === 'none') f.state.comments.length = 0
    if (kind === 'foreign') f.state.comment.user = { login: 'other-owner' }
    if (kind === 'duplicate') f.state.comment.body += '\n' + marker()
    if (kind === 'malformed-duplicate') f.state.comment.body += '\n<!-- mikka-governance-followup-1856 broken -->'
    assert.equal((await f.select()).selected, false)
  }
  assert.equal((await metadata({ marker: { expiresAt: '2026-11-10T05:19:00Z' } }).select()).selected, true)
})

test('ordinary discussion cannot extend a lease; latest own release/edited/replacement marker refuses the next write', async () => {
  for (const kind of ['release', 'expiry-edit', 'new-marker', 'new-invalid-marker', 'new-phase']) {
    const f = metadata(), proof = await f.select()
    f.state.comments.push({ id: f.state.comment.id + 1, user: { login: 'alexj11324' }, body: 'Offline progress only.' },
      { id: f.state.comment.id + 2, user: { login: 'other-owner' }, body: marker() })
    assert.equal((await f.select(proof)).selected, true)
    if (kind === 'release') f.state.comment.body = marker({ state: 'released' })
    if (kind === 'expiry-edit') f.state.comment.body = marker({ expiresAt: '2026-11-10T04:20:00Z' })
    if (kind === 'new-marker') f.state.comments.push({ ...f.state.comment, id: f.state.comment.id + 3 })
    if (kind === 'new-invalid-marker') f.state.comments.push({ ...f.state.comment, id: f.state.comment.id + 3, body: '<!-- mikka-governance-followup-1856 broken -->' })
    if (kind === 'new-phase') f.state.comment.body = marker({ phase: 'cleanup', recovery: reference() })
    await assert.rejects(f.select(proof), /governance_window_invalid/)
  }
})

test('window listing uses both final pages and independently reads the exact latest comment', async () => {
  const f = metadata()
  f.state.comments = Array.from({ length: 100 }, (_, index) => ({ id: 1607000 + index,
    user: { login: 'alexj11324' }, body: 'Ordinary discussion.' }))
  f.state.comments.push(f.state.comment)
  assert.equal((await f.select()).window.commentId, f.state.comment.id)
  for (const page of [1, 2]) assert.ok(f.calls.includes(API + `/issues/1752/comments?per_page=100&page=${page}`))
  assert.ok(f.calls.includes(API + '/issues/comments/' + f.state.comment.id))
})

test('the actual PR1752 issue endpoint remains the fixed release registry, including its pull_request pointer', async () => {
  const f = metadata({ respond(path, state) {
    if (path === '/issues/1752') return Response.json({ number: 1752, url: API + '/issues/1752',
      repository_url: API, pull_request: { url: API + '/pulls/1752' }, comments: state.comments.length })
  } })
  const proof = await f.select()
  assert.equal(proof.selected, true)
  assert.equal(proof.window.commentId, f.state.comment.id)
  assert.equal((await f.select(proof)).selected, true)
})

test('the fixed PR registry does not accept another issue, repository or pull-request pointer', async () => {
  for (const patch of [{ number: 1753 }, { url: API + '/issues/1753' }, { repository_url: API + '-fork' },
    { pull_request: undefined }, { pull_request: { url: API + '/pulls/1753' } },
    { pull_request: { url: 'https://api.github.com/repos/someone/fork/pulls/1752' } }]) {
    const f = metadata({ respond(path, state) {
      if (path === '/issues/1752') return Response.json({ number: 1752, url: API + '/issues/1752',
        repository_url: API, pull_request: { url: API + '/pulls/1752' }, comments: state.comments.length, ...patch })
    } })
    assert.equal((await f.select()).selected, false)
  }
})

test('a fresh expired clock after slow network cannot authorize the next write', async () => {
  const f = metadata(), proof = await f.select()
  f.options.onRead = (path, state) => { if (path.startsWith('/issues/comments/')) state.clock = Date.parse('2026-11-10T04:19:00Z') }
  await assert.rejects(f.select(proof), /governance_window_invalid/)
  assert.throws(() => governanceWindowProof(f.state.comment, { headSha: HEAD, sourceSha: SOURCE,
    expected: proof.window, now: f.state.clock }), /governance_window_invalid/)
  const closing = metadata(), selected = await closing.select()
  let versions = 0
  closing.options.onRead = (path, state) => {
    if (path === '/mikka/api/version' && ++versions === 2) state.clock = Date.parse('2026-11-10T04:19:00Z')
  }
  await assert.rejects(closing.select(selected), /governance_window_invalid/)
})

test('cleanup has only an exact earlier attempt of the same run and a closed governance journal reference', async () => {
  const f = metadata({ attempt: 2, marker: { phase: 'cleanup', recovery: reference() } }), proof = await f.select()
  assert.equal(proof.selected, true); assert.equal(proof.window.phase, 'cleanup'); assert.deepEqual(proof.window.recovery, reference())
  for (const patch of [{}, { recovery: reference({ runId: 18 }) }, { recovery: reference({ attempt: 2 }) },
    { recovery: reference({ attempt: 3 }) }, { recovery: reference({ purpose: 'mikka1820-journal-recovery' }) },
    { recovery: reference({ sourceSha: PREVIOUS }) }, { recovery: reference({ token: 'private-recovery-canary' }) }]) {
    const f = metadata({ attempt: 2, marker: { phase: 'cleanup', ...patch } }), result = await f.select()
    assert.equal(result.selected, false); assert.equal(JSON.stringify(result).includes('private-recovery-canary'), false)
  }
  assert.equal((await metadata({ marker: { recovery: reference() } }).select()).selected, false)
})

test('transport, HTTP and JSON failure projections never expose arbitrary response, cause or credential text', async () => {
  const canary = 'private-diagnostic-canary'
  for (const respond of [() => { throw new Error(canary) }, () => new Response(canary, { status: 503 }),
    () => new Response(canary, { status: 200, headers: { 'content-type': 'application/json' } })]) {
    const f = metadata({ respond })
    await assert.rejects(f.select(), error => {
      const failure = governanceSelectionFailure(error)
      assert.equal(failure.code, 'governance_read_failed'); assert.equal(JSON.stringify(failure).includes(canary), false)
      assert.equal(failure.message, undefined); assert.equal(failure.cause, undefined); assert.equal(failure.body, undefined)
      return true
    })
  }
  assert.deepEqual(governanceSelectionFailure(new Error(canary)), { code: 'governance_selection_invalid', detail: 'response' })
  const spoof = new GovernanceSelectionError('governance_read_failed', 'response')
  spoof.code = canary; spoof.detail = canary; spoof.httpStatus = canary
  assert.equal(JSON.stringify(governanceSelectionFailure(spoof)).includes(canary), false)
})

test('redirects or a mismatched response origin are refused without forwarding credentials', async () => {
  for (const field of ['redirected', 'url']) {
    const f = metadata({ respond() {
      const response = Response.json({})
      Object.defineProperty(response, field, { value: field === 'redirected' ? true : 'https://elsewhere.invalid/' })
      return response
    } })
    await assert.rejects(f.select(), error => error.code === 'governance_read_failed')
    assert.equal(f.calls.length, 1)
  }
})

test('workflow selects governance before the same two narrow secrets without enrolling Core business or changing Inbox recovery steps', async () => {
  const require = createRequire(import.meta.url), { load } = require('js-yaml')
  const text = await readFile(new URL('../../.github/workflows/self-hosted-production.yml', import.meta.url), 'utf8'), workflow = load(text)
  assert.equal(workflow.on.workflow_dispatch, undefined)
  assert.deepEqual(workflow.on.workflow_run, { workflows: ['Web deploy'], types: ['completed'], branches: ['main'] })
  assert.ok(workflow.on.pull_request.paths.includes('scripts/acceptance/self-hosted-production*.mjs'))
  assert.ok(workflow.concurrency.group.includes('production-smoke-owner-acceptance'))
  assert.equal(workflow.concurrency['cancel-in-progress'], false); assert.equal(workflow.concurrency.queue, 'max')
  const acceptance = workflow.jobs.acceptance, steps = acceptance.steps
  assert.equal(acceptance.name, 'Core production API and gateway acceptance')
  assert.deepEqual(acceptance.permissions, { contents: 'read', actions: 'read', issues: 'read', 'pull-requests': 'read', 'id-token': 'write' })
  const selection = steps.findIndex(step => step.id === 'governance_selection')
  assert.ok(selection > 0); assert.equal(steps[selection].run, 'node --import tsx scripts/acceptance/self-hosted-production-governance.mjs --select')
  const secrets = steps.filter(step => step.uses?.startsWith('Infisical/secrets-action@'))
  assert.equal(secrets.length, 2)
  assert.deepEqual(secrets.map(step => step.with['secret-name']), ['SMOKE_OWNER_EMAIL', 'SMOKE_OWNER_PASSWORD'])
  for (const step of secrets) {
    assert.ok(steps.indexOf(step) > selection)
    assert.equal(step.if, "(steps.attest.outputs.readable == 'true' && (steps.inbox_selection.outputs.core_required == 'true' || steps.inbox_selection.outputs.selected == 'true')) || steps.governance_selection.outputs.selected == 'true'")
    assert.equal(step.uses, 'Infisical/secrets-action@d2e351f16c6ca20d17c85e6c992e04bdeb64e87d')
    assert.deepEqual(step.with, { method: 'oidc', 'identity-id': '2cf9fa19-b9db-4c08-8ca0-b31859f2cbac', 'oidc-audience': 'mikka-infisical',
      'project-id': '89850d6a-f020-4936-863e-df77380dfe40', 'env-slug': 'prod', 'secret-path': '/',
      'secret-name': step.with['secret-name'], recursive: false, 'include-imports': false })
  }
  const core = steps.find(step => step.run === 'node --import tsx scripts/acceptance/self-hosted-production.mjs')
  assert.equal(core.if, "steps.attest.outputs.readable == 'true' && steps.inbox_selection.outputs.core_required == 'true'")
  const governance = steps.find(step => step.run === 'node --import tsx scripts/acceptance/self-hosted-production-governance.mjs')
  assert.equal(governance.name, 'Verify the registered Team Organization owner and audit APIs with exact cleanup')
  assert.equal(governance.if, "steps.governance_selection.outputs.selected == 'true'"); assert.equal(governance['continue-on-error'], undefined)
  const inbox = steps.find(step => step.run === 'node --import tsx scripts/acceptance/inbox-production.mjs')
  assert.equal(inbox.name, 'Verify the exact Inbox fixture or inventory under its current release window')
  assert.equal(inbox.if, "steps.inbox_selection.outputs.selected == 'true'")
  assert.ok(steps.indexOf(core) < steps.indexOf(governance) && steps.indexOf(governance) < steps.indexOf(inbox))
  assert.ok(acceptance['timeout-minutes'] >= core['timeout-minutes'] + governance['timeout-minutes'] + inbox['timeout-minutes'] + 3)
  const guards = workflow.jobs.guards.steps.find(step => step.run?.includes('--test'))
  assert.deepEqual(guards.run.split(' '), ['node', '--import', 'tsx', '--test',
    'scripts/acceptance/self-hosted-production.test.mjs', 'scripts/ops/production-mobile-daemon.test.mjs',
    'scripts/acceptance/inbox-production.test.mjs', 'scripts/acceptance/inbox-production-target.test.mjs',
    'scripts/acceptance/inbox-production-recovery.test.mjs', 'scripts/acceptance/self-hosted-production-governance.test.mjs',
    'scripts/acceptance/self-hosted-production-governance-target.test.mjs', 'scripts/acceptance/self-hosted-production-governance-recovery.test.mjs'])
})
