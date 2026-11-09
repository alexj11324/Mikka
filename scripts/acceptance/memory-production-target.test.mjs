import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import yaml from 'js-yaml'
import { MEMORY_BRANCH, memoryWindowProof, selectMemoryProduction } from './memory-production-target.mjs'
import { CORE_MODE, CORE_WORKFLOW, CORE_ISSUES, CORE_BUSINESS_ISSUES, coreBusinessSelected, coreProductionGuard } from './self-hosted-production-target.mjs'
import { runCoreProduction } from './self-hosted-production.mjs'
import { runMemoryProduction } from './memory-production.mjs'
import { MEMORY_CASE_STEPS } from './memory-production-cases.mjs'

const SOURCE = 'a'.repeat(40), HEAD = 'b'.repeat(40), PREVIOUS = 'c'.repeat(40)
const API = 'https://api.github.com/repos/alexj11324/Mikka'
const NOW = Date.parse('2026-11-09T22:00:00Z')
const repository = { full_name: 'alexj11324/Mikka', owner: { login: 'alexj11324' } }
const NONCE = '60000000-0000-4000-8000-000000000001'
const NOTIFICATION_URL = 'https://github.com/alexj11324/Mikka/issues/1821#issuecomment-1821002'
const NOTIFICATION_BODY = 'Normal notification mikka-memory-1821:' + NONCE
const NOTIFICATION = { provider: 'github', url: NOTIFICATION_URL,
  bodySha256: createHash('sha256').update(NOTIFICATION_BODY).digest('hex') }
const marker = (patch = {}) => '<!-- mikka-memory-1821 ' + JSON.stringify({ state: 'active', issue: 1821, pr: 1830,
  branch: MEMORY_BRANCH, headSha: HEAD, sourceSha: SOURCE, startsAt: '2026-11-09T21:59:00Z',
  expiresAt: '2026-11-09T22:30:00Z', phase: 'inventory', fixtureNonce: NONCE, ...patch }) + ' -->'

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
  const comment = { id: 1821001, user: { login: options.author ?? 'alexj11324' }, body: marker(options.marker) }
  const comments = options.noMarker ? [] : [comment]
  const pr = { number: 1830, merged: true, merge_commit_sha: SOURCE,
    base: { ref: 'main', repo: repository }, head: { ref: MEMORY_BRANCH, sha: HEAD, repo: repository }, ...options.pr }
  const attestation = { ...coreProductionGuard(env, event), version: 1, purpose: 'self-hosted-core-production',
    status: 'ready', readable: true, openIssues: [1821], checkedAt: new Date(NOW).toISOString(), webAttempt: 1, webDeployJobId: 61 }
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
    if (path === '/pulls/1830') return Response.json(pr)
    if (path === '/git/commits/' + SOURCE) return Response.json({ sha: SOURCE,
      parents: options.parents ?? [{ sha: PREVIOUS }, { sha: HEAD }] })
    if (path === '/issues/1752') return Response.json({ comments: comments.length })
    if (path.startsWith('/issues/1752/comments?')) return Response.json(comments)
    if (path === '/issues/comments/' + comment.id) {
      if (options.slowWindowRead) clock = Date.parse('2026-11-09T22:30:00Z')
      return Response.json(comment)
    }
    if (path === '/issues/comments/1821002') {
      if (options.slowNotificationRead) clock = Date.parse('2026-11-09T22:30:00Z')
      return Response.json({ id: 1821002, html_url: NOTIFICATION_URL,
        issue_url: API + '/issues/1821', created_at: '2026-11-09T21:59:30Z', updated_at: '2026-11-09T21:59:30Z',
        body: options.notificationBody ?? NOTIFICATION_BODY })
    }
    if (path.startsWith('/issues/')) {
      const number = Number(path.slice(8)); assert.ok(CORE_ISSUES.includes(number))
      return Response.json({ number, url: url.href, repository_url: API, state: number === 1821 && !options.closed ? 'open' : 'closed' })
    }
    if (path === '/actions/runs/17') return Response.json({ id: 17, run_attempt: options.attempt ?? 1, repository, head_repository: repository,
      url: url.href, path: CORE_WORKFLOW, event: 'workflow_run', head_branch: 'main', head_sha: SOURCE,
      status: 'in_progress', conclusion: null })
    if (path === '/actions/runs/17/attempts/1/jobs?per_page=100') return Response.json({ total_count: 1, jobs: [{
      id: 171, name: 'Core production API and gateway acceptance', run_id: 17, run_attempt: 1,
      head_sha: options.priorHead ?? SOURCE, status: 'completed', conclusion: 'failure',
      steps: [{ number: 10, name: MEMORY_CASE_STEPS.claude_code, status: 'completed', conclusion: 'success' },
        { number: 11, name: MEMORY_CASE_STEPS.codex, status: 'completed', conclusion: 'success' },
        { number: 12, name: MEMORY_CASE_STEPS.pending, status: 'completed', conclusion: 'skipped' }],
    }] })
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
    select: expectedSelection => selectMemoryProduction({ ...args, expectedSelection }) }
}

