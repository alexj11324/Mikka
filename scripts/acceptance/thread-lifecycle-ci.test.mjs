import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { assertAttestation, assertReleaseIdentity, completeEvidence, expectedRelease, lifecycleChanged,
  providerReceipt, REPOSITORY, RELEASE_NAME, RELEASE_WORKFLOW, selectRelease, verifyRelease } from './thread-lifecycle-ci.mjs'

const SHA = 'a'.repeat(40), OTHER = 'b'.repeat(40)
const workflow = { id: 405833668, name: RELEASE_NAME, path: RELEASE_WORKFLOW, state: 'active' }
const run = { id: 123, run_attempt: 2, workflow_id: workflow.id, name: RELEASE_NAME, path: RELEASE_WORKFLOW,
  head_sha: SHA, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success',
  repository: { id: 1427517699, full_name: REPOSITORY, owner: { id: 183887963 } },
  head_repository: { id: 1427517699, full_name: REPOSITORY, owner: { id: 183887963 } } }
const event = () => ({ workflow_run: structuredClone(run) })
const env = () => ({ GITHUB_EVENT_NAME: 'workflow_run', GITHUB_REPOSITORY: REPOSITORY,
  GITHUB_REPOSITORY_ID: '1427517699', GITHUB_REPOSITORY_OWNER_ID: '183887963', GITHUB_REF: 'refs/heads/main',
  EXPECTED_SOURCE_SHA: SHA, EXPECTED_UPSTREAM_RUN_ID: String(run.id), EXPECTED_UPSTREAM_RUN_ATTEMPT: String(run.run_attempt),
  GITHUB_TOKEN: 'private-credential-sentinel' })
const expected = () => expectedRelease(env(), event())

test('the shared release guard admits the transferred official repository with coherent immutable identity', () => {
  const repository = { id: 1427517699, full_name: 'aspectly-labs/Mikka', owner: { id: 359279274, login: 'aspectly-labs' } }
  const current = { ...structuredClone(run), event: 'workflow_run', repository, head_repository: structuredClone(repository) }
  const context = { ...env(), GITHUB_REPOSITORY: repository.full_name, GITHUB_REPOSITORY_ID: String(repository.id),
    GITHUB_REPOSITORY_OWNER_ID: String(repository.owner.id) }
  const source = expectedRelease(context, { workflow_run: current })
  assert.equal(source.sourceCommit, SHA)
  assert.doesNotThrow(() => assertReleaseIdentity(source, workflow, current))
  for (const key of ['repositoryFullName', 'repositoryId', 'repositoryOwnerId']) {
    const missing = { ...source }; delete missing[key]
    assert.throws(() => assertReleaseIdentity(missing, workflow, current), /thread_lifecycle_ci:upstream/)
  }
  for (const mutate of [value => { value.repository.id++ }, value => { value.head_repository.id++ },
    value => { value.repository.owner.id = 183887963 }, value => { value.head_repository.full_name = 'alexj11324/Mikka' },
    value => { value.head_repository = { id: 1427517699, full_name: 'alexj11324/Mikka', owner: { id: 183887963 } } }]) {
    const bad = structuredClone(current); mutate(bad)
    assert.throws(() => expectedRelease(context, { workflow_run: bad }), /thread_lifecycle_ci:trigger/)
    assert.throws(() => assertReleaseIdentity(source, workflow, bad), /thread_lifecycle_ci:upstream/)
  }
})

function jobs(validated = true) {
  const names = ['test', 'check', validated ? 'validate / build' : 'validate', 'await-web', 'subscriptions',
    validated ? 'publish / deploy' : 'publish', 'cleanup']
  return { total_count: names.length, jobs: names.map((name, index) => ({ id: index + 1, name,
    run_id: run.id, run_attempt: run.run_attempt, head_sha: SHA, status: 'completed',
    conclusion: validated || index < 2 ? 'success' : 'skipped' })) }
}
function buildTimeJobs() {
  // Official run 44140435060/1: #2789 retained the build, publication and
  // cleanup jobs, and retired the separate subscription/deploy jobs.
  const names = ['test', 'check', 'web-ready', 'release / recheck', 'release / validate / build',
    'release / await-web', 'release / templates', 'release / cleanup', 'release / remember-failure']
  return { total_count: names.length, jobs: names.map((name, index) => ({ id: index + 1, name,
    run_id: run.id, run_attempt: run.run_attempt, head_sha: SHA, status: 'completed',
    conclusion: name === 'release / remember-failure' ? 'skipped' : 'success',
    ...(name === 'release / templates' ? { steps: [
      { number: 11, name: 'Make only fully accepted candidates public', status: 'completed', conclusion: 'success' },
      { number: 12, name: 'Preserve the complete public release report', status: 'completed', conclusion: 'success' },
    ] } : {}) })) }
}
const relevant = ['scripts/acceptance/thread-lifecycle.mjs']
const workflowText = readFileSync(new URL('../../.github/workflows/thread-lifecycle-acceptance.yml', import.meta.url), 'utf8')

