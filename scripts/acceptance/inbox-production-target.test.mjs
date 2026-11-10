import assert from 'node:assert/strict'
import test from 'node:test'
import { INBOX_BRANCH, inboxWindowProof, selectInboxProduction } from './inbox-production-target.mjs'
import { CORE_MODE, CORE_WORKFLOW, CORE_ISSUES, coreProductionGuard } from './self-hosted-production-target.mjs'
import { runInboxProduction } from './inbox-production.mjs'
import { INBOX_FOLLOWUP_PR, INBOX_FOLLOWUP_BRANCH, INBOX_ORIGINAL_MERGE, INBOX_ORIGINAL_HEAD,
  inboxFollowupWindowProof, selectInboxFollowup, selectInboxAcceptance } from './self-hosted-production-followup-target.mjs'

const SOURCE = 'a'.repeat(40), HEAD = 'b'.repeat(40), PREVIOUS = 'c'.repeat(40)
const API = 'https://api.github.com/repos/alexj11324/Mikka'
const NOW = Date.parse('2026-11-09T22:00:00Z')
const repository = { full_name: 'alexj11324/Mikka', owner: { login: 'alexj11324' } }
const marker = (patch = {}) => '<!-- mikka-inbox-1820 ' + JSON.stringify({ state: 'active', issue: 1820, pr: 1822,
  branch: INBOX_BRANCH, headSha: HEAD, sourceSha: SOURCE, startsAt: '2026-11-09T21:59:00Z',
  expiresAt: '2026-11-09T22:30:00Z', ...patch }) + ' -->'

function metadata(options = {}) {
  const calls = [], env = { MIKKA_ACCEPTANCE_TARGET_MODE: CORE_MODE, GITHUB_REPOSITORY: repository.full_name,
    GITHUB_REPOSITORY_OWNER: 'alexj11324', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_run',
    GITHUB_SHA: SOURCE, GITHUB_RUN_ID: '17', GITHUB_RUN_ATTEMPT: String(options.attempt ?? 1), GH_TOKEN: 'synthetic-metadata-token',
    GITHUB_WORKFLOW_REF: repository.full_name + '/' + CORE_WORKFLOW + '@refs/heads/main' }
  for (const key of ['SMOKE_OWNER_EMAIL', 'SMOKE_OWNER_PASSWORD', 'INFISICAL_CLIENT_SECRET'])
    Object.defineProperty(env, key, { get() { return assert.fail('selection cannot read ' + key) } })
  const release = { id: 51, run_attempt: 1, repository, head_repository: repository,
    url: API + '/actions/runs/51', name: 'Web deploy', path: '.github/workflows/web-deploy.yml',
    event: 'push', head_branch: 'main', head_sha: SOURCE, status: 'completed', conclusion: 'success' }
  const event = { action: 'completed', repository, workflow_run: release }
  const comment = { id: 1820001, user: { login: options.author ?? 'alexj11324' }, body: marker(options.marker) }
  const comments = options.noMarker ? [] : [comment]
  const pr = { number: 1822, merged: true, merge_commit_sha: SOURCE,
    base: { ref: 'main', repo: repository }, head: { ref: INBOX_BRANCH, sha: HEAD, repo: repository }, ...options.pr }
  const attestation = { ...coreProductionGuard(env, event), version: 1, purpose: 'self-hosted-core-production',
    status: 'ready', readable: true, openIssues: [1820], checkedAt: new Date(NOW).toISOString(), webAttempt: 1, webDeployJobId: 61 }
  let clock = NOW
  const fetchImpl = async (input, init) => {
    const url = new URL(input), headers = new Headers(init.headers)
    calls.push(url.href); assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error'); assert.equal(headers.has('cookie'), false)
    if (url.origin === 'https://app.aspectlylabs.com') {
      assert.equal(url.pathname, '/mikka/api/version'); assert.equal(headers.has('authorization'), false)
      return Response.json({ build: options.version ?? SOURCE })
    }
    assert.equal(url.origin, 'https://api.github.com'); assert.equal(headers.get('authorization'), 'Bearer synthetic-metadata-token')
    const path = url.href.slice(API.length)
    if (path === '/pulls/1822') return Response.json(pr)
    if (path === '/pulls/1856') return Response.json({ number: 1856, user: { login: 'alexj11324' }, merged: false,
      base: { ref: 'main', repo: repository }, head: { ref: INBOX_FOLLOWUP_BRANCH, sha: HEAD, repo: repository } })
    if (path === '/git/commits/' + SOURCE) return Response.json({ sha: SOURCE,
      parents: options.parents ?? [{ sha: PREVIOUS }, { sha: HEAD }] })
    if (path === '/issues/1752') return Response.json({ comments: comments.length })
    if (path.startsWith('/issues/1752/comments?')) return Response.json(comments)
    if (path === '/issues/comments/' + comment.id) {
      if (options.slowWindowRead) clock = Date.parse('2026-11-09T22:30:00Z')
      return Response.json(comment)
    }
    if (path.startsWith('/issues/')) {
      const number = Number(path.slice(8)); assert.ok(CORE_ISSUES.includes(number))
      return Response.json({ number, url: url.href, repository_url: API, state: number === 1820 && !options.closed ? 'open' : 'closed' })
    }
    if (path === '/actions/runs/17') return Response.json({ id: 17, run_attempt: options.attempt ?? 1, repository, head_repository: repository,
      url: url.href, path: CORE_WORKFLOW, event: 'workflow_run', head_branch: 'main', head_sha: SOURCE,
      status: 'in_progress', conclusion: null })
    if (path === '/git/ref/heads/main') return Response.json({ ref: 'refs/heads/main', object: { type: 'commit', sha: options.main ?? SOURCE } })
    if (path === '/actions/runs/51') return Response.json(release)
    if (path === '/actions/runs/51/attempts/1/jobs?per_page=100') return Response.json({ total_count: 1,
      jobs: [{ id: 61, name: 'deploy', run_id: 51, head_sha: SOURCE, status: 'completed', conclusion: 'success',
        steps: ['Verify the official runtime stays on the cloud edition', 'Build (runs migrations last, as the Vercel build did)',
          'Upload the prebuilt output to production', 'Verify the public production version before releasing the deployment queue']
          .map(name => ({ name, status: 'completed', conclusion: 'success' })) }] })
    return assert.fail('Unexpected metadata request ' + path)
  }
  const args = { env, event, attestation, fetchImpl, now: () => clock }
  return { args, calls, comment, comments, pr, options, setTime: value => { clock = value },
    select: expectedSelection => selectInboxProduction({ ...args, expectedSelection }) }
}

