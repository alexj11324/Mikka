import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test, { type TestContext } from 'node:test'
import { CodingWorkspaceError } from '@mikka/protocol/coding-workspace'
import { WorkspaceReviewError } from '@mikka/protocol/coding-workspace-review'
import { createSecretMasker, identityMasker, withCredentialMasking, type Masker } from '../../secrets/mask'
import { GitHubDiffClient } from '../diff/github-api'
import { readNativeReviewChecks } from './github-checks'

const head = createHash('sha1').update('checks fixture commit').digest('hex')
const otherHead = createHash('sha1').update('another checks fixture commit').digest('hex')
const repositoryId = '9007199254740993'
const fullName = 'fixture/review', path = `/repos/${fullName}`, token = 'fixture-checks-viewer-token'
const stamp = '2026-11-08T12:00:00.000Z'
const code = (expected: string) => (error: unknown) =>
  (error instanceof WorkspaceReviewError || error instanceof CodingWorkspaceError) && error.code === expected

type NativeRun = {
  id: string | number; head_sha: string; name: string; status: string; conclusion: string | null; completed_at: string | null;
  output: { title: string | null; summary: string | null; text?: string | null; annotations_count?: number; annotations_url?: string } | null;
  [key: string]: unknown;
}
type NativeStatus = { id: string | number; state: string; context: string; description: string | null; updated_at: string; [key: string]: unknown }
const run = (id: string | number, conclusion: string | null = 'success', changes: Partial<NativeRun> = {}): NativeRun => ({
  id, head_sha: head, name: `check ${id}`, status: conclusion === null ? 'queued' : 'completed', conclusion,
  completed_at: conclusion === null ? null : stamp,
  output: { title: null, summary: null, text: null, annotations_count: 0,
    annotations_url: 'https://outside.invalid/private-annotations' },
  details_url: 'https://outside.invalid/private-job-log', ...changes,
})
const status = (id: string | number, state = 'success', changes: Partial<NativeStatus> = {}): NativeStatus => ({
  id, state, context: `context ${id}`, description: null, updated_at: stamp,
  target_url: 'https://outside.invalid/private-status-log', ...changes,
})
type Kind = 'suites' | 'runs' | 'statuses'
type Page = { value: Record<string, unknown>; next: boolean }
type Data = { runs: NativeRun[]; statuses: NativeStatus[]; suites: number }