test('the three native job predicates retain coherent official owner identities', () => {
  for (const name of ['thread-lifecycle', 'coding-workspace', 'task-secret']) {
    const text = readFileSync(new URL(`../../.github/workflows/${name}-acceptance.yml`, import.meta.url), 'utf8')
    const expression = text.split('  authorize:\n')[1].split('    if: >-\n')[1].split('    runs-on:')[0].trim()
    for (const [repository, ownerId] of [['alexj11324/Mikka', '183887963'], ['aspectly-labs/Mikka', '359279274']]) {
      const github = { repository, repository_id: '1427517699', repository_owner_id: ownerId, ref: 'refs/heads/main',
        event_name: 'workflow_run', event: { workflow_run: { conclusion: 'success', head_branch: 'main' } } }
      assert.equal(runInNewContext(expression, { github }), true, name)
      for (const patch of [{ repository_id: '999' }, { repository_owner_id: '999' },
        { repository: repository === 'alexj11324/Mikka' ? 'aspectly-labs/Mikka' : 'alexj11324/Mikka' },
        { ref: 'refs/heads/other' }, { repository: 'foreign/Mikka' }])
        assert.equal(runInNewContext(expression, { github: { ...github, ...patch } }), false, name)
    }
  }
})

function metadataScript() {
  const lines = workflowText.split('\n'), start = lines.findIndex(line => line.trim() === "node --input-type=module <<'JS'")
  const end = lines.findIndex((line, index) => index > start && line.trim() === 'JS')
  assert.ok(start >= 0 && end > start, 'exercise the actual pre-checkout script')
  const indent = lines[start].match(/^ */)[0].length
  return lines.slice(start + 1, end).map(line => line.slice(indent)).join('\n')
}

function executeMetadata(t, mutate = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), 'mikka-lifecycle-ci-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const fixture = { event: event(), workflow: structuredClone(workflow), run: structuredClone(run),
    main: { object: { type: 'commit', sha: SHA } }, environment: env(), httpStatus: 200 }
  mutate(fixture)
  const fixturePath = join(directory, 'fixture.json'), eventPath = join(directory, 'event.json'), output = join(directory, 'output')
  writeFileSync(fixturePath, JSON.stringify(fixture)); writeFileSync(eventPath, JSON.stringify(fixture.event)); writeFileSync(output, '')
  const setup = `
    import { readFileSync as readFixtureFile } from 'node:fs'
    const fixtureData = JSON.parse(readFixtureFile(process.env.FIXTURE_PATH, 'utf8'))
    globalThis.fetch = async (url, options) => {
      if (!url.startsWith('https://api.github.com/repositories/1427517699/') || options.redirect !== 'error'
        || options.headers.authorization !== 'Bearer private-credential-sentinel') throw Error('unexpected_private_request')
      const routes = {
        '/actions/workflows/e2b-official-runtime.yml': fixtureData.workflow,
        ['/actions/runs/' + fixtureData.event.workflow_run.id]: fixtureData.run,
        '/git/ref/heads/main': fixtureData.main,
      }
      const route = url.slice('https://api.github.com/repositories/1427517699'.length)
      if (!Object.hasOwn(routes, route)) throw Error('unexpected_private_request')
      return Response.json(routes[route], { status: fixtureData.httpStatus })
    }
  `
  const result = spawnSync(process.execPath, ['--input-type=module'], {
    input: setup + metadataScript(), encoding: 'utf8',
    env: { PATH: process.env.PATH, ...fixture.environment, FIXTURE_PATH: fixturePath,
      GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: output },
  })
  return { ...result, output: readFileSync(output, 'utf8') }
}

test('the actual metadata script permits only an API-confirmed immutable main release', t => {
  const result = executeMetadata(t)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.output, `source-sha=${SHA}\nupstream-run-id=123\nupstream-run-attempt=2\n`)
  const manual = executeMetadata(t, fixture => { fixture.event.workflow_run.event = 'workflow_dispatch'; fixture.run.event = 'workflow_dispatch' })
  assert.equal(manual.status, 0, manual.stderr)
})
test('Cloudflare-triggered runtime metadata retains all pre-checkout identity checks', t => {
  const automatic = mutate => executeMetadata(t, fixture => {
    fixture.event.workflow_run.event = 'workflow_run'; fixture.run.event = 'workflow_run'
    fixture.environment.GITHUB_REPOSITORY = 'aspectly-labs/Mikka'; fixture.environment.GITHUB_REPOSITORY_OWNER_ID = '359279274'
    for (const value of [fixture.event.workflow_run, fixture.run]) for (const key of ['repository', 'head_repository'])
      value[key] = { id: 1427517699, full_name: 'aspectly-labs/Mikka', owner: { id: 359279274 } }
    mutate?.(fixture)
  })
  const result = automatic()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.output, `source-sha=${SHA}\nupstream-run-id=123\nupstream-run-attempt=2\n`)
  for (const mutate of [fixture => { fixture.event.workflow_run.head_repository.full_name = 'fork/Mikka' },
    fixture => { fixture.workflow.path = '.github/workflows/other.yml' }, fixture => { fixture.run.event = 'push' },
    fixture => { fixture.run.run_attempt++ }, fixture => { fixture.main.object.sha = OTHER },
    fixture => { fixture.environment.GITHUB_REPOSITORY_ID = '999' },
    fixture => { fixture.environment.GITHUB_REPOSITORY_OWNER_ID = '183887963' },
    fixture => { delete fixture.environment.GITHUB_REPOSITORY_OWNER_ID },
    fixture => { fixture.event.workflow_run.repository.id++ },
    fixture => { fixture.event.workflow_run.head_repository.owner.id = 183887963 },
    fixture => { fixture.run.repository.owner.id = 183887963 }, fixture => { fixture.run.head_repository.id++ }]) {
    const refused = automatic(mutate)
    assert.equal(refused.status, 1); assert.equal(refused.output, '')
    assert.equal(refused.stderr.trim(), 'thread_lifecycle_source_refused')
  }
})