test('only the ordinary PR 1822 merge, current real Web publication and live own marker select before credentials', async () => {
  const f = metadata(), proof = await f.select()
  assert.equal(proof.selected, true); assert.equal(proof.status, 'selected'); assert.equal(proof.headSha, HEAD)
  assert.equal(proof.applicationSha, SOURCE); assert.equal(proof.window.sourceSha, SOURCE)
  assert.equal(proof.window.markerSha256.length, 64); assert.equal(proof.window.commentId, f.comment.id)
  assert.deepEqual(proof.attestation.openIssues, [1820])
  assert.equal(f.calls.filter(path => path.endsWith('/mikka/api/version')).length, 2)
  assert.ok(f.calls.includes(API + '/git/commits/' + SOURCE))
  assert.ok(f.calls.includes(API + '/issues/comments/' + f.comment.id))
})

test('a different PR, future head, squash, ordinary later release or unmerged PR declines without an owner request', async () => {
  for (const options of [{ pr: { number: 1831 } }, { pr: { merged: false } }, { pr: { merge_commit_sha: PREVIOUS } },
    { pr: { head: { ref: 'someone-else', sha: HEAD, repo: repository } } },
    { pr: { head: { ref: INBOX_BRANCH, sha: HEAD, repo: { full_name: 'someone/fork' } } } },
    { parents: [{ sha: PREVIOUS }] }, { parents: [{ sha: PREVIOUS }, { sha: 'd'.repeat(40) }] }]) {
    const f = metadata(options), proof = await f.select()
    assert.equal(proof.selected, false); assert.equal(proof.status, 'not_selected')
    assert.equal(f.calls.some(path => path.startsWith('https://app.aspectlylabs.com')), false)
    const report = await runInboxProduction(f.args)
    assert.equal(report.status, 'not_selected'); assert.equal(report.cleanup.originalCookieRejected, undefined)
  }
})

