import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runtimeInputsDigest, releaseDecision, findFailedInputs, rememberFailure } from './runtime-inputs.mjs'

const digest = 'a'.repeat(64)
const sha = 'b'.repeat(40)
const options = { digest, token: 'test', currentRunId: 99 }
const artifact = { name: `e2b-runtime-inputs-${digest}`, expired: false, created_at: '2026-11-09T20:01:00Z',
  workflow_run: { id: 10, head_branch: 'main', head_sha: sha } }
const run = { id: 10, run_attempt: 2, head_sha: sha, head_branch: 'main', event: 'push',
  path: '.github/workflows/e2b-official-runtime.yml', status: 'completed', conclusion: 'failure',
  run_started_at: '2026-11-09T20:00:00Z', repository: { full_name: 'alexj11324/Mikka' }, head_repository: { full_name: 'alexj11324/Mikka' } }
const buildStep = 'Build private versioned candidates and require official file conservation'
const gateStep = 'Require real Claude Code and Codex subscriptions on the private candidates'
function api({ artifacts = [artifact], previousRun = run, steps = [{ name: buildStep, conclusion: 'failure' }], pages = 1 } = {}) {
  const calls = []
  return { calls, fetchImpl: async input => {
    const url = new URL(input); calls.push(url)
    if (url.pathname.endsWith('/actions/artifacts')) {
      assert.equal(url.searchParams.get('name'), artifact.name)
      return Response.json({ total_count: artifacts.length, artifacts })
    }
    if (url.pathname.endsWith('/actions/runs/10')) return Response.json(previousRun)
    const page = Number(url.searchParams.get('page'))
    assert.match(url.pathname, /\/actions\/runs\/10\/attempts\/2\/jobs$/)
    return Response.json({ total_count: pages === 1 ? 1 : 101, jobs: pages === 1 || page === 2
      ? [{ head_sha: sha, steps }] : Array.from({ length: 100 }, () => ({ head_sha: sha, steps: [] })) })
  } }
}

test('same inputs that failed skip; new runtime inputs build; matching worker skips; dispatch builds', () => {
  assert.deepEqual(releaseDecision({ wanted: sha, live: 'old', failedRunId: 10 }), { changed: false, reason: 'skipped: same inputs as failed run 10' })
  assert.equal(releaseDecision({ wanted: sha, live: 'old' }).changed, true)
  assert.equal(releaseDecision({ wanted: sha, live: sha }).changed, false)
  assert.equal(releaseDecision({ wanted: sha, live: 'old', refresh: true, failedRunId: 10 }).changed, false)
  assert.equal(releaseDecision({ wanted: sha, live: sha, eventName: 'workflow_dispatch', reason: 'service recovered', failedRunId: 10 }).changed, true)
  assert.throws(() => releaseDecision({ eventName: 'workflow_dispatch', reason: '  ' }), /retryReasonRequired/)
})

test('failed build and subscription gate are recognized from the exact latest run attempt', async () => {
  for (const name of [buildStep, gateStep]) {
    const mock = api({ steps: [{ name, conclusion: 'failure' }], pages: 2 })
    assert.equal(await findFailedInputs({ ...options, ...mock }), 10)
    assert.ok(mock.calls.some(url => url.searchParams.get('page') === '2'))
  }
})

test('supersession, Web/cleanup failures, cancelled runs, foreign workflows and old attempts do not suppress a build', async () => {
  for (const change of [{ conclusion: 'cancelled' }, { conclusion: 'success' }, { status: 'in_progress' },
    { head_branch: 'other' }, { event: 'pull_request' }, { path: '.github/workflows/other.yml' },
    { repository: { full_name: 'someone/else' } }, { head_repository: { full_name: 'someone/else' } },
    { run_started_at: '2026-11-09T20:02:00Z' }]) {
    assert.equal(await findFailedInputs({ ...options, ...api({ previousRun: { ...run, ...change } }) }), null)
  }
  for (const steps of [[{ name: 'Refuse an obsolete source before building candidates', conclusion: 'failure' }],
    [{ name: buildStep, conclusion: 'skipped' }], [{ name: 'Close leftover probes and failed private builds', conclusion: 'failure' }]]) {
    assert.equal(await findFailedInputs({ ...options, ...api({ steps }) }), null)
  }
  for (const change of [{ expired: true }, { name: `e2b-runtime-inputs-${'c'.repeat(64)}` }, { workflow_run: { ...artifact.workflow_run, id: 99 } }]) {
    assert.equal(await findFailedInputs({ ...options, ...api({ artifacts: [{ ...artifact, ...change }] }) }), null)
  }
})