const metadataRefusals = {
  'fork receiver': fixture => { fixture.environment.GITHUB_REPOSITORY = 'fork/Mikka' },
  'non-main receiver': fixture => { fixture.environment.GITHUB_REF = 'refs/heads/branch' },
  'wrong trigger': fixture => { fixture.environment.GITHUB_EVENT_NAME = 'pull_request_target' },
  'PR pointer': fixture => { fixture.event.workflow_run.event = 'pull_request' },
  'fork pointer': fixture => { fixture.event.workflow_run.head_repository.full_name = 'fork/Mikka' },
  'wrong pointer repository': fixture => { fixture.event.workflow_run.repository.full_name = 'fork/Mikka' },
  'branch pointer': fixture => { fixture.event.workflow_run.head_branch = 'other' },
  'invalid SHA': fixture => { fixture.event.workflow_run.head_sha = 'main\nsecret' },
  'invalid run ID': fixture => { fixture.event.workflow_run.id = '../artifacts' },
  'pending pointer': fixture => { fixture.event.workflow_run.status = 'in_progress' },
  'failed pointer': fixture => { fixture.event.workflow_run.conclusion = 'failure' },
  'different workflow ID': fixture => { fixture.workflow.id++ },
  'different workflow path': fixture => { fixture.workflow.path = '.github/workflows/other.yml' },
  'disabled workflow': fixture => { fixture.workflow.state = 'disabled_manually' },
  'different API workflow path': fixture => { fixture.run.path = '.github/workflows/other.yml' },
  'different API event': fixture => { fixture.run.event = 'pull_request' },
  'fork API source': fixture => { fixture.run.head_repository.full_name = 'fork/Mikka' },
  'different API repository': fixture => { fixture.run.repository.full_name = 'fork/Mikka' },
  'different API source': fixture => { fixture.run.head_sha = OTHER },
  'different API attempt': fixture => { fixture.run.run_attempt++ },
  'unfinished API run': fixture => { fixture.run.status = 'in_progress' },
  'failed API run': fixture => { fixture.run.conclusion = 'failure' },
  'advanced main': fixture => { fixture.main.object.sha = OTHER },
  'non-commit main': fixture => { fixture.main.object.type = 'tag' },
  'GitHub refusal': fixture => { fixture.httpStatus = 403 },
}
for (const [name, mutate] of Object.entries(metadataRefusals)) test('pre-checkout refuses ' + name + ' without outputs or private data', t => {
  const result = executeMetadata(t, mutate)
  assert.equal(result.status, 1)
  assert.equal(result.output, '')
  assert.equal(result.stderr.trim(), 'thread_lifecycle_source_refused')
  assert.ok(!result.stdout.includes('private-credential-sentinel'))
})

test('the helper binds the checkout output to the trigger and repeats the fixed workflow identity', () => {
  assert.doesNotThrow(() => assertReleaseIdentity(expected(), workflow, run))
  for (const overrides of [{ EXPECTED_SOURCE_SHA: OTHER }, { EXPECTED_UPSTREAM_RUN_ATTEMPT: '3' },
    { EXPECTED_UPSTREAM_RUN_ID: '124' }, { GITHUB_REF: 'refs/heads/other' }])
    assert.throws(() => expectedRelease({ ...env(), ...overrides }, event()), /thread_lifecycle_ci:/)
  for (const change of [{ run_attempt: 3 }, { name: 'other' }, { path: '.github/workflows/other.yml' },
    { head_sha: OTHER }, { event: 'pull_request' }, { head_repository: { full_name: 'fork/Mikka' } }])
    assert.throws(() => assertReleaseIdentity(expected(), workflow, { ...run, ...change }), /thread_lifecycle_ci:/)
})

test('cost selection requires related source changes or a real validated and published candidate', () => {
  assert.equal(selectRelease(expected(), jobs(false), ['docs/unrelated.md']).selected, false)
  assert.equal(selectRelease(expected(), jobs(false), relevant).reason, 'lifecycle_changes')
  assert.equal(selectRelease(expected(), jobs(true), ['docs/unrelated.md']).reason, 'validated_runtime')
  assert.equal(selectRelease(expected(), jobs(false), relevant).runtime, 'unchanged_worker')
  for (const path of ['lib/cloud-computer/thread-machines.ts', 'lib/cloud-computer/thread-lifecycle-provider.ts',
    'lib/cloud-computer/thread-lifecycle-due.ts', 'workflows/thread-machine/workflow.ts',
    'scripts/e2b/thread-lifecycle-acceptance.ts', 'scripts/acceptance/thread-lifecycle-ci.test.mjs',
    '.github/workflows/thread-lifecycle-acceptance.yml']) assert.equal(lifecycleChanged([path]), true, path)
  for (const path of ['docs/acceptance/issue-1593.md', 'package.json', 'lib/unrelated.ts',
    'scripts/acceptance/thread-lifecycle.mjs/other']) assert.equal(lifecycleChanged([path]), false, path)
})