test('old main and a different served production revision decline before any test account access', async () => {
  for (const [options, reason] of [[{ main: PREVIOUS }, 'main_moved'], [{ version: PREVIOUS }, 'deployment_changed']]) {
    const f = metadata(options), proof = await f.select()
    assert.equal(proof.selected, false); assert.equal(proof.reason, reason)
    assert.ok(f.calls.every(path => !path.includes('/api/auth/')))
  }
})

test('a relabelled dispatch or wrong workflow cannot even request PR or window metadata', async () => {
  for (const patch of [{ GITHUB_EVENT_NAME: 'workflow_dispatch' }, { GITHUB_WORKFLOW_REF: 'someone/else@refs/heads/main' }]) {
    const f = metadata()
    await assert.rejects(selectInboxProduction({ ...f.args, env: { ...f.args.env, ...patch } }), /core_configuration/)
    assert.equal(f.calls.length, 0)
  }
})

test('missing, expired, released, foreign or incorrectly bound windows are not selected', async () => {
  for (const options of [{ noMarker: true }, { author: 'another-owner' },
    ...[{ state: 'released' }, { issue: 1821 }, { pr: 1830 }, { headSha: PREVIOUS }, { sourceSha: PREVIOUS },
      { branch: 'someone-else' }, { startsAt: '2026-11-09T22:01:00Z' }, { expiresAt: '2026-11-09T22:00:00Z' },
      { expiresAt: '2026-11-10T00:00:00Z' }].map(marker => ({ marker }))]) {
    const f = metadata(options), proof = await f.select()
    assert.equal(proof.selected, false); assert.equal(proof.reason, 'window_not_active')
    const report = await runInboxProduction(f.args)
    assert.equal(report.status, 'not_selected')
    assert.ok(f.calls.every(path => !path.includes('/api/auth/')))
  }
})

test('ordinary discussion preserves the exact lease but edited and newer own markers reject in-flight work', async () => {
  for (const changed of ['released', 'new-marker', 'same-id-new-expiry', 'main-moved']) {
    const f = metadata(), proof = await f.select()
    f.comments.push({ id: f.comment.id + 1, user: { login: 'alexj11324' }, body: 'Continuing offline review for a different task.' })
    assert.equal((await f.select(proof)).selected, true)
    if (changed === 'released') f.comment.body = marker({ state: 'released' })
    if (changed === 'new-marker') f.comments.push({ id: f.comment.id + 2, user: { login: 'alexj11324' }, body: marker() })
    if (changed === 'same-id-new-expiry') f.comment.body = marker({ expiresAt: '2026-11-09T22:31:00Z' })
    if (changed === 'main-moved') f.options.main = PREVIOUS
    await assert.rejects(f.select(proof), /inbox_window_invalid|core_target_changed/)
  }
})

test('expiry during slow metadata read cannot authorize the next write', async () => {
  const f = metadata(), proof = await f.select()
  f.options.slowWindowRead = true
  await assert.rejects(f.select(proof), /inbox_window_invalid/)
  assert.throws(() => inboxWindowProof(f.comment, { headSha: HEAD, sourceSha: SOURCE,
    expected: proof.window, now: Date.parse('2026-11-09T22:30:00Z') }), /inbox_window_invalid/)
})

test('an already selected run cannot silently turn a changed PR into a successful not-selected result', async () => {
  const f = metadata(), proof = await f.select()
  f.pr.merge_commit_sha = PREVIOUS
  await assert.rejects(f.select(proof), /inbox_selection_changed/)
})

test('fixture selection emits only closed public metadata and pins its source', async () => {
  const fixture = { schema: 1, purpose: 'mikka1820-owner-github-fixture', nonce: '10000000-0000-4000-8000-000000000001',
    ownerHash: 'd'.repeat(64), workspaceId: '10000000-0000-4000-8000-000000000002', applicationSha: SOURCE,
    inventoryRunId: 17, inventoryRunAttempt: 1, createdAt: '2026-11-09T21:59:00Z', expiresAt: '2026-11-09T22:30:00Z',
    github: { repository: 'alexj11324/Mikka-handoff', issueNumber: 73, eventId: 91, kind: 'issue_comment', recipientId: '42', actorId: '7' } }
  const f = metadata({ marker: { phase: 'fixture', fixture: { ...fixture, ignored: 'private-extra-canary' } } })
  const selected = await f.select()
  assert.equal(selected.window.phase, 'fixture'); assert.deepEqual(selected.window.fixture, fixture)
  assert.equal(JSON.stringify(selected).includes('private-extra-canary'), false)
  for (const marker of [{ phase: 'fixture' }, { phase: 'inventory', fixture }, { phase: 'unknown', fixture },
    { phase: 'fixture', fixture: { ...fixture, applicationSha: PREVIOUS } },
    { phase: 'fixture', fixture: { ...fixture, github: { ...fixture.github, repository: 'someone/else' } } }]) {
    const proof = await metadata({ marker }).select()
    assert.equal(proof.selected, false); assert.equal(proof.reason, 'window_not_active')
  }
})

