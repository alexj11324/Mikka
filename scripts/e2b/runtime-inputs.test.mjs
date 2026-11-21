import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runtimeInputsDigest, pushRuntimeInputs, releaseDecision, findFailedInputs, rememberFailure, lastPublishedSource } from './runtime-inputs.mjs'

const digest = 'a'.repeat(40)
const sha = 'b'.repeat(40)
const repository = { full_name: 'alexj11324/Mikka', id: 1427517699, owner: { id: 183887963 } }
const transferredRepository = { ...repository, full_name: 'aspectly-labs/Mikka', owner: { id: 359279274 } }
const options = { digest, token: 'test', currentRunId: 99 }
const artifact = { name: `e2b-runtime-inputs-${digest}`, expired: false, created_at: '2026-11-09T20:01:00Z',
  workflow_run: { id: 10, repository_id: 1427517699, head_repository_id: 1427517699, head_branch: 'main', head_sha: sha } }
const run = { id: 10, run_attempt: 2, head_sha: sha, head_branch: 'main', event: 'push',
  path: '.github/workflows/e2b-official-runtime.yml', status: 'completed', conclusion: 'failure',
  run_started_at: '2026-11-09T20:00:00Z', repository, head_repository: repository }
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

test('only actual push input changes build, even when production is stale; manual retry remains explicit', () => {
  const push = { eventName: 'push', workerHash: sha, beforeWorkerHash: 'c'.repeat(40), live: 'stale-production' }
  assert.equal(releaseDecision(push).changed, true)
  assert.equal(releaseDecision({ ...push, beforeWorkerHash: sha }).changed, false)
  assert.deepEqual(releaseDecision({ ...push, failedRunId: 10 }), { changed: false, reason: 'skipped: same inputs as failed run 10' })
  assert.equal(releaseDecision({ eventName: 'workflow_dispatch', reason: 'service recovered', failedRunId: 10 }).changed, true)
  assert.throws(() => releaseDecision({ eventName: 'workflow_dispatch', reason: '  ' }), /retryReasonRequired/)
  assert.throws(() => releaseDecision({ ...push, beforeWorkerHash: undefined }), /workerHashRequired/)
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
  for (const change of [{ expired: true }, { name: `e2b-runtime-inputs-${'c'.repeat(40)}` }, { workflow_run: { ...artifact.workflow_run, id: 99 } }]) {
    assert.equal(await findFailedInputs({ ...options, ...api({ artifacts: [{ ...artifact, ...change }] }) }), null)
  }
})

test('history/API failures fail closed rather than silently rebuilding', async () => {
  await assert.rejects(findFailedInputs({ ...options, fetchImpl: async () => new Response('', { status: 403 }) }), /github:403/)
})

function runtimeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-inputs-'))
  const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const write = (path, value) => { mkdirSync(join(dir, path, '..'), { recursive: true }); writeFileSync(join(dir, path), value) }
  const commit = () => { git(['add', '.']); git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture']); return git(['rev-parse', 'HEAD']) }
  git(['init', '-q'])
  write('scripts/e2b/build-template.py', readFileSync(new URL('./build-template.py', import.meta.url)))
  write('scripts/e2b/official-files.py', '# recipe one')
  write('packages/daemon/worker.ts', 'worker one')
  write('package.json', JSON.stringify({ packageManager: 'pnpm@10.34.3', scripts: { build: 'one' }, dependencies: { eve: '1.0.0' } }))
  write('packages/daemon/package.json', JSON.stringify({ name: '@mikka/daemon', dependencies: { runtime: '1.0.0' } }))
  write('pnpm-lock.yaml', `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      eve:
        specifier: 1.0.0
        version: 1.0.0
  packages/daemon:
    dependencies:
      runtime:
        specifier: 1.0.0
        version: 1.0.0
packages:
  eve@1.0.0:
    resolution: {integrity: web}
  runtime@1.0.0:
    resolution: {integrity: runtime}
  shared@1.0.0:
    resolution: {integrity: transitive-runtime}
snapshots:
  eve@1.0.0: {}
  runtime@1.0.0:
    dependencies:
      shared: 1.0.0
  shared@1.0.0: {}
`)
  return { dir, git, write, commit, dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

test('canonical worker input ignores Eve-only package/lock, Web/helper, migration, docs and Agent edits', () => {
  const fixture = runtimeRepo(), { dir, write, commit } = fixture
  try {
    const before = commit(), original = runtimeInputsDigest({ ref: before, cwd: dir })
    const root = JSON.parse(readFileSync(join(dir, 'package.json'))); root.dependencies.eve = '2.0.0'; root.scripts.build = 'two'
    write('package.json', JSON.stringify(root))
    write('pnpm-lock.yaml', readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8').replaceAll('eve@1.0.0', 'eve@2.0.0').replace('specifier: 1.0.0\n        version: 1.0.0', 'specifier: 2.0.0\n        version: 2.0.0'))
    let after = commit()
    assert.equal(runtimeInputsDigest({ ref: after, cwd: dir }), original)
    for (const path of ['.github/workflows/web-deploy.yml', 'scripts/release/build-vercel.mjs', 'scripts/acceptance/cloud-startup.mjs',
      'scripts/acceptance/model-provider-fallback.mjs', 'lib/agents/new-agent.ts', 'apps/eve/eve.config.ts', 'migrations/next.sql', 'docs/change.md']) {
      write(path, 'unrelated app change'); after = commit()
      const inputs = pushRuntimeInputs({ ref: after, event: { before, after, ref: 'refs/heads/main' }, cwd: dir })
      assert.equal(releaseDecision({ ...inputs, eventName: 'push', live: 'stale-production', refresh: true }).changed, false, path)
    }
    const output = join(dir, '.git/output'), event = join(dir, '.git/push.json')
    writeFileSync(event, JSON.stringify({ before, after, ref: 'refs/heads/main' }))
    const processResult = spawnSync(process.execPath, [new URL('./runtime-inputs.mjs', import.meta.url).pathname], {
      cwd: dir, env: { PATH: process.env.PATH, GITHUB_SHA: after, GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: event,
        GITHUB_OUTPUT: output, RUNTIME_REFRESH: 'true' }, encoding: 'utf8' })
    assert.equal(processResult.status, 0, processResult.stderr)
    assert.match(readFileSync(output, 'utf8'), /changed=false\nskip=true/)
    // No GITHUB_TOKEN or production credential exists: an unnecessary history or
    // live-worker request would fail this actual CLI invocation.
  } finally { fixture.dispose() }
})

test('canonical worker, recipe and transitive installed dependency changes trigger across the entire push', () => {
  const fixture = runtimeRepo(), { dir, write, commit } = fixture
  try {
    let before = commit(), changeNumber = 0
    for (const change of [() => write('packages/daemon/worker.ts', 'worker two'), () => write('scripts/e2b/official-files.py', '# recipe two'),
      () => write('pnpm-lock.yaml', readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8').replace('integrity: transitive-runtime', 'integrity: changed-runtime'))]) {
      change(); commit(); write('docs/change.md', String(++changeNumber)); const after = commit()
      const inputs = pushRuntimeInputs({ ref: after, event: { before, after, ref: 'refs/heads/main' }, cwd: dir })
      assert.notEqual(inputs.workerHash, inputs.beforeWorkerHash)
      assert.equal(releaseDecision({ ...inputs, eventName: 'push' }).changed, true)
      before = after
    }
    assert.throws(() => pushRuntimeInputs({ ref: before, event: { before: 'f'.repeat(40), after: before, ref: 'refs/heads/main' }, cwd: dir }))
  } finally { fixture.dispose() }
})

test('invalid push endpoints fail before hashing, without assuming missing history is unchanged', () => {
  const value = { before: 'c'.repeat(40), after: sha, ref: 'refs/heads/main' }
  for (const event of [{ ...value, before: undefined }, { ...value, before: '0'.repeat(40) }, { ...value, after: 'd'.repeat(40) }, { ...value, ref: 'refs/heads/other' }])
    assert.throws(() => pushRuntimeInputs({ ref: sha, event }, () => assert.fail('must validate before hashing')), /invalidPushSource/)
})

test('the workflow checks history before secrets and holds one queue across all release gates and cleanup', () => {
  const caller = readFileSync(new URL('../../.github/workflows/e2b-official-runtime.yml', import.meta.url), 'utf8')
  const child = readFileSync(new URL('../../.github/workflows/e2b-runtime-release.yml', import.meta.url), 'utf8')
  assert.doesNotMatch(caller, /^concurrency:/m)
  const check = caller.slice(caller.indexOf('\n  check:'), caller.indexOf('\n  release:'))
  assert.doesNotMatch(check, /Infisical|VERCEL_TEAM_TOKEN|publish-template-env|runtime-refresh/)
  assert.match(check, /changed: \$\{\{ steps.history.outputs.changed \|\| 'false' \}\}/)
  assert.match(child, /run: node scripts\/e2b\/runtime-inputs.mjs recheck/)
  assert.match(caller, /reason:\n        description: [^\n]+\n        type: string\n        required: true/)
  assert.match(caller, /release:\n    needs: \[test, check, web-ready\]\n    if: needs.check.outputs.changed == 'true' && github.event_name != 'push'\n    concurrency:\n      group: e2b-official-runtime-release\n      cancel-in-progress: false\n      queue: max/)
  assert.match(child, /validate:\n    needs: recheck\n    if: needs.recheck.outputs.skip != 'true'/)
  assert.match(child, /cleanup:\n    needs: \[recheck, validate, await-web, templates\]/)
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


test('manual dispatch needs no history API and records its reason as escaped text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-dispatch-'))
  try {
    const script = new URL('./runtime-inputs.mjs', import.meta.url).pathname
    const output = join(dir, 'output'), summary = join(dir, 'summary')
    const env = { PATH: process.env.PATH, GITHUB_SHA: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary,
      RETRY_REASON: 'service recovered <script> & $(false)' }
    const result = spawnSync(process.execPath, [script], { env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.match(readFileSync(output, 'utf8'), /skip=false/)
    assert.match(readFileSync(summary, 'utf8'), /service recovered &lt;script&gt; &amp; \$\(false\)/)
    assert.doesNotMatch(readFileSync(summary, 'utf8'), /<script>/)
    const invalid = spawnSync(process.execPath, [script], { env: { ...env, RETRY_REASON: '  ' }, encoding: 'utf8' })
    assert.notEqual(invalid.status, 0)
    assert.match(invalid.stderr, /retryReasonRequired/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})


test('the queue recheck recognizes a just-recorded failure before the overall run finishes', async () => {
  assert.equal(await findFailedInputs({ ...options, ...api({ previousRun: { ...run, status: 'in_progress', conclusion: null } }) }), 10)
})

test('a Cloudflare promotion compares against the last published release, not the previous push', () => {
  const promotion = { eventName: 'workflow_run', workerHash: sha, beforeWorkerHash: 'c'.repeat(40) }
  assert.deepEqual(releaseDecision(promotion), { changed: true, reason: 'installed worker or template inputs changed since the last published release' })
  assert.equal(releaseDecision({ ...promotion, beforeWorkerHash: sha }).changed, false)
  assert.deepEqual(releaseDecision({ ...promotion, beforeWorkerHash: null }), { changed: true, reason: 'no published release found' })
  assert.deepEqual(releaseDecision({ ...promotion, failedRunId: 10 }), { changed: false, reason: 'skipped: same inputs as failed run 10' })
  assert.throws(() => releaseDecision({ ...promotion, workerHash: undefined }), /workerHashRequired/)
})

function publicationHistory({ name = 'release / templates', sourceCommit = 'd'.repeat(40),
  workflowHead = 'e'.repeat(40), workerSha = 'c'.repeat(40), mutateReport = () => {}, recordedRepository = repository } = {}) {
  const started = new Date(Date.now() - 60_000).toISOString()
  const releaseRun = (id, headSha, extra = {}) => ({ id, run_attempt: 2, head_sha: headSha, head_branch: 'main',
    event: 'workflow_run', status: 'completed', conclusion: 'success', run_started_at: started,
    path: '.github/workflows/e2b-official-runtime.yml', repository: recordedRepository, head_repository: recordedRepository, ...extra })
  const publishedRun = releaseRun(27, workflowHead, { event: 'workflow_dispatch' })
  const runs = [releaseRun(30, 'a'.repeat(40), { event: 'push' }), releaseRun(29, 'f'.repeat(40)),
    releaseRun(28, 'b'.repeat(40), { path: '.github/workflows/other.yml' }), publishedRun]
  const publication = { id: 100, name, run_id: 27, run_attempt: 2, head_sha: workflowHead,
    status: 'completed', conclusion: 'success',
    steps: [{ name: 'Make only fully accepted candidates public', conclusion: 'success' }] }
  const report = { sourceCommit, workerSha, templates: Object.fromEntries(['desktop', 'claude', 'codex'].map(kind => [kind, {
    name: 'mikka-' + sourceCommit.slice(0, 12) + '-27-2-' + kind, baseTemplate: kind,
    templateId: 'template-' + kind, buildId: 'build-' + kind, preinstalled: true, public: true, buildStatus: 'ready',
  }])) }
  mutateReport(report)
  const archive = execFileSync('python3', ['-c', 'import io,sys,zipfile\nb=io.BytesIO()\nwith zipfile.ZipFile(b,"w",zipfile.ZIP_DEFLATED) as z: z.writestr("release.json",sys.stdin.buffer.read())\nsys.stdout.buffer.write(b.getvalue())\n'],
    { input: JSON.stringify(report), stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 })
  const root = 'https://api.github.com/repos/' + recordedRepository.full_name
  const artifact = { id: 321, name: 'e2b-release-evidence-27-2', expired: false, size_in_bytes: archive.length,
    created_at: new Date(Date.now() - 30_000).toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString(),
    digest: 'sha256:' + createHash('sha256').update(archive).digest('hex'),
    url: root + '/actions/artifacts/321', archive_download_url: root + '/actions/artifacts/321/zip',
    workflow_run: { id: 27, repository_id: recordedRepository.id, head_repository_id: recordedRepository.id,
      head_branch: 'main', head_sha: workflowHead } }
  const state = { runs, publication, artifacts: [artifact], detail: structuredClone(artifact),
    latest: structuredClone(publishedRun), archive, calls: [] }
  state.fetchImpl = async (input, init) => {
    const url = new URL(input); state.calls.push(url.pathname)
    if (url.origin === 'https://productionresultssa1.blob.core.windows.net') {
      assert.equal(init.headers, undefined, 'GitHub credentials never reach archive storage')
      return new Response(state.archive)
    }
    assert.equal(url.origin, 'https://api.github.com')
    assert.ok(url.pathname.startsWith('/repositories/1427517699/'), 'all authenticated reads use the fixed repository ID')
    assert.equal(init.headers.authorization, 'Bearer test')
    if (url.pathname.endsWith('/actions/workflows/e2b-official-runtime.yml/runs')) {
      assert.equal(url.searchParams.get('branch'), 'main')
      assert.equal(url.searchParams.get('status'), 'success')
      return Response.json({ total_count: state.runs.length, workflow_runs: state.runs })
    }
    if (url.pathname.endsWith('/actions/runs/29/attempts/2/jobs'))
      return Response.json({ total_count: 1, jobs: [{ name: 'check', head_sha: 'f'.repeat(40), steps: [] }] })
    if (url.pathname.endsWith('/actions/runs/27/attempts/2/jobs'))
      return Response.json({ total_count: 1, jobs: [state.publication] })
    if (url.pathname.endsWith('/actions/runs/27/artifacts'))
      return Response.json({ total_count: state.artifacts.length, artifacts: state.artifacts })
    if (url.pathname.endsWith('/actions/artifacts/321/zip')) {
      assert.equal(url.pathname, '/repositories/1427517699/actions/artifacts/321/zip')
      assert.equal(init.redirect, 'manual')
      return new Response(null, { status: 302, headers: { location: 'https://productionresultssa1.blob.core.windows.net/runtime-fixture.zip' } })
    }
    if (url.pathname.endsWith('/actions/artifacts/321')) return Response.json(state.detail)
    if (url.pathname.endsWith('/actions/runs/27')) return Response.json(state.latest)
    assert.fail('Unexpected offline history request: ' + url.pathname)
  }
  return state
}

test('the newest actual publication uses its report source, including current and historical job names', async () => {
  for (const name of ['release / templates', 'templates', 'release / subscriptions', 'subscriptions']) {
    const mock = publicationHistory({ name })
    assert.equal(await lastPublishedSource({ token: 'test', fetchImpl: mock.fetchImpl }), 'd'.repeat(40))
    assert.ok(!mock.calls.some(path => /\/runs\/(30|28)\//.test(path)), 'a push or foreign run is never a publication')
    mock.publication.steps[0].conclusion = 'skipped'
    assert.equal(await lastPublishedSource({ token: 'test', fetchImpl: mock.fetchImpl }), null)
    assert.equal(await lastPublishedSource({ token: 'test', fetchImpl: mock.fetchImpl, maxRuns: 1 }), null)
  }
})

test('publication reuse compares the actual published worker rather than a later dispatch head', async () => {
  const fixture = runtimeRepo(), { dir, write, commit } = fixture
  try {
    const published = commit(), publishedWorker = runtimeInputsDigest({ ref: published, cwd: dir })
    write('docs/change.md', 'no worker change')
    const documentationHead = commit()
    let mock = publicationHistory({ sourceCommit: published, workflowHead: documentationHead, workerSha: publishedWorker })
    const selected = await lastPublishedSource({ token: 'test', fetchImpl: mock.fetchImpl })
    assert.equal(selected, published)
    const beforeWorkerHash = runtimeInputsDigest({ ref: selected, cwd: dir })
    assert.equal(releaseDecision({ eventName: 'workflow_run', beforeWorkerHash,
      workerHash: runtimeInputsDigest({ ref: documentationHead, cwd: dir }) }).changed, false)
    write('packages/daemon/worker.ts', 'new worker still needs a release')
    const changedHead = commit()
    mock = publicationHistory({ sourceCommit: published, workflowHead: changedHead, workerSha: publishedWorker })
    assert.equal(await lastPublishedSource({ token: 'test', fetchImpl: mock.fetchImpl }), published)
    assert.equal(releaseDecision({ eventName: 'workflow_run', beforeWorkerHash,
      workerHash: runtimeInputsDigest({ ref: changedHead, cwd: dir }) }).changed, true)
  } finally { fixture.dispose() }
})

test('foreign, unfinished and wrong-attempt publication metadata never select a release artifact', async () => {
  const changes = [
    mock => { mock.runs[3].path = '.github/workflows/other.yml' },
    mock => { mock.runs[3].head_repository = { full_name: 'fork/Mikka' } },
    mock => { mock.runs[3].status = 'in_progress' },
    mock => { mock.runs[3].conclusion = 'failure' },
    mock => { mock.runs[3].event = 'pull_request' },
    mock => { mock.runs[3].head_branch = 'feature' },
    mock => { mock.runs[3].head_sha = 'main' },
    mock => { mock.publication.name = 'unrelated / templates' },
    mock => { mock.publication.run_id = 28 },
    mock => { mock.publication.run_attempt = 1 },
    mock => { mock.publication.head_sha = 'f'.repeat(40) },
    mock => { mock.publication.conclusion = 'failure' },
  ]
  for (const change of changes) {
    const mock = publicationHistory(); change(mock)
    assert.equal(await lastPublishedSource({ token: 'test', fetchImpl: mock.fetchImpl }), null)
    assert.ok(!mock.calls.some(path => path.includes('/artifacts')), 'invalid publication metadata must not read a report')
  }
})

test('missing, stale, foreign or corrupt publication evidence fails closed before reuse', async () => {
  for (const change of [
    mock => { mock.artifacts = [] },
    mock => { mock.artifacts.push(structuredClone(mock.artifacts[0])) },
    mock => { mock.artifacts[0].name = 'e2b-release-evidence-27-1' },
    mock => { mock.artifacts[0].expired = true },
    mock => { mock.artifacts[0].workflow_run.head_repository_id++ },
    mock => { mock.artifacts[0].workflow_run.head_sha = 'f'.repeat(40) },
    mock => { mock.detail.digest = 'sha256:' + '0'.repeat(64) },
    mock => { mock.archive = Buffer.from(mock.archive); mock.archive[0] ^= 1 },
    mock => { mock.latest.run_attempt = 3 },
    mock => { mock.latest.head_sha = 'f'.repeat(40) },
  ]) {
    const mock = publicationHistory(); change(mock)
    await assert.rejects(lastPublishedSource({ token: 'test', fetchImpl: mock.fetchImpl }))
  }
  for (const mutateReport of [
    report => { report.sourceCommit = 'f'.repeat(40) },
    report => { report.workerSha = 'main' },
    report => { report.templates.codex.name = report.templates.codex.name.replace('-27-2-', '-27-1-') },
    report => { report.templates.codex.public = false },
    report => { report.templates.codex.buildStatus = 'building' },
  ]) {
    const mock = publicationHistory({ mutateReport })
    await assert.rejects(lastPublishedSource({ token: 'test', fetchImpl: mock.fetchImpl }))
  }
  await assert.rejects(lastPublishedSource({ token: 'test', fetchImpl: async () => new Response('', { status: 403 }) }), /github:403/)
})


test('historical old and transferred failures are recognized through the immutable repository endpoint', async () => {
  for (const recorded of [repository, transferredRepository]) {
    const previousRun = { ...run, repository: recorded, head_repository: recorded }
    const mock = api({ previousRun })
    assert.equal(await findFailedInputs({ ...options, ...mock }), 10)
    assert.ok(mock.calls.every(url => url.pathname.startsWith('/repositories/1427517699/')))
    assert.equal(previousRun.repository.full_name, recorded.owner.id === 183887963 ? 'alexj11324/Mikka' : 'aspectly-labs/Mikka')
  }
})

test('mixed and foreign historical identities cannot suppress a runtime retry', async () => {
  for (const recorded of [
    { ...repository, id: 1 }, { ...repository, full_name: 'foreign/Mikka' },
    { ...repository, owner: { id: 359279274 } },
    { ...repository, full_name: transferredRepository.full_name },
  ]) {
    for (const field of ['repository', 'head_repository'])
      assert.equal(await findFailedInputs({ ...options, ...api({ previousRun: { ...run, [field]: recorded } }) }), null)
  }
})

test('published source accepts official historical names and rejects incoherent repository claims', async () => {
  for (const [recorded, expected] of [[repository, sha], [transferredRepository, sha],
    [{ full_name: repository.full_name, id: repository.id }, sha],
    [{ ...repository, id: 1 }, null], [{ ...repository, owner: { id: 359279274 } }, null],
    [{ ...repository, full_name: 'foreign/Mikka' }, null]]) {
    const mock = publicationHistory({ sourceCommit: sha, workflowHead: sha, recordedRepository: recorded })
    assert.equal(await lastPublishedSource({ token: 'test', fetchImpl: mock.fetchImpl }), expected)
    assert.ok(mock.calls.filter(path => !path.endsWith('/runtime-fixture.zip'))
      .every(path => path.startsWith('/repositories/1427517699/')))
  }
})