test('the current official publication shape requires its complete templates release proof', () => {
  const selected = selectRelease(expected(), buildTimeJobs(), [])
  assert.equal(selected.runtime, 'validated_and_published')
  assert.equal(selected.publication, 'build_time')
  assert.equal(selected.jobs.templates, 7)
  for (const mutate of [
    data => { data.jobs.find(row => row.name === 'release / templates').conclusion = 'skipped' },
    data => { data.jobs.find(row => row.name === 'release / templates').steps[0].conclusion = 'skipped' },
    data => { data.jobs.find(row => row.name === 'release / templates').steps[1].conclusion = 'failure' },
    data => { data.jobs.find(row => row.name === 'release / cleanup').conclusion = 'failure' },
    data => { data.jobs.push({ ...data.jobs[6], id: 99 }); data.total_count++ },
    data => { data.jobs.push({ ...data.jobs[6], name: 'release / subscriptions', id: 99 }); data.total_count++ },
    data => { data.jobs[6].head_sha = OTHER },
  ]) {
    const data = buildTimeJobs(); mutate(data)
    assert.throws(() => selectRelease(expected(), data, []), /thread_lifecycle_ci:jobs/)
  }
})

test('skipped, incomplete, stale-attempt or unsuccessful release jobs cannot authorize active work', () => {
  const refusals = [
    data => { data.total_count++ },
    data => { data.jobs[0].run_id++ },
    data => { data.jobs[0].run_attempt++ },
    data => { data.jobs[0].head_sha = OTHER },
    data => { data.jobs[0].status = 'in_progress' },
    data => { data.jobs[0].conclusion = 'skipped' },
    data => { data.jobs[2].conclusion = 'skipped' },
    data => { data.jobs[4].conclusion = 'failure' },
    data => { data.jobs[5].conclusion = 'skipped' },
    data => { data.jobs[6].conclusion = 'failure' },
    data => { data.jobs.push({ ...data.jobs[0], id: 99 }); data.total_count++ },
    data => { data.jobs.splice(6, 1); data.total_count-- },
  ]
  for (const mutate of refusals) {
    const data = jobs(); mutate(data)
    assert.throws(() => selectRelease(expected(), data, relevant), /thread_lifecycle_ci:jobs/)
  }
})

function apiFixture({ rerun = false, mainMoved = false, releaseEvent = run.event, validated = true, repository = run.repository,
  buildTime = false, publishedSource = SHA } = {}) {
  let runs = 0, refs = 0
  const calls = []
  const now = Date.now(), storage = 'https://productionresultssa1.blob.core.windows.net/synthetic-release/archive'
  let archive, artifact
  if (buildTime) {
    const report = { sourceCommit: publishedSource, workerSha: OTHER,
      templates: Object.fromEntries(['desktop', 'claude', 'codex'].map(kind => [kind, {
        name: `mikka-${publishedSource.slice(0, 12)}-123-2-${kind}`, baseTemplate: kind, templateId: `released-${kind}`,
        buildId: `build-${kind}`, preinstalled: true, public: true, buildStatus: 'ready',
      }])) }
    archive = execFileSync('python3', ['-c', 'import io,sys,zipfile\nb=io.BytesIO()\nwith zipfile.ZipFile(b,"w",zipfile.ZIP_DEFLATED) as z: z.writestr("release.json",sys.stdin.buffer.read())\nsys.stdout.buffer.write(b.getvalue())\n'],
      { input: JSON.stringify(report), maxBuffer: 16384, stdio: ['pipe', 'pipe', 'pipe'] })
    const api = `https://api.github.com/repos/${repository.full_name}`
    artifact = { id: 321, name: 'e2b-release-evidence-123-2', expired: false, size_in_bytes: archive.length,
      digest: 'sha256:' + createHash('sha256').update(archive).digest('hex'), created_at: new Date(now - 1000).toISOString(),
      expires_at: new Date(now + 3600000).toISOString(), url: `${api}/actions/artifacts/321`, archive_download_url: `${api}/actions/artifacts/321/zip`,
      workflow_run: { id: 123, repository_id: 1427517699, head_repository_id: 1427517699, head_branch: 'main', head_sha: SHA } }
  }
  const fetchImpl = async (input, options) => {
    if (input === storage) {
      assert.equal(options.headers?.authorization, undefined)
      assert.equal(options.redirect, 'error')
      calls.push('storage'); return new Response(archive)
    }
    const url = new URL(input)
    assert.equal(url.origin, 'https://api.github.com')
    assert.equal(options.headers.authorization, 'Bearer private-credential-sentinel')
    assert.equal(url.pathname.startsWith('/repositories/1427517699/'), true)
    const route = url.pathname.slice('/repositories/1427517699'.length) + url.search
    calls.push(route)
    if (buildTime && route === '/actions/artifacts/321/zip') {
      assert.equal(options.redirect, 'manual')
      return new Response(null, { status: 302, headers: { location: storage } })
    }
    assert.equal(options.redirect, 'error')
    if (route === '/actions/workflows/e2b-official-runtime.yml') return Response.json(workflow)
    if (route === '/actions/runs/123') return Response.json({ ...run, event: releaseEvent, repository, head_repository: repository,
      run_started_at: new Date(now - 60000).toISOString(), run_attempt: rerun && ++runs > 1 ? 3 : 2 })
    if (route === '/git/ref/heads/main') return Response.json({ object: { type: 'commit', sha: mainMoved && ++refs > 1 ? OTHER : SHA } })
    if (route === '/actions/runs/123/attempts/2/jobs?per_page=100') return Response.json(buildTime ? buildTimeJobs() : jobs(validated))
    if (buildTime && route === '/actions/runs/123/artifacts?per_page=100') return Response.json({ total_count: 1, artifacts: [artifact] })
    if (buildTime && route === '/actions/artifacts/321') return Response.json(artifact)
    assert.fail('Unexpected fixture endpoint')
  }
  return { fetchImpl, calls }
}