test('cleanup selection pins an exact earlier attempt journal and forbids new fixture metadata', async () => {
  const recovery = { schema: 1, purpose: 'mikka1820-journal-recovery', runId: 17, attempt: 1, jobId: 91, journalSha256: 'e'.repeat(64) }
  const f = metadata({ attempt: 2, marker: { phase: 'cleanup', recovery } }), selected = await f.select()
  assert.equal(selected.selected, true); assert.deepEqual(selected.window.recovery, recovery); assert.equal(selected.window.fixture, null)
  for (const marker of [{ phase: 'cleanup' }, { phase: 'cleanup', recovery: { ...recovery, token: 'private' } },
    { phase: 'inventory', recovery }, { phase: 'cleanup', recovery, fixture: {} }])
    assert.equal((await metadata({ attempt: 2, marker }).select()).selected, false)
  for (const patch of [{ attempt: 2 }, { runId: 18 }])
    await assert.rejects(metadata({ attempt: 2, marker: { phase: 'cleanup', recovery: { ...recovery, ...patch } } }).select(), /inbox_window_invalid/)
})

// These follow-up cases intentionally live in the existing explicit PR and
// production guard file; the new source module cannot become an orphan test.
const followupMarker = (patch = {}) => '<!-- mikka-inbox-followup-1856 ' + JSON.stringify({ schema: 1,
  state: 'active', issue: 1820, pr: INBOX_FOLLOWUP_PR, branch: INBOX_FOLLOWUP_BRANCH,
  headSha: HEAD, sourceSha: SOURCE, originPr: 1822, originMergeSha: INBOX_ORIGINAL_MERGE,
  originHeadSha: INBOX_ORIGINAL_HEAD, startsAt: '2026-11-09T21:59:00Z', expiresAt: '2026-11-09T22:30:00Z', ...patch }) + ' -->'

function followupMetadata(options = {}) {
  const f = metadata({ ...options, marker: undefined, pr: { merge_commit_sha: INBOX_ORIGINAL_MERGE,
    head: { ref: INBOX_BRANCH, sha: INBOX_ORIGINAL_HEAD, repo: repository }, ...options.original } })
  const baseFetch = f.args.fetchImpl
  f.comment.body = followupMarker(options.marker)
  const pr = { number: INBOX_FOLLOWUP_PR, user: { login: 'alexj11324' }, merged: true, merge_commit_sha: SOURCE,
    // Deliberately not the merge's first parent. This projection cannot prove history.
    base: { ref: 'main', sha: INBOX_ORIGINAL_MERGE, repo: repository },
    head: { ref: INBOX_FOLLOWUP_BRANCH, sha: HEAD, repo: repository }, ...options.pr }
  const fetchImpl = async (input, init) => {
    const url = new URL(input), path = url.href.slice(API.length)
    let value
    if (path === '/pulls/' + INBOX_FOLLOWUP_PR) value = pr
    if (path === '/git/commits/' + SOURCE) value = { sha: SOURCE,
      parents: options.parents ?? [{ sha: options.firstParent ?? PREVIOUS }, { sha: HEAD }] }
    if (path === '/git/commits/' + INBOX_ORIGINAL_MERGE) value = { sha: INBOX_ORIGINAL_MERGE,
      parents: options.originalParents ?? [{ sha: 'd'.repeat(40) }, { sha: INBOX_ORIGINAL_HEAD }] }
    if (path === '/git/commits/' + PREVIOUS) value = { sha: PREVIOUS,
      parents: options.previousParents ?? [{ sha: INBOX_ORIGINAL_MERGE }] }
    if (options.graph?.has(path.slice('/git/commits/'.length)) && path.startsWith('/git/commits/'))
      value = options.graph.get(path.slice('/git/commits/'.length))
    if (value !== undefined) {
      f.calls.push(url.href); assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error')
      const headers = new Headers(init.headers)
      assert.equal(headers.has('cookie'), false); assert.equal(headers.get('authorization'), 'Bearer synthetic-metadata-token')
      return Response.json(value)
    }
    return baseFetch(input, init)
  }
  const args = { ...f.args, fetchImpl }
  return { ...f, args, followupPr: pr,
    select: expectedSelection => selectInboxFollowup({ ...args, expectedSelection }) }
}