function fixture(t: TestContext, initial: Partial<Data> = {}, mutate?: (kind: Kind, page: number, reply: Page) => Page) {
  const data: Data = { runs: [], statuses: [], suites: 1, ...structuredClone(initial) }
  const calls: URL[] = []
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input)); calls.push(url)
    assert.equal(url.origin, 'https://api.github.com')
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error')
    assert.equal(init.credentials, 'omit'); assert.equal(init.cache, 'no-store')
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${token}`)
    assert.ok(init.signal instanceof AbortSignal)
    const page = Number(url.searchParams.get('page') ?? '1')
    let kind: Kind, reply: Page
    if (url.pathname === `${path}/commits/${head}/check-suites`) {
      kind = 'suites'; assert.equal(url.searchParams.get('per_page'), '1')
      reply = { value: { total_count: data.suites, check_suites: [] }, next: data.suites > 1 }
    } else if (url.pathname === `${path}/commits/${head}/check-runs`) {
      kind = 'runs'; assert.equal(url.searchParams.get('filter'), 'latest')
      assert.equal(url.searchParams.get('per_page'), '100')
      reply = { value: { total_count: data.runs.length, check_runs: data.runs.slice((page - 1) * 100, page * 100) }, next: data.runs.length > page * 100 }
    } else {
      assert.equal(url.pathname, `${path}/commits/${head}/status`)
      kind = 'statuses'; assert.equal(url.searchParams.get('per_page'), '100')
      reply = { value: { sha: head, total_count: data.statuses.length,
        repository: { id: repositoryId, full_name: fullName },
        statuses: data.statuses.slice((page - 1) * 100, page * 100) }, next: data.statuses.length > page * 100 }
    }
    if (mutate) reply = mutate(kind, page, structuredClone(reply))
    return Response.json(reply.value, { headers: reply.next ? { link: '<https://outside.invalid/do-not-follow?credential=fixture>; rel="next"' } : {} })
  })
  const read = (masks: Masker[] = [identityMasker], rawHead = head) => readNativeReviewChecks({
    client: new GitHubDiffClient(token, { deadline: Date.now() + 30_000 }), repositoryId, fullName, path,
  }, rawHead, masks)
  return { data, calls, read }
}

test('all native check conclusions are classified without counting neutral or skipped as passed', async t => {
  for (const [conclusion, expected] of [
    ['success', 'passed'], ['neutral', 'neutral'], ['skipped', 'neutral'],
    ['action_required', 'failed'], ['cancelled', 'failed'], ['failure', 'failed'], ['stale', 'failed'], ['timed_out', 'failed'],
  ] as const) await t.test(conclusion, async t => {
    const f = fixture(t, { runs: [run(1, conclusion)] }), result = await f.read()
    assert.equal(result.checks[0]!.status, expected)
    assert.equal(result.checks[0]!.conclusion, conclusion)
    assert.deepEqual(result.counts, { total: 1, failed: Number(expected === 'failed'), passed: Number(expected === 'passed'),
      pending: 0, neutral: Number(expected === 'neutral') })
  })
})

test('every native unfinished state remains pending and cannot become a passing conclusion', async t => {
  for (const state of ['queued', 'in_progress', 'waiting', 'requested', 'pending']) await t.test(state, async t => {
    const f = fixture(t, { runs: [run(1, null, { status: state })] }), result = await f.read()
    assert.equal(result.checks[0]!.status, 'pending')
    assert.equal(result.checks[0]!.conclusion, null)
    assert.deepEqual(result.counts, { total: 1, failed: 0, passed: 0, pending: 1, neutral: 0 })
  })
})

test('combined commit contexts retain their native error, failure, pending and success states', async t => {
  for (const [state, expected] of [['error', 'failed'], ['failure', 'failed'], ['pending', 'pending'], ['success', 'passed']] as const)
    await t.test(state, async t => {
      const f = fixture(t, { statuses: [status(1, state)] }), result = await f.read()
      assert.equal(result.checks[0]!.kind, 'commit_status')
      assert.equal(result.checks[0]!.status, expected); assert.equal(result.checks[0]!.conclusion, state)
      assert.equal(result.counts[expected], 1)
    })
})

test('same-name checks and cross-kind native ids remain distinct, including ids above 2^53', async t => {
  const f = fixture(t, { runs: [run(repositoryId, 'failure', { name: 'build' }), run('9007199254740994', 'success', { name: 'build' })],
    statuses: [status(repositoryId, 'pending', { context: 'build' })] })
  const result = await f.read()
  assert.equal(result.repositoryId, repositoryId)
  assert.deepEqual(result.checks.map(item => [item.kind, item.nativeId, item.name]), [
    ['check_run', repositoryId, 'build'], ['check_run', '9007199254740994', 'build'], ['commit_status', repositoryId, 'build'],
  ])
  assert.deepEqual(result.counts, { total: 3, failed: 1, passed: 1, pending: 1, neutral: 0 })
})

test('the combined-status endpoint supplies only the latest context observation, without fetching status history or log URLs', async t => {
  const f = fixture(t, { statuses: [status(8, 'success', { context: 'ci/build' }), status(9, 'failure', { context: 'security' })] })
  const result = await f.read()
  assert.deepEqual(result.checks.map(item => [item.nativeId, item.name, item.status]), [['8', 'ci/build', 'passed'], ['9', 'security', 'failed']])
  assert.equal(f.calls.length, 3)
  assert.equal(f.calls.at(-1)!.pathname, `${path}/commits/${head}/status`)
  assert.ok(f.calls.every(url => !url.pathname.includes('/statuses/') && url.origin === 'https://api.github.com'))
})

test('complete multiple pages use generated fixed-origin URLs and preserve all native items', async t => {
  const f = fixture(t, { runs: Array.from({ length: 101 }, (_, i) => run(i + 1)), statuses: Array.from({ length: 101 }, (_, i) => status(i + 1)) })
  const result = await f.read()
  assert.equal(result.counts.total, 202); assert.equal(result.counts.passed, 202)
  assert.equal(new Set(result.checks.map(item => `${item.kind}:${item.nativeId}`)).size, 202)
  assert.deepEqual(f.calls.map(url => [url.pathname.split('/').at(-1), url.searchParams.get('page')]), [
    ['check-suites', null], ['check-runs', '1'], ['check-runs', '2'], ['status', '1'], ['status', '2'],
  ])
})

test('partial, drifting or duplicate pages never yield a successful complete observation', async t => {
  const runs = Array.from({ length: 101 }, (_, i) => run(i + 1)), statuses = Array.from({ length: 101 }, (_, i) => status(i + 1))
  const cases: [string, (kind: Kind, page: number, reply: Page) => Page][] = [
    ['check head moves on page two', (kind, page, reply) => {
      if (kind === 'runs' && page === 2) (reply.value.check_runs as NativeRun[])[0]!.head_sha = otherHead
      return reply
    }],
    ['combined head moves on page two', (kind, page, reply) => {
      if (kind === 'statuses' && page === 2) reply.value.sha = otherHead
      return reply
    }],
    ['repository id replaced on page two', (kind, page, reply) => {
      if (kind === 'statuses' && page === 2) reply.value.repository = { id: '9007199254740994', full_name: fullName }
      return reply
    }],
    ['repository name replaced on page two', (kind, page, reply) => {
      if (kind === 'statuses' && page === 2) reply.value.repository = { id: repositoryId, full_name: 'other/review' }
      return reply
    }],
    ['run total changes', (kind, page, reply) => { if (kind === 'runs' && page === 2) reply.value.total_count = 102; return reply }],
    ['status total changes', (kind, page, reply) => { if (kind === 'statuses' && page === 2) reply.value.total_count = 102; return reply }],
    ['duplicate run id across pages', (kind, page, reply) => {
      if (kind === 'runs' && page === 2) (reply.value.check_runs as NativeRun[])[0]!.id = 1
      return reply
    }],
    ['duplicate status id across pages', (kind, page, reply) => {
      if (kind === 'statuses' && page === 2) (reply.value.statuses as NativeStatus[])[0]!.id = 1
      return reply
    }],
    ['duplicate latest context across pages', (kind, page, reply) => {
      if (kind === 'statuses' && page === 2) (reply.value.statuses as NativeStatus[])[0]!.context = 'context 1'
      return reply
    }],
    ['missing run continuation', (kind, page, reply) => { if (kind === 'runs' && page === 1) reply.next = false; return reply }],
    ['missing status continuation', (kind, page, reply) => { if (kind === 'statuses' && page === 1) reply.next = false; return reply }],
    ['extra run continuation after the last page', (kind, page, reply) => { if (kind === 'runs' && page === 2) reply.next = true; return reply }],
    ['extra status continuation after the last page', (kind, page, reply) => { if (kind === 'statuses' && page === 2) reply.next = true; return reply }],
    ['short run first page', (kind, page, reply) => { if (kind === 'runs' && page === 1) (reply.value.check_runs as NativeRun[]).pop(); return reply }],
    ['short status final page', (kind, page, reply) => { if (kind === 'statuses' && page === 2) reply.value.statuses = []; return reply }],
  ]
  for (const [name, mutate] of cases) await t.test(name, async t => {
    const f = fixture(t, { runs, statuses }, mutate)
    await assert.rejects(f.read(), code('workspace_review_github_unavailable'))
    assert.ok(f.calls.length <= 5, 'an invalid page is not repaired by polling or an extra page')
  })
})

test('500 total checks and 1000 suites are inclusive, separate resource boundaries', async t => {
  for (const [name, runs, statuses] of [['all runs', 500, 0], ['all statuses', 0, 500], ['combined', 300, 200]] as const)
    await t.test(name, async t => {
      const f = fixture(t, { suites: 1000, runs: Array.from({ length: runs }, (_, i) => run(i + 1)),
        statuses: Array.from({ length: statuses }, (_, i) => status(i + 1)) })
      assert.equal((await f.read()).counts.total, 500)
      assert.ok(f.calls.length <= 7)
    })
  for (const [name, suites, runs, statuses, calls] of [
    ['1001 suites', 1001, 0, 0, 1], ['501 runs', 1, 501, 0, 2],
    ['501 statuses', 1, 0, 501, 3], ['combined 501', 1, 450, 51, 7],
  ] as const) await t.test(name, async t => {
    const f = fixture(t, { suites, runs: Array.from({ length: runs }, (_, i) => run(i + 1)), statuses: Array.from({ length: statuses }, (_, i) => status(i + 1)) })
    await assert.rejects(f.read(), code('workspace_limit_exceeded'))
    assert.equal(f.calls.length, calls)
  })
})

test('unknown or inconsistent native states and unsafe numeric ids fail closed', async t => {
  for (const [name, bad] of [
    ['unknown conclusion', run(1, 'invented')], ['unknown status', run(1, null, { status: 'invented' })],
    ['completed without conclusion', run(1, null, { status: 'completed' })],
    ['running with a final conclusion', run(1, 'success', { status: 'in_progress' })],
    ['imprecise native id', run(Number.MAX_SAFE_INTEGER + 1)],
  ] as const) await t.test(name, async t => {
    const f = fixture(t, { runs: [bad] })
    await assert.rejects(f.read(), code('workspace_review_github_unavailable'))
  })
  await t.test('invalid requested head sends no HTTP', async t => {
    const f = fixture(t)
    await assert.rejects(f.read([identityMasker], 'main'))
    assert.equal(f.calls.length, 0)
  })
})

test('the native response requires nullable output fields even when a write request may omit text', async t => {
  await t.test('all nullable fields are present', async t => {
    const f = fixture(t, { runs: [run(1, 'failure', { output: { title: null, summary: null, text: null } })] })
    const result = await f.read()
    assert.equal(result.checks[0]!.logExcerpt, '')
    assert.equal(result.checks[0]!.logTruncated, false)
    assert.equal(result.counts.failed, 1)
  })
  await t.test('missing text in a REST response is malformed', async t => {
    // The REST check-run response declares text: string | null; only the write input makes it optional.
    const f = fixture(t, { runs: [run(1, 'failure', { output: { title: 'build failed', summary: 'Compiler failed.', annotations_count: 0 } })] })
    await assert.rejects(f.read(), code('workspace_review_github_unavailable'))
  })
})

test('full provider text is masked before truncating names, excerpts and joined output fields', async t => {
  const secret = 'BOUNDARY_SECRET_MUST_NEVER_BE_PARTIAL', multiline = 'private-part-one\n\nprivate-part-two'
  const f = fixture(t, { runs: [run(1, 'failure', { name: 'n'.repeat(195) + secret + 'tail',
    output: { title: null, summary: 'l'.repeat(1995) + secret + 'tail', text: null } }),
  run(2, 'failure', { output: { title: 'private-part-one', summary: 'private-part-two', text: null } })],
  statuses: [status(1, 'failure', { description: Buffer.from(secret).toString('base64') })] })
  const result = await f.read([createSecretMasker([{ name: 'BOUNDARY', value: secret }, { name: 'MULTILINE', value: multiline }])])
  const first = result.checks.find(item => item.kind === 'check_run' && item.nativeId === '1')!
  assert.equal(first.name.length, 200); assert.equal(first.nameTruncated, true)
  assert.equal(first.logExcerpt.length, 2000); assert.equal(first.logTruncated, true)
  assert.ok(!first.name.includes('BOUND')); assert.ok(!first.logExcerpt.includes('BOUND'))
  assert.equal(result.checks.find(item => item.nativeId === '2')!.logExcerpt, '[secret:MULTILINE]')
  const serialized = JSON.stringify(result)
  for (const privateText of [secret, Buffer.from(secret).toString('base64'), 'private-part-one', 'private-part-two'])
    assert.ok(!serialized.includes(privateText))
})

test('owner, viewer and credential masks all apply, and nonfailed checks expose no log text', async t => {
  const owner = 'owner-private-value', viewer = 'viewer-private-value', credential = 'ghp_' + 'q'.repeat(40)
  const log = `${owner} ${viewer} ${credential}`
  const f = fixture(t, { runs: [run(1, 'failure', { output: { title: log, summary: null, text: null } }),
    run(2, 'success', { output: { title: 'a successful private log', summary: null, text: null } }),
    run(3, 'neutral', { output: { title: 'a neutral private log', summary: null, text: null } })] })
  const result = await f.read([createSecretMasker([{ name: 'OWNER', value: owner }]),
    withCredentialMasking(createSecretMasker([{ name: 'VIEWER', value: viewer }]))])
  assert.equal(result.checks[0]!.logExcerpt, '[secret:OWNER] [secret:VIEWER] [secret:github-token]')
  for (const check of result.checks.filter(item => item.status !== 'failed')) {
    assert.equal(check.logExcerpt, ''); assert.equal(check.logTruncated, true)
  }
  for (const privateText of [owner, viewer, credential, 'a successful private log', 'a neutral private log'])
    assert.ok(!JSON.stringify(result).includes(privateText))
})

test('aggregate public excerpts are capped while full detail digests still bind omitted text', async t => {
  const f = fixture(t, { runs: Array.from({ length: 40 }, (_, i) => run(i + 1, 'failure', {
    output: { title: null, summary: 'x'.repeat(2500), text: null },
  })) })
  const result = await f.read()
  assert.equal(result.checks.reduce((sum, check) => sum + check.logExcerpt.length, 0), 64_000)
  assert.ok(result.checks.every(check => check.logExcerpt.length <= 2000 && check.logTruncated))
  const hidden = result.checks.find(check => check.logExcerpt.length === 0)!
  f.data.runs.find(item => String(item.id) === hidden.nativeId)!.output!.summary = 'x'.repeat(2499) + 'y'
  const changed = await f.read()
  assert.equal(changed.checks.find(check => check.nativeId === hidden.nativeId)!.logExcerpt, '')
  assert.notEqual(changed.checks.find(check => check.nativeId === hidden.nativeId)!.detailDigest, hidden.detailDigest)
  assert.notEqual(changed.fingerprint, result.fingerprint)
})

test('local observation time and provider array order do not change the checks fingerprint', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(stamp) })
  const f = fixture(t, { runs: [run(2, 'failure'), run(1)], statuses: [status(4), status(3, 'pending')] })
  const first = await f.read()
  t.mock.timers.tick(1000)
  f.data.runs.reverse(); f.data.statuses.reverse()
  const second = await f.read()
  assert.notEqual(first.observedAt, second.observedAt)
  assert.deepEqual(first.checks, second.checks)
  assert.equal(first.fingerprint, second.fingerprint)
})

test('native result identity, conclusion, timestamp and hidden detail changes invalidate the observation', async t => {
  for (const [name, mutate] of [
    ['run id', (data: Data) => { data.runs[0]!.id = 2 }],
    ['run conclusion', (data: Data) => { data.runs[0]!.conclusion = 'timed_out' }],
    ['completion time', (data: Data) => { data.runs[0]!.completed_at = '2026-11-08T12:01:00.000Z' }],
    ['hidden run detail', (data: Data) => { data.runs[0]!.output!.summary = 'x'.repeat(2000) + 'changed outside excerpt' }],
    ['status id', (data: Data) => { data.statuses[0]!.id = 2 }],
    ['status result', (data: Data) => { data.statuses[0]!.state = 'error' }],
    ['status timestamp', (data: Data) => { data.statuses[0]!.updated_at = '2026-11-08T12:01:00.000Z' }],
  ] as const) await t.test(name, async t => {
    const f = fixture(t, { runs: [run(1, 'failure', { output: { title: null, summary: 'x'.repeat(2000) + 'original hidden detail', text: null } })],
      statuses: [status(1)] })
    const first = await f.read(); mutate(f.data)
    assert.notEqual((await f.read()).fingerprint, first.fingerprint)
  })
})

test('a native queued-to-running change is a different observation even before the conclusion exists', async t => {
  const f = fixture(t, { runs: [run(1, null, { status: 'queued' })] })
  const first = await f.read()
  f.data.runs[0]!.status = 'in_progress'
  const second = await f.read()
  assert.equal(first.counts.pending, 1); assert.equal(second.counts.pending, 1)
  assert.notEqual(first.fingerprint, second.fingerprint)
})