test('only the ordinary PR 1830 merge, current real Web publication and live own marker select before credentials', async () => {
  const f = metadata(), proof = await f.select()
  assert.equal(proof.selected, true); assert.equal(proof.status, 'selected'); assert.equal(proof.headSha, HEAD)
  assert.equal(proof.applicationSha, SOURCE); assert.equal(proof.window.sourceSha, SOURCE)
  assert.equal(proof.window.markerSha256.length, 64); assert.equal(proof.window.commentId, f.comment.id)
  assert.deepEqual(proof.attestation.openIssues, [1821])
  assert.equal(f.calls.filter(path => path.endsWith('/mikka/api/version')).length, 2)
  assert.ok(f.calls.includes(API + '/git/commits/' + SOURCE))
  assert.ok(f.calls.includes(API + '/issues/comments/' + f.comment.id))
  assert.equal(proof.notification, null)
  assert.equal(f.calls.some(path => path.includes('/issues/comments/1821002')), false)
  assert.equal(f.calls.some(path => path.includes('/actions/runs/17/attempts/')), false)
})

test('fixture selection verifies the real source event and same-run prior successful cases before owner credentials', async () => {
  const f = metadata({ attempt: 2, marker: { phase: 'fixture', notification: NOTIFICATION } }), proof = await f.select()
  assert.equal(proof.selected, true); assert.equal(proof.notification.url, NOTIFICATION_URL)
  assert.equal(proof.notification.nonce, NONCE); assert.equal(proof.notification.createdAt, '2026-11-09T21:59:30Z')
  assert.equal(proof.cases.claude_code.reused.sourceSha, SOURCE); assert.equal(proof.cases.codex.reused.runAttempt, 1)
  assert.equal(proof.cases.pending.reused, null)
  assert.ok(f.calls.includes(API + '/actions/runs/17/attempts/1/jobs?per_page=100'))
  assert.ok(f.calls.includes(API + '/issues/comments/1821002'))
  assert.equal((await f.select(proof)).selected, true)
})

test('an edited notification, wrong prior source or expiry during provider metadata cannot reach account access', async () => {
  for (const [options, code] of [[{ notificationBody: NOTIFICATION_BODY + 'changed' }, 'notification_fixture_invalid'],
    [{ attempt: 2, priorHead: PREVIOUS }, 'memory_case_proof_invalid'], [{ slowNotificationRead: true }, 'memory_window_invalid']]) {
    const f = metadata({ ...options, marker: { phase: 'fixture', notification: NOTIFICATION } })
    await assert.rejects(f.select(), new RegExp(code))
    assert.ok(f.calls.every(path => !path.includes('/api/auth/')))
  }
})

test('a different PR, future head, squash, ordinary later release or unmerged PR declines without an owner request', async () => {
  for (const options of [{ pr: { number: 1831 } }, { pr: { merged: false } }, { pr: { merge_commit_sha: PREVIOUS } },
    { pr: { head: { ref: 'someone-else', sha: HEAD, repo: repository } } },
    { pr: { head: { ref: MEMORY_BRANCH, sha: HEAD, repo: { full_name: 'someone/fork' } } } },
    { parents: [{ sha: PREVIOUS }] }, { parents: [{ sha: PREVIOUS }, { sha: 'd'.repeat(40) }] }]) {
    const f = metadata(options), proof = await f.select()
    assert.equal(proof.selected, false); assert.equal(proof.status, 'not_selected')
    assert.equal(f.calls.some(path => path.startsWith('https://app.aspectlylabs.com')), false)
    const report = await runMemoryProduction(f.args)
    assert.equal(report.status, 'not_selected'); assert.equal(report.cleanup.sessionRevoked, false)
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
    await assert.rejects(selectMemoryProduction({ ...f.args, env: { ...f.args.env, ...patch } }), /core_configuration/)
    assert.equal(f.calls.length, 0)
  }
})