test('1856 selection binds its own ordinary merge, exact original 1822 first-parent history, Web and bounded marker before credentials', async () => {
  for (const firstParent of [INBOX_ORIGINAL_MERGE, PREVIOUS]) {
    const f = followupMetadata({ firstParent }), proof = await f.select()
    assert.equal(proof.selected, true); assert.equal(proof.pr, 1856); assert.equal(proof.branch, INBOX_FOLLOWUP_BRANCH)
    assert.equal(proof.headSha, HEAD); assert.equal(proof.applicationSha, SOURCE); assert.equal(proof.driverRevision, SOURCE)
    assert.equal(proof.originPr, 1822); assert.equal(proof.originMergeSha, INBOX_ORIGINAL_MERGE)
    assert.equal(proof.originHeadSha, INBOX_ORIGINAL_HEAD); assert.equal(proof.firstParentDepth, firstParent === PREVIOUS ? 1 : 0)
    assert.equal(proof.window.phase, 'inventory'); assert.equal(proof.window.fixture, null); assert.equal(proof.window.recovery, null)
    assert.equal(proof.window.commentId, f.comment.id); assert.equal(proof.window.markerSha256.length, 64)
    assert.equal(f.calls.filter(path => path.endsWith('/mikka/api/version')).length, 2)
    assert.equal(f.calls.some(path => path.includes('/api/auth/')), false)
  }
})

test('unregistered PR, branch, author, fork, squash, head mismatch or later main never becomes a follow-up', async () => {
  const patches = [{ pr: { number: 1857 } }, { pr: { user: { login: 'someone-else' } } }, { pr: { merged: false } },
    { pr: { merge_commit_sha: PREVIOUS } }, { pr: { head: { ref: 'arbitrary-main-probe', sha: HEAD, repo: repository } } },
    { pr: { head: { ref: INBOX_FOLLOWUP_BRANCH, sha: HEAD, repo: { full_name: 'someone/fork' } } } },
    { parents: [{ sha: PREVIOUS }] }, { parents: [{ sha: PREVIOUS }, { sha: 'e'.repeat(40) }] },
    { parents: [{ sha: HEAD }, { sha: HEAD }] }]
  for (const options of patches) {
    const f = followupMetadata(options), proof = await f.select()
    assert.equal(proof.selected, false); assert.equal(proof.status, 'not_selected')
    assert.equal(f.calls.some(path => path.startsWith('https://app.aspectlylabs.com')), false)
    const report = await runInboxProduction({ ...f.args, selectTarget: selectInboxFollowup })
    assert.equal(report.status, 'not_selected'); assert.equal(report.cleanup.originalCookieRejected, undefined)
  }
})

test('the original 1822 metadata and ordinary merge are fixed, not merely any ancestor with similar code', async () => {
  for (const options of [{ original: { merge_commit_sha: PREVIOUS } }, { original: { merged: false } },
    { original: { head: { ref: INBOX_BRANCH, sha: HEAD, repo: repository } } },
    { originalParents: [{ sha: INBOX_ORIGINAL_HEAD }] },
    { originalParents: [{ sha: PREVIOUS }, { sha: HEAD }] }]) {
    const f = followupMetadata(options), proof = await f.select()
    assert.equal(proof.selected, false); assert.equal(f.calls.some(path => path.includes('/mikka/')), false)
  }
})