test('the legacy credential guard rechecks main and the attempt after exact-attempt jobs, with no artifact reads', async () => {
  const f = apiFixture(), proof = await verifyRelease({ env: env(), event: event(), files: relevant, ...f })
  assert.equal(proof.sourceCommit, SHA)
  assert.equal(proof.selected, true)
  assert.equal(proof.runtime, 'validated_and_published')
  assert.equal(f.calls.filter(path => path === '/actions/runs/123').length, 2)
  assert.equal(f.calls.filter(path => path === '/git/ref/heads/main').length, 2)
  assert.ok(!f.calls.some(path => path.includes('artifact')))
  for (const change of [{ rerun: true }, { mainMoved: true }])
    await assert.rejects(verifyRelease({ env: env(), event: event(), files: relevant, ...apiFixture(change) }))
})

test('automatic build-time publication binds the actual report source to current main before credentials', async () => {
  const fixture = apiFixture({ buildTime: true }), proof = await verifyRelease({ env: env(), event: event(), files: [], ...fixture })
  assert.equal(proof.runtime, 'validated_and_published')
  assert.equal(proof.publication, 'build_time')
  assert.equal(proof.workerSourceCommit, SHA)
  assert.equal(proof.artifact.id, 321)
  assert.match(proof.reportSha256, /^[a-f0-9]{64}$/)
  assert.equal(fixture.calls.filter(path => path === 'storage').length, 1)
  const attested = { ...proof, web: { sourceCommit: SHA, publicBuild: SHA, webRunId: 456, webAttempt: 1 } }
  assert.doesNotThrow(() => assertAttestation(expected(), attested))
  for (const mutate of [value => { value.workerSourceCommit = OTHER }, value => { value.artifact.repositoryId++ },
    value => { value.reportSha256 = 'invalid' }, value => { delete value.artifact }]) {
    const changed = structuredClone(attested); mutate(changed)
    assert.throws(() => assertAttestation(expected(), changed), /thread_lifecycle_ci:report/)
  }
  for (const change of [{ publishedSource: OTHER }, { rerun: true }, { mainMoved: true }])
    await assert.rejects(verifyRelease({ env: env(), event: event(), files: [], ...apiFixture({ buildTime: true, ...change }) }))
})

test('the shared guard verifies an automatic release and still rejects reruns and moving main', async () => {
  const trigger = event(); trigger.workflow_run.event = 'workflow_run'
  const repository = { id: 1427517699, full_name: 'aspectly-labs/Mikka', owner: { id: 359279274 } }
  trigger.workflow_run.repository = repository; trigger.workflow_run.head_repository = structuredClone(repository)
  const environment = { ...env(), GITHUB_REPOSITORY: repository.full_name, GITHUB_REPOSITORY_OWNER_ID: '359279274' }
  const fixture = apiFixture({ releaseEvent: 'workflow_run', repository })
  const proof = await verifyRelease({ env: environment, event: trigger, files: relevant, ...fixture })
  assert.equal(proof.selected, true)
  assert.equal(proof.runtime, 'validated_and_published')
  assert.equal(proof.sourceCommit, SHA)
  assert.equal(fixture.calls.filter(path => path === '/actions/runs/123').length, 2)
  assert.equal(fixture.calls.filter(path => path === '/git/ref/heads/main').length, 2)
  for (const change of [{ rerun: true }, { mainMoved: true }, { releaseEvent: 'push' }])
    await assert.rejects(verifyRelease({ env: environment, event: trigger, files: relevant,
      ...apiFixture({ releaseEvent: 'workflow_run', repository, ...change }) }))
  const skipped = await verifyRelease({ env: environment, event: trigger, files: ['README.md'],
    ...apiFixture({ releaseEvent: 'workflow_run', repository, validated: false }) })
  assert.equal(skipped.selected, false)
  assert.equal(skipped.runtime, 'unchanged_worker')
})