test('missing, expired, released, foreign or incorrectly bound windows are not selected', async () => {
  for (const options of [{ noMarker: true }, { author: 'another-owner' },
    ...[{ state: 'released' }, { issue: 1820 }, { pr: 1822 }, { headSha: PREVIOUS }, { sourceSha: PREVIOUS },
      { branch: 'someone-else' }, { startsAt: '2026-11-09T22:01:00Z' }, { expiresAt: '2026-11-09T22:00:00Z' },
      { expiresAt: '2026-11-10T00:00:00Z' }].map(marker => ({ marker }))]) {
    const f = metadata(options), proof = await f.select()
    assert.equal(proof.selected, false); assert.equal(proof.reason, 'window_not_active')
    const report = await runMemoryProduction(f.args)
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
    await assert.rejects(f.select(proof), /memory_window_invalid|core_target_changed/)
  }
})

test('expiry during slow metadata read cannot authorize the next write', async () => {
  const f = metadata(), proof = await f.select()
  f.options.slowWindowRead = true
  await assert.rejects(f.select(proof), /memory_window_invalid/)
  assert.throws(() => memoryWindowProof(f.comment, { headSha: HEAD, sourceSha: SOURCE,
    expected: proof.window, now: Date.parse('2026-11-09T22:30:00Z') }), /memory_window_invalid/)
})

test('an already selected run cannot silently turn a changed PR into a successful not-selected result', async () => {
  const f = metadata(), proof = await f.select()
  f.pr.merge_commit_sha = PREVIOUS
  await assert.rejects(f.select(proof), /memory_selection_changed/)
})

test('only Memory open does not select legacy Core business or credentials for an unrelated main release', async () => {
  const f = metadata({ pr: { merge_commit_sha: PREVIOUS } })
  const memory = await f.select()
  assert.equal(memory.selected, false)
  assert.equal(coreBusinessSelected(f.args.attestation), false)
  const core = await runCoreProduction(f.args)
  assert.deepEqual(core, { status: 'skipped', code: 'core_business_issues_closed', applicationSha: SOURCE, driverRunId: 17 })
  assert.ok(f.calls.every(path => !path.includes('/api/auth/')))
  assert.deepEqual(CORE_BUSINESS_ISSUES, [1560, 1561, 1562, 1556, 1826])
  for (const issue of CORE_BUSINESS_ISSUES) assert.equal(coreBusinessSelected({ ...f.args.attestation, openIssues: [issue] }), true)

  const workflow = yaml.load(await readFile(new URL('../../.github/workflows/self-hosted-production.yml', import.meta.url), 'utf8'))
  const steps = workflow.jobs.acceptance.steps
  const selector = steps.findIndex(step => step.id === 'memory_select')
  const secrets = steps.filter(step => step.uses?.startsWith('Infisical/secrets-action@'))
  assert.equal(secrets.length, 2)
  for (const step of secrets) {
    assert.ok(selector < steps.indexOf(step), 'read-only selection precedes both existing Infisical account reads')
    assert.equal(step.if, "steps.attest.outputs.core_selected == 'true' || steps.memory_select.outputs.selected == 'true'")
  }
  assert.equal(steps.find(step => step.run === 'node --import tsx scripts/acceptance/self-hosted-production.mjs').if,
    "steps.attest.outputs.core_selected == 'true'")
  assert.equal(steps.find(step => step.run === 'node --import tsx scripts/acceptance/memory-production.mjs').if,
    "always() && steps.memory_select.outputs.selected == 'true'")
  const selected = await metadata().select()
  assert.equal(coreBusinessSelected(selected.attestation), false)
  assert.equal(selected.selected, true, 'the exact Memory window can select its own account operation while legacy Core stays off')
})