test('Inbox present only in a second parent cannot replace its earlier main merge, even if PR base.sha claims the anchor', async () => {
  const dead = 'd'.repeat(40)
  for (const previousParents of [[{ sha: dead }, { sha: INBOX_ORIGINAL_MERGE }], [{ sha: dead }]]) {
    const f = followupMetadata({ previousParents, graph: new Map([[dead, { sha: dead, parents: [] }]]) })
    const proof = await f.select()
    assert.equal(f.followupPr.base.sha, INBOX_ORIGINAL_MERGE)
    assert.equal(proof.selected, false); assert.equal(proof.reason, 'original_not_on_first_parent_chain')
    assert.equal(f.calls.some(path => path.includes('/mikka/')), false)
    assert.equal(f.calls.includes(API + '/git/commits/' + HEAD), false, 'never walk the feature branch to obtain main history')
  }
})

test('first-parent traversal is finite and never assumes an unobserved original merge beyond the bound', async () => {
  const ids = Array.from({ length: 66 }, (_, i) => (i + 1000).toString(16).padStart(40, '0'))
  const graph = new Map(ids.map((id, index) => [id, { sha: id, parents: [{ sha: ids[index + 1] ?? INBOX_ORIGINAL_MERGE }] }]))
  const f = followupMetadata({ firstParent: ids[0], graph }), proof = await f.select()
  assert.equal(proof.selected, false); assert.equal(proof.reason, 'original_not_on_first_parent_chain')
  assert.equal(f.calls.filter(path => ids.some(id => path === API + '/git/commits/' + id)).length, 64)
  const cycle = followupMetadata({ previousParents: [{ sha: PREVIOUS }] })
  assert.equal((await cycle.select()).selected, false)
  assert.equal(cycle.calls.filter(path => path === API + '/git/commits/' + PREVIOUS).length, 1)
})

test('follow-up rejects dispatch, old main, wrong public version and closed Inbox before test account access', async () => {
  const dispatch = followupMetadata()
  await assert.rejects(selectInboxFollowup({ ...dispatch.args, env: { ...dispatch.args.env, GITHUB_EVENT_NAME: 'workflow_dispatch' } }), /core_configuration/)
  assert.equal(dispatch.calls.length, 0)
  for (const [options, reason] of [[{ main: PREVIOUS }, 'main_moved'], [{ version: PREVIOUS }, 'deployment_changed']]) {
    const f = followupMetadata(options), proof = await f.select()
    assert.equal(proof.selected, false); assert.equal(proof.reason, reason)
    assert.equal(f.calls.some(path => path.includes('/api/auth/')), false)
  }
  const closed = followupMetadata({ closed: true })
  assert.equal((await selectInboxFollowup({ ...closed.args, attestation: { ...closed.args.attestation, status: 'skipped' } })).reason, 'inbox_issue_closed')
  await assert.rejects(closed.select(), /core_issue/, 'an issue closed after the ready attestation is a revoked source proof')
})

test('only the named 1856 owner window with the exact origin/source/head and three existing Inbox phases can grant selection', async () => {
  for (const options of [{ noMarker: true }, { author: 'another-owner' },
    ...[{ state: 'released' }, { issue: 1642 }, { pr: 1830 }, { branch: 'other' }, { headSha: PREVIOUS }, { sourceSha: PREVIOUS },
      { originPr: 1831 }, { originMergeSha: PREVIOUS }, { originHeadSha: HEAD }, { stage: 'organization-audit' },
      { phase: 'organization-audit' }, { startsAt: '2026-11-09T22:01:00Z' }, { expiresAt: '2026-11-09T22:00:00Z' },
      { expiresAt: '2026-11-10T00:00:00Z' }].map(marker => ({ marker }))]) {
    const f = followupMetadata(options), proof = await f.select()
    assert.equal(proof.selected, false); assert.equal(proof.reason, 'window_not_active')
  }
})

test('an edited/new/released 1856 marker, moved PR/main or an expiry during read stops the selected run', async () => {
  for (const change of ['edited', 'new', 'released', 'head', 'main', 'expired']) {
    const f = followupMetadata(), proof = await f.select()
    f.comments.push({ id: f.comment.id + 1, user: { login: 'alexj11324' }, body: 'An unrelated progress comment.' })
    assert.equal((await f.select(proof)).selected, true)
    if (change === 'edited') f.comment.body = followupMarker({ expiresAt: '2026-11-09T22:31:00Z' })
    if (change === 'new') f.comments.push({ id: f.comment.id + 2, user: { login: 'alexj11324' }, body: followupMarker() })
    if (change === 'released') f.comment.body = followupMarker({ state: 'released' })
    if (change === 'head') f.followupPr.head = { ...f.followupPr.head, sha: PREVIOUS }
    if (change === 'main') f.options.main = PREVIOUS
    if (change === 'expired') f.options.slowWindowRead = true
    await assert.rejects(f.select(proof), /inbox_window_invalid|inbox_selection_changed|core_target_changed/)
  }
})