test('provider work requires this runner own same-source Web and upstream attestation', () => {
  const proof = { kind: 'thread-lifecycle-ci-attestation', selected: true, sourceCommit: SHA,
    upstream: { runId: 123, runAttempt: 2, workflowId: workflow.id },
    web: { sourceCommit: SHA, publicBuild: SHA, webRunId: 124, webAttempt: 1 } }
  assert.doesNotThrow(() => assertAttestation(expected(), proof))
  for (const mutate of [value => { value.sourceCommit = OTHER }, value => { value.upstream.runAttempt++ },
    value => { value.selected = false }, value => { value.web.publicBuild = OTHER }, value => { delete value.web }]) {
    const bad = structuredClone(proof); mutate(bad)
    assert.throws(() => assertAttestation(expected(), bad), /thread_lifecycle_ci:upstream/)
  }
})

function providerReport() {
  return { kind: 'thread-lifecycle-provider-acceptance', status: 'passed', sourceCommit: SHA, workerHash: OTHER,
    acceptance: '11111111-1111-1111-1111-111111111111', runId: '22222222-2222-2222-2222-222222222222',
    sandboxId: 'owned-instance', template: 'codex', subscriptionAcceptance: false, modelCalls: 0,
    resumeScope: 'provider-resume-to-controller-monitor', counters: { info: 10, keepAlive: 2, pause: 3, kill: 1 },
    requestDeadlineScope: 'sdk-request-deadline-to-controller-recovery',
    requestDeadline: { operation: 'setTimeout', requestTimeoutMs: 1, retries: 0, errorName: 'TimeoutError', earlyReplayIo: 0, recovered: true },
    retirement: { scope: 'confirmed-checkpoint-to-automatic-retirement', clock: 'controlled-paused-deadline', checkpointSha256: 'c'.repeat(64),
      restoredBeforeKill: true, restoredAfterKill: true, uploadClockAuthoritative: true, openRetentionRetained: true,
      closedGraceRetained: true, missingCheckpointRetained: true, deviceTokenRevoked: true, automaticKillConfirmed: true, historyPreserved: true,
      requestedAt: '2026-11-07T11:00:00.000Z', observedAt: '2026-11-07T11:00:01.000Z' },
    cases: ['active-monitor', 'provider-request-deadline', 'provider-refusal', 'lost-pause-response', 'resume-monitor', 'stale-epoch', 'stop-idempotence', 'end-idempotence'],
    cleanup: { provider: 'confirmed_missing', database: 'dropped' }, unexpected: 'private-provider-body' }
}

test('real request deadline evidence requires the actual timeout, bounded no-retry call and recovered controller', async () => {
  const raw = providerReport()
  raw.requestDeadline.unexpected = 'private-provider-body'
  const passed = await providerReceipt({ sourceCommit: SHA, run: async () => raw })
  assert.equal(passed.status, 'passed')
  assert.equal(passed.scope.requestDeadlineScope, 'sdk-request-deadline-to-controller-recovery')
  assert.deepEqual(passed.requestDeadline, providerReport().requestDeadline)
  assert.ok(!JSON.stringify(passed).includes('private-provider-body'))
  for (const mutate of [value => { delete value.requestDeadline },
    value => { delete value.requestDeadlineScope },
    value => { value.requestDeadline.errorName = 'AbortError' },
    value => { value.requestDeadline.requestTimeoutMs = 15_000 },
    value => { value.requestDeadline.retries = 1 },
    value => { value.requestDeadline.earlyReplayIo = 1 },
    value => { value.requestDeadline.recovered = false },
    value => { value.cases = value.cases.filter(name => name !== 'provider-request-deadline') }]) {
    const bad = providerReport(); mutate(bad)
    const rejected = await providerReceipt({ sourceCommit: SHA, run: async () => bad })
    assert.equal(rejected.status, 'failed')
    assert.equal(rejected.cleanup.status, 'unconfirmed')
  }
})

test('automatic retirement evidence requires confirmed recoverable bytes, retention refusals and preserved history', async () => {
  const raw = providerReport()
  raw.retirement.unexpected = 'private-checkpoint-bytes'
  const passed = await providerReceipt({ sourceCommit: SHA, run: async () => raw })
  assert.equal(passed.status, 'passed')
  assert.deepEqual(passed.retirement, providerReport().retirement)
  assert.ok(!JSON.stringify(passed).includes('private-checkpoint-bytes'))
  for (const field of ['restoredBeforeKill', 'restoredAfterKill', 'uploadClockAuthoritative', 'openRetentionRetained',
    'closedGraceRetained', 'missingCheckpointRetained', 'deviceTokenRevoked', 'automaticKillConfirmed', 'historyPreserved']) {
    const bad = providerReport(); bad.retirement[field] = false
    assert.equal((await providerReceipt({ sourceCommit: SHA, run: async () => bad })).status, 'failed')
  }
  for (const mutate of [value => { delete value.retirement }, value => { value.retirement.scope = 'explicit_end' },
    value => { value.retirement.clock = 'natural_expiry' }, value => { value.retirement.checkpointSha256 = '' },
    value => { value.counters.kill = 0 }, value => { value.counters.kill = 2 },
    value => { value.retirement.requestedAt = 'not-a-date' }, value => { value.retirement.observedAt = '2020-01-01T00:00:00.000Z' }]) {
    const bad = providerReport(); mutate(bad)
    assert.equal((await providerReceipt({ sourceCommit: SHA, run: async () => bad })).status, 'failed')
  }
})