test('history/API failures fail closed rather than silently rebuilding', async () => {
  await assert.rejects(findFailedInputs({ ...options, fetchImpl: async () => new Response('', { status: 403 }) }), /github:403/)
})

test('digest uses committed runtime_paths blobs, paths and modes, including lockfile and deletions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-inputs-'))
  const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
  const commit = () => { git(['add', '.']); git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture']); return git(['rev-parse', 'HEAD']) }
  try {
    git(['init', '-q']); mkdirSync(join(dir, '.github/workflows'), { recursive: true })
    const workflow = readFileSync(new URL('../../.github/workflows/e2b-official-runtime.yml', import.meta.url), 'utf8')
    writeFileSync(join(dir, '.github/workflows/e2b-official-runtime.yml'), workflow)
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lock-a')
    mkdirSync(join(dir, 'packages/daemon'), { recursive: true }); writeFileSync(join(dir, 'packages/daemon/install.sh'), 'install')
    mkdirSync(join(dir, 'app/api/runs/[runId]/evidence'), { recursive: true }); writeFileSync(join(dir, 'app/api/runs/[runId]/evidence/route.ts'), 'route')
    let head = commit(), previous = runtimeInputsDigest({ ref: head, cwd: dir })
    writeFileSync(join(dir, 'README.md'), 'docs'); head = commit()
    assert.equal(runtimeInputsDigest({ ref: head, cwd: dir }), previous)
    for (const path of ['pnpm-lock.yaml', 'packages/daemon/install.sh', 'app/api/runs/[runId]/evidence/route.ts']) {
      writeFileSync(join(dir, path), 'changed'); head = commit()
      const next = runtimeInputsDigest({ ref: head, cwd: dir }); assert.notEqual(next, previous); previous = next
    }
    git(['update-index', '--chmod=+x', 'packages/daemon/install.sh']); git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'mode'])
    const mode = runtimeInputsDigest({ ref: git(['rev-parse', 'HEAD']), cwd: dir }); assert.notEqual(mode, previous)
    rmSync(join(dir, 'pnpm-lock.yaml')); head = commit()
    assert.notEqual(runtimeInputsDigest({ ref: head, cwd: dir }), mode)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the workflow checks history before secrets and holds one queue across all release gates and cleanup', () => {
  const caller = readFileSync(new URL('../../.github/workflows/e2b-official-runtime.yml', import.meta.url), 'utf8')
  const child = readFileSync(new URL('../../.github/workflows/e2b-runtime-release.yml', import.meta.url), 'utf8')
  assert.doesNotMatch(caller, /^concurrency:/m)
  const check = caller.slice(caller.indexOf('\n  check:'), caller.indexOf('\n  release:'))
  assert.ok(check.indexOf('id: history') < check.indexOf('uses: Infisical/'))
  assert.match(check, /changed: \$\{\{ steps.compare.outputs.changed \|\| 'false' \}\}/)
  assert.match(check, /Compare the worker hash with production\n        if: steps.history.outputs.skip != 'true'/)
  assert.match(caller, /reason:\n        description: [^\n]+\n        type: string\n        required: true/)
  assert.match(caller, /release:\n    needs: \[test, check\]\n    if: needs.check.outputs.changed == 'true'\n    concurrency:\n      group: e2b-official-runtime-release\n      cancel-in-progress: false\n      queue: max/)
  assert.match(child, /validate:\n    needs: recheck\n    if: needs.recheck.outputs.skip != 'true'/)
  assert.match(child, /cleanup:\n    needs: \[recheck, validate, await-web, subscriptions, publish\]/)
  assert.match(child, /group: production-smoke-owner-acceptance\n      cancel-in-progress: false\n      queue: max/)
})


test('only a real failure still bound to current main is remembered; superseded releases remain retryable', async () => {
  for (const [current, steps, expected] of [[sha, [{ name: buildStep, conclusion: 'failure' }], true],
    ['c'.repeat(40), [{ name: gateStep, conclusion: 'failure' }], false],
    [sha, [{ name: 'Refuse an obsolete source before building candidates', conclusion: 'failure' }], false]]) {
    const mock = api({ steps })
    const fetchImpl = (url, init) => url.includes('/git/ref/heads/main')
      ? Promise.resolve(Response.json({ object: { type: 'commit', sha: current } })) : mock.fetchImpl(url, init)
    assert.equal(await rememberFailure({ sourceCommit: sha, runId: 10, runAttempt: 2, token: 'test', fetchImpl }), expected)
  }
})