test('a source-bound follow-up fixture uses its own inventory and cannot relabel the original 325 nonce', async () => {
  const fixture = { schema: 1, purpose: 'mikka1820-owner-github-fixture', nonce: '10000000-0000-4000-8000-000000000001',
    ownerHash: 'd'.repeat(64), workspaceId: '10000000-0000-4000-8000-000000000002', applicationSha: SOURCE,
    inventoryRunId: 17, inventoryRunAttempt: 1, createdAt: '2026-11-09T21:59:00Z', expiresAt: '2026-11-09T22:30:00Z',
    github: { repository: 'alexj11324/Mikka-handoff', issueNumber: 73, eventId: 91, kind: 'issue_comment', recipientId: '42', actorId: '7' } }
  const proof = await followupMetadata({ attempt: 2, marker: { phase: 'fixture', fixture } }).select()
  assert.equal(proof.selected, true); assert.deepEqual(proof.window.fixture, fixture)
  for (const marker of [{ phase: 'fixture' }, { phase: 'inventory', fixture },
    { phase: 'fixture', fixture: { ...fixture, applicationSha: INBOX_ORIGINAL_MERGE } }])
    assert.equal((await followupMetadata({ marker }).select()).selected, false)
})

test('follow-up cleanup accepts only the same current driver run and an earlier attempt, preserving the original recovery contract', async () => {
  const recovery = { schema: 1, purpose: 'mikka1820-journal-recovery', runId: 17, attempt: 1, jobId: 91, journalSha256: 'e'.repeat(64) }
  const f = followupMetadata({ attempt: 2, marker: { phase: 'cleanup', recovery } }), proof = await f.select()
  assert.equal(proof.selected, true); assert.deepEqual(proof.window.recovery, recovery)
  for (const patch of [{ runId: 18 }, { attempt: 2 }])
    await assert.rejects(followupMetadata({ attempt: 2, marker: { phase: 'cleanup', recovery: { ...recovery, ...patch } } }).select(), /inbox_window_invalid/)
  const old = await metadata().select()
  await assert.rejects(f.select(old), /inbox_selection_changed/)
  assert.throws(() => inboxFollowupWindowProof(f.comment, { headSha: HEAD, sourceSha: SOURCE,
    expected: proof.window, now: Date.parse('2026-11-09T22:30:00Z') }), /inbox_window_invalid/)
})

test('the existing selection entry chooses exactly one source route and never falls back after a chosen lease is withdrawn', async () => {
  const original = metadata(), originalProof = await selectInboxAcceptance(original.args)
  assert.equal(originalProof.purpose, 'inbox-1820-production-selection'); assert.equal(originalProof.selected, true)
  assert.equal(original.calls.some(path => path.endsWith('/pulls/1856')), false)
  const followup = followupMetadata(), next = await selectInboxAcceptance(followup.args)
  assert.equal(next.purpose, 'inbox-1820-followup-selection'); assert.equal(next.selected, true)
  assert.deepEqual(next.attestation.openIssues, [1820], '1856 does not invent another Core business issue')
  assert.equal(next.attestation.openIssues.some(number => number !== 1820), false)
  const later = followupMetadata({ pr: { merge_commit_sha: PREVIOUS } })
  assert.equal((await selectInboxAcceptance(later.args)).selected, false)
  assert.equal(later.calls.some(path => path.includes('/api/auth/')), false)
  original.comment.body = marker({ state: 'released' })
  const originalStart = original.calls.length
  await assert.rejects(selectInboxAcceptance({ ...original.args, expectedSelection: originalProof }), /inbox_window_invalid/)
  assert.equal(original.calls.slice(originalStart).some(path => path.endsWith('/pulls/1856')), false)
  followup.followupPr.merged = false
  const followupStart = followup.calls.length
  await assert.rejects(selectInboxAcceptance({ ...followup.args, expectedSelection: next }), /inbox_selection_changed/)
  assert.equal(followup.calls.slice(followupStart).some(path => path.endsWith('/pulls/1822')), false)
})