test('only actual completed driver cleanup allows the independent subscription cases after a provider failure', async () => {
  const passed = await providerReceipt({ sourceCommit: SHA, run: async () => providerReport() })
  assert.equal(passed.status, 'passed'); assert.equal(passed.cleanup.status, 'passed')
  assert.equal(passed.scope.naturalTimeoutExpiry, false)
  assert.equal(passed.scope.daemonAcceptance, false)
  assert.equal(passed.scope.subscriptionAcceptance, false)
  assert.ok(!JSON.stringify(passed).includes('private-provider-body'))
  const cleaned = await providerReceipt({ sourceCommit: SHA, run: async () => {
    throw new Error('thread_lifecycle_acceptance_failed:provider-refusal', { cause: Error('private-provider-body') })
  } })
  assert.equal(cleaned.status, 'failed'); assert.equal(cleaned.cleanup.status, 'passed')
  assert.equal(cleaned.stage, 'provider-refusal')
  assert.ok(!JSON.stringify(cleaned).includes('private-provider-body'))
  for (const failure of [new AggregateError([Error('private-provider-body')], 'thread_lifecycle_acceptance_cleanup_failed'),
    Error('private-provider-body'), Error('thread_lifecycle_acceptance_failed:untrusted-stage'),
    Error('thread_lifecycle_acceptance_failed:provider-refusal\nprivate-provider-body')]) {
    const receipt = await providerReceipt({ sourceCommit: SHA, run: async () => { throw failure } })
    assert.equal(receipt.status, 'failed'); assert.equal(receipt.cleanup.status, 'unconfirmed')
    assert.ok(!JSON.stringify(receipt).includes('private-provider-body'))
  }
  for (const overrides of [{ sourceCommit: OTHER }, { cleanup: { provider: 'still_running', database: 'dropped' } },
    { cases: [] }, { subscriptionAcceptance: true }, { modelCalls: 1 }]) {
    const receipt = await providerReceipt({ sourceCommit: SHA, run: async () => ({ ...providerReport(), ...overrides }) })
    assert.equal(receipt.cleanup.status, 'unconfirmed')
  }
})

test('continue-on-error never turns partial, failed or unconfirmed-cleanup evidence into passing acceptance', async () => {
  const provider = await providerReceipt({ sourceCommit: SHA, run: async () => providerReport() })
  const owner = { sourceCommit: SHA, status: 'passed', cleanup: { status: 'passed' }, issueAcceptance: 'incomplete',
    scope: 'real_owner_factory_question_pause_resume_with_native_report',
    cases: [['claude_code', 'claude-haiku-5-5'], ['codex', 'gpt-6-luna']].map(([harness, model]) => ({
      harness, model, sourceCommit: SHA, status: 'passed', cleanup: { status: 'passed' },
    })) }
  const outcomes = { provider: 'success', owner: 'success' }
  const result = completeEvidence(SHA, provider, owner, outcomes)
  assert.equal(result.status, 'passed')
  assert.equal(result.questionResume, 'passed')
  assert.equal(result.providerIntegration, 'passed')
  assert.equal(result.automaticRetirement, 'passed')
  assert.equal(result.issueAcceptance, 'incomplete')
  assert.deepEqual(result.pending, ['external_wait_and_adjacent_stage_continuity', 'terminal_revoke_and_close_grace_retention',
    'latency_and_cost_measurement'])
  assert.equal(result.subscriptions, undefined, 'the report never declares complete subscription/issue acceptance')
  for (const status of ['partial', 'blocked', 'failed'])
    assert.equal(completeEvidence(SHA, provider, { ...owner, status }, outcomes).status, 'failed')
  assert.equal(completeEvidence(SHA, provider, { ...owner, cleanup: { status: 'failed' } }, outcomes).status, 'failed')
  assert.equal(completeEvidence(SHA, provider, { ...owner, sourceCommit: OTHER }, outcomes).status, 'failed')
  const failedProvider = completeEvidence(SHA, provider, owner, { ...outcomes, provider: 'failure' })
  assert.equal(failedProvider.status, 'failed')
  assert.equal(failedProvider.providerIntegration, 'incomplete')
  assert.ok(failedProvider.pending.includes('provider_timeout_fault_injection'))
  for (const mutate of [value => { delete value.requestDeadline },
    value => { delete value.retirement },
    value => { value.retirement.restoredAfterKill = false },
    value => { value.counters.kill = 0 }, value => { value.counters.kill = 2 },
    value => { value.requestDeadline.errorName = 'AbortError' },
    value => { value.cases = value.cases.filter(name => name !== 'provider-request-deadline') },
    value => { value.scope = { ...value.scope, requestDeadlineScope: 'unproved' } }]) {
    const bad = structuredClone(provider); mutate(bad)
    const incomplete = completeEvidence(SHA, bad, owner, outcomes)
    assert.equal(incomplete.providerIntegration, 'incomplete')
    assert.ok(incomplete.pending.includes('provider_timeout_fault_injection'))
  }
  assert.equal(completeEvidence(SHA, { ...provider, sourceCommit: OTHER }, owner, outcomes).providerIntegration, 'incomplete')
  assert.equal(completeEvidence(SHA, provider, null, { ...outcomes, owner: 'skipped' }).status, 'failed')
  for (const override of [{ issueAcceptance: 'passed' }, { scope: 'full_issue_acceptance' }, { cases: owner.cases.slice(0, 1) },
    { cases: [owner.cases[0], owner.cases[0]] }, { cases: [owner.cases[0], null] },
    { cases: [owner.cases[0], { ...owner.cases[1], model: 'another-model' }] },
    { cases: [owner.cases[0], { ...owner.cases[1], sourceCommit: OTHER }] },
    { cases: [owner.cases[0], { ...owner.cases[1], cleanup: { status: 'failed' } }] }])
    assert.equal(completeEvidence(SHA, provider, { ...owner, ...override }, outcomes).status, 'failed')
})

test('the privileged job starts only after metadata authorization and keeps exact checkout, account serialization and narrow credentials', () => {
  assert.ok(workflowText.startsWith('name: Task VM question-resume evidence\n'))
  const authorize = workflowText.split('  authorize:')[1].split('  acceptance:')[0]
  assert.ok(!authorize.includes('id-token:'))
  assert.ok(authorize.indexOf('Authenticate upstream metadata') < authorize.indexOf('uses: actions/checkout@'))
  assert.ok(authorize.includes('ref: ${{ steps.source.outputs.source-sha }}'))
  assert.ok(!workflowText.includes('actions/download-artifact'))
  const acceptance = workflowText.split('  acceptance:')[1]
  assert.ok(acceptance.includes("if: needs.authorize.outputs.selected == 'true'"))
  assert.ok(acceptance.includes('ref: ${{ needs.authorize.outputs.source-sha }}'))
  assert.ok(acceptance.includes('group: production-smoke-owner-acceptance\n      cancel-in-progress: false'))
  assert.ok(acceptance.indexOf('attest the exact live Web build before credentials') < acceptance.indexOf('uses: Infisical/'))
  assert.ok(acceptance.indexOf('id: provider') < acceptance.indexOf('secret-name: SMOKE_OWNER_EMAIL'))
  assert.deepEqual([...acceptance.matchAll(/secret-name: (\w+)/g)].map(match => match[1]),
    ['E2B_API_KEY', 'SMOKE_OWNER_EMAIL', 'SMOKE_OWNER_PASSWORD'])
  for (const use of [...workflowText.matchAll(/uses: (\S+)/g)].map(match => match[1]))
    assert.ok(use.startsWith('./') || /@[a-f0-9]{40}$/.test(use), use)
  assert.ok(acceptance.includes("steps.provider.outputs.cleanup-complete == 'true'"))
  assert.ok(acceptance.includes('PROVIDER_OUTCOME: ${{ steps.provider.outcome }}'))
  assert.ok(acceptance.includes('OWNER_OUTCOME: ${{ steps.owner.outcome }}'))
  assert.ok(!acceptance.includes('VERCEL_TEAM_TOKEN'))
  assert.ok(!acceptance.includes('E2B_ACCEPTANCE_TEMPLATE'))
})


test('serialized release job names retain the full proof and allow the cheap caller skip', () => {
  const nested = jobs(true)
  nested.jobs = nested.jobs.map(job => job.name === 'test' || job.name === 'check' ? job : { ...job, name: 'release / ' + job.name })
  nested.jobs.push({ ...nested.jobs[0], id: 99, name: 'release / recheck' }); nested.total_count++
  assert.equal(selectRelease(expected(), nested, ['README.md']).runtime, 'validated_and_published')
  nested.jobs.find(job => job.name === 'release / subscriptions').conclusion = 'skipped'
  assert.throws(() => selectRelease(expected(), nested, relevant), /thread_lifecycle_ci:jobs/)
  const skipped = jobs(false)
  skipped.jobs = [...skipped.jobs.slice(0, 2), { ...skipped.jobs[2], name: 'release' }]; skipped.total_count = 3
  assert.equal(selectRelease(expected(), skipped, ['README.md']).selected, false)
  assert.equal(selectRelease(expected(), skipped, relevant).reason, 'lifecycle_changes')
  const rechecked = jobs(false)
  rechecked.jobs = rechecked.jobs.map(job => job.name === 'test' || job.name === 'check' ? job : { ...job, name: 'release / ' + job.name })
  rechecked.jobs.push({ ...rechecked.jobs[0], id: 99, name: 'release / recheck' }); rechecked.total_count++
  assert.equal(selectRelease(expected(), rechecked, ['README.md']).selected, false)
})
