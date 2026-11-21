import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { runInNewContext } from 'node:vm'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { readOptions } from './task-secrets.mjs'
import { runObservabilityWorkflow } from './run-observability-workflow.mjs'
import { archiveReport, artifactRedirect, assertArtifactIdentity, assertDriverAttestation, downloadReleaseReport,
  MAX_ARCHIVE_BYTES, MAX_REPORT_BYTES, releasePins, safeCIFailure, selectTaskRelease, taskSecretsChanged,
  verifyTaskRelease, factoryAcceptanceScope, REPOSITORY, RELEASE_NAME, RELEASE_WORKFLOW } from './task-secrets-ci.mjs'

const SHA = 'a'.repeat(40), WORKER = 'b'.repeat(40), OTHER = 'c'.repeat(40)
const TOKEN = 'synthetic-private-github-token', API = `https://api.github.com/repos/${REPOSITORY}`
const IMMUTABLE_API = 'https://api.github.com/repositories/1427517699'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const workflow = { id: 456, name: RELEASE_NAME, path: RELEASE_WORKFLOW, state: 'active' }
const started = new Date(Date.now() - 60_000).toISOString()
const run = { id: 123, run_attempt: 2, workflow_id: workflow.id, name: RELEASE_NAME, path: RELEASE_WORKFLOW,
  head_sha: SHA, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success', run_started_at: started,
  repository: { id: 1427517699, full_name: REPOSITORY, owner: { id: 183887963 } },
  head_repository: { id: 1427517699, full_name: REPOSITORY, owner: { id: 183887963 } } }
const expected = { sourceCommit: SHA, runId: run.id, runAttempt: run.run_attempt, workflowId: workflow.id, event: run.event,
  repositoryId: run.repository.id, repositoryFullName: REPOSITORY }
const env = () => ({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_run', GITHUB_REPOSITORY: REPOSITORY,
  GITHUB_REPOSITORY_ID: '1427517699', GITHUB_REPOSITORY_OWNER_ID: '183887963',
  GITHUB_REF: 'refs/heads/main', GITHUB_SHA: SHA, GITHUB_RUN_ID: '990', GITHUB_RUN_ATTEMPT: '1', GITHUB_TOKEN: TOKEN,
  TASK_SECRETS_JOB_ID: '991', TASK_SECRETS_JOB_STARTED_AT: started, TASK_SECRETS_JOB_START_SOURCE: 'github_actions_job.started_at',
  APPLICATION_SHA: SHA, EXPECTED_SOURCE_SHA: SHA, EXPECTED_UPSTREAM_RUN_ID: '123', EXPECTED_UPSTREAM_RUN_ATTEMPT: '2',
  EXPECTED_WORKER_SHA: WORKER, EXPECTED_WORKER_SOURCE_SHA: SHA, EXPECTED_CLAUDE_TEMPLATE: 'candidate-claude', EXPECTED_CODEX_TEMPLATE: 'candidate-codex' })
const event = () => ({ workflow_run: structuredClone(run) })
function jobs(validated = true) {
  const names = ['test', 'check', validated ? 'validate / build' : 'validate', 'await-web', 'subscriptions',
    validated ? 'publish / deploy' : 'publish', 'cleanup']
  return { total_count: names.length, jobs: names.map((name, index) => ({ id: index + 1, name,
    run_id: 123, run_attempt: 2, head_sha: SHA, status: 'completed', conclusion: validated || index < 2 ? 'success' : 'skipped' })) }
}
function report(sourceCommit = SHA, workerSha = WORKER) {
  return { sourceCommit, workerSha, templates: Object.fromEntries(['desktop', 'claude', 'codex'].map(kind => [kind, {
    name: `mikka-${sourceCommit.slice(0, 12)}-123-2-${kind}`, baseTemplate: kind, templateId: `candidate-${kind}`,
    buildId: `build-${kind}`, preinstalled: true, public: true, buildStatus: 'ready',
  }])), subscriptionAcceptance: Object.fromEntries([['claude', 'claude_code', 'claude-haiku-5-5'], ['codex', 'codex', 'gpt-6-luna']].map(([kind, harness, model]) => [kind, {
    status: 'passed', sourceCommit, workerSha, templateId: `candidate-${kind}`, harness, model,
    credentialRoute: 'subscription', replyVerified: true, replyVerifiedAfterTool: true,
  }])) }
}
function zip(entries) {
  const source = 'import io,json,sys,zipfile\nbuffer=io.BytesIO()\nwith zipfile.ZipFile(buffer,"w",zipfile.ZIP_DEFLATED) as archive:\n    for row in json.load(sys.stdin): archive.writestr(row["name"],row["value"])\nsys.stdout.buffer.write(buffer.getvalue())\n'
  return execFileSync('python3', ['-c', source], { input: JSON.stringify(entries), maxBuffer: MAX_ARCHIVE_BYTES + 1024,
    stdio: ['pipe', 'pipe', 'pipe'] })
}
const validArchive = zip([{ name: 'release.json', value: JSON.stringify(report()) }])
function artifact(archive = validArchive) {
  return { id: 321, name: 'e2b-release-evidence-123-2', expired: false, size_in_bytes: archive.length,
    created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString(), digest: `sha256:${hash(archive)}`,
    url: `${API}/actions/artifacts/321`, archive_download_url: `${API}/actions/artifacts/321/zip`,
    workflow_run: { id: 123, repository_id: 1427517699, head_repository_id: 1427517699, head_branch: 'main', head_sha: SHA } }
}
const relevant = ['docs/security/task-secret-delivery.md', 'lib/secrets/runtime.ts']
function proof() {
  return { kind: 'task-secret-ci-attestation', sourceCommit: SHA, selected: true, publicBuild: SHA,
    upstream: { runId: 123, runAttempt: 2, workflowId: 456 }, driver: { runId: 990, runAttempt: 1 },
    artifact: assertArtifactIdentity(expected, run, artifact()), ...releasePins(Buffer.from(JSON.stringify(report())), expected, WORKER) }
}

test('cost selection requires a concrete Secret path and all exact-attempt publication jobs', () => {
  assert.equal(selectTaskRelease(expected, jobs(), relevant).selected, true)
  assert.equal(selectTaskRelease(expected, jobs(), ['docs/security/task-secret-delivery.md']).selected, false)
  assert.equal(selectTaskRelease(expected, jobs(), ['packages/daemon/src/unrelated.ts']).reason, 'unrelated_source')
  assert.equal(selectTaskRelease(expected, jobs(false), relevant).status, 'blocked')
  assert.equal(selectTaskRelease(expected, jobs(false), relevant).selected, false)
  for (const name of ['test', 'check', 'validate / build', 'await-web', 'subscriptions', 'publish / deploy', 'cleanup']) {
    const data = jobs(); data.jobs.find(row => row.name === name).conclusion = 'failure'
    assert.throws(() => selectTaskRelease(expected, data, relevant), /jobs/)
  }
  for (const mutate of [data => { data.jobs[0].run_attempt = 1 }, data => { data.jobs[0].run_id = 124 },
    data => { data.jobs[0].head_sha = OTHER }, data => { data.total_count++ }, data => { data.jobs.push(data.jobs[0]); data.total_count++ }]) {
    const data = jobs(); mutate(data); assert.throws(() => selectTaskRelease(expected, data, relevant))
  }
  assert.throws(() => taskSecretsChanged(['../lib/secrets/runtime.ts']))
  assert.equal(taskSecretsChanged(['scripts/acceptance/task-secrets-ci.test.mjs']), true)
})

test('artifact identity binds repository, source, run, attempt, expiry, size and immutable GitHub endpoints', () => {
  assert.equal(assertArtifactIdentity(expected, run, artifact()).id, 321)
  for (const mutate of [row => { row.name = 'e2b-release-evidence-123-1' }, row => { row.expired = true },
    row => { row.workflow_run.id++ }, row => { row.workflow_run.repository_id++ }, row => { row.workflow_run.head_repository_id++ },
    row => { row.workflow_run.head_sha = OTHER }, row => { row.workflow_run.head_branch = 'feature' },
    row => { row.created_at = '2020-01-01T00:00:00Z' }, row => { row.expires_at = '2020-01-01T00:00:00Z' },
    row => { row.size_in_bytes = MAX_ARCHIVE_BYTES + 1 }, row => { row.size_in_bytes = 0 }, row => { row.digest = null },
    row => { row.archive_download_url = 'https://attacker.example/report' }, row => { row.url = `${API}/actions/artifacts/999` }]) {
    const row = artifact(); mutate(row); assert.throws(() => assertArtifactIdentity(expected, run, row))
  }
})

test('artifact identity admits recorded canonical metadata only for the caller-pinned repository', () => {
  // Native run 44140435060/1 and artifact 14354323589 after the repository transfer.
  // The fixed clock validates that historical capture, not the artifact's current expiry.
  const validationAt = Date.parse('2026-11-20T23:37:37Z')
  const pinned = {
    sourceCommit: '5189fa615cfd7ce281ce7c7e17e477206dba2254',
    runId: 44140435060,
    runAttempt: 1,
    repositoryId: 1427517699,
    repositoryFullName: 'aspectly-labs/Mikka'
  }
  const nativeRun = {
    run_started_at: '2026-11-17T17:45:19Z',
    repository: {
      id: 1427517699,
      full_name: 'aspectly-labs/Mikka'
    },
    head_repository: {
      id: 1427517699,
      full_name: 'aspectly-labs/Mikka'
    }
  }
  const nativeArtifact = {
    id: 14354323589,
    name: 'e2b-release-evidence-44140435060-1',
    size_in_bytes: 46376,
    url: 'https://api.github.com/repos/aspectly-labs/Mikka/actions/artifacts/14354323589',
    archive_download_url: 'https://api.github.com/repos/aspectly-labs/Mikka/actions/artifacts/14354323589/zip',
    expired: false,
    created_at: '2026-11-17T17:56:59Z',
    expires_at: '2026-11-24T17:56:58Z',
    digest: 'sha256:eaf16c7b76bd6a82b2394f93a42fa41ad12c55fbe96dea415d07c742d4fb2429',
    workflow_run: {
      id: 44140435060,
      repository_id: 1427517699,
      head_repository_id: 1427517699,
      head_branch: 'main',
      head_sha: '5189fa615cfd7ce281ce7c7e17e477206dba2254'
    }
  }
  const identity = assertArtifactIdentity(pinned, nativeRun, nativeArtifact, validationAt)
  assert.equal(identity.id, 14354323589)
  assert.equal(identity.repositoryId, 1427517699)
  for (const change of [
    value => { delete value.expected.repositoryId },
    value => { value.expected.repositoryId = '1427517699' },
    value => { value.expected.repositoryId = Number.MAX_SAFE_INTEGER + 1 },
    value => { delete value.expected.repositoryFullName },
    value => { value.expected.repositoryFullName = '../Mikka' },
    value => { value.run.repository.id++ },
    value => { value.run.head_repository.id++ },
    value => { value.run.repository.full_name = 'foreign/Mikka' },
    value => { value.run.head_repository.full_name = 'foreign/Mikka' },
    value => { value.artifact.workflow_run.repository_id++ },
    value => { value.artifact.workflow_run.head_repository_id++ },
    value => { value.artifact.url = value.artifact.url.replace('aspectly-labs', 'foreign') },
    value => { value.artifact.archive_download_url = value.artifact.archive_download_url.replace('aspectly-labs', 'alexj11324') },
    value => { value.artifact.expired = true },
  ]) {
    const value = structuredClone({ expected: pinned, run: nativeRun, artifact: nativeArtifact })
    change(value)
    assert.throws(() => assertArtifactIdentity(value.expected, value.run, value.artifact, validationAt), /artifact_identity/)
  }
})

test('release report identity, both real subscription pins and computed worker hash are mandatory', () => {
  assert.deepEqual(releasePins(Buffer.from(JSON.stringify(report())), expected, WORKER).templates,
    { claude_code: 'candidate-claude', codex: 'candidate-codex' })
  for (const mutate of [row => { row.sourceCommit = OTHER }, row => { row.workerSha = OTHER },
    row => { row.templates.codex.name = row.templates.codex.name.replace('-123-2-', '-123-1-') },
    row => { row.templates.claude.public = false }, row => { row.templates.desktop.preinstalled = false },
    row => { delete row.subscriptionAcceptance.claude }, row => { row.subscriptionAcceptance.codex.model = 'gpt-6-pro' },
    row => { row.subscriptionAcceptance.codex.credentialRoute = 'api_key' }, row => { row.subscriptionAcceptance.claude.replyVerifiedAfterTool = false }]) {
    const row = report(); mutate(row); assert.throws(() => releasePins(Buffer.from(JSON.stringify(row)), expected, WORKER))
  }
  assert.throws(() => releasePins(Buffer.from(JSON.stringify(report())), expected, OTHER))
})

test('ZIP parsing reads only one bounded release.json and never extracts arbitrary archive paths', () => {
  assert.equal(hash(archiveReport(validArchive)), hash(JSON.stringify(report())))
  for (const entries of [[{ name: '../release.json', value: '{}' }], [{ name: '/release.json', value: '{}' }],
    [{ name: 'release.json', value: '{}' }, { name: 'other', value: 'private' }],
    [{ name: 'release.json', value: '{}' }, { name: 'release.json', value: '{}' }]]) {
    assert.throws(() => archiveReport(zip(entries)), /artifact_archive/)
  }
  assert.throws(() => archiveReport(Buffer.from('invalid archive')), /artifact_archive/)
  const large = zip([{ name: 'release.json', value: 'x'.repeat(MAX_REPORT_BYTES + 1) }])
  assert.throws(() => archiveReport(large), /artifact_archive/)
})

test('artifact download authenticates only the fixed API, does not forward tokens, and verifies exact archive bytes', async () => {
  const artifactProof = proof(), calls = [], location = 'https://productionresultssa12.blob.core.windows.net/actions-results/report?synthetic=sas'
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    if (calls.length === 1) {
      assert.equal(url, `https://api.github.com/repositories/${run.repository.id}/actions/artifacts/321/zip`)
      assert.equal(options.headers.authorization, `Bearer ${TOKEN}`); assert.equal(options.redirect, 'manual')
      return new Response(null, { status: 302, headers: { location } })
    }
    assert.equal(url, location); assert.equal(options.headers, undefined); assert.equal(options.redirect, 'error')
    return new Response(validArchive)
  }
  assert.equal(hash(await downloadReleaseReport(artifactProof, { token: TOKEN, fetchImpl })), hash(JSON.stringify(report())))
  await assert.rejects(downloadReleaseReport({ ...artifactProof, artifact: { ...artifactProof.artifact, sha256: 'f'.repeat(64) } }, {
    token: TOKEN, fetchImpl: async url => url === location ? new Response(validArchive)
      : new Response(null, { status: 302, headers: { location } }),
  }), /artifact_digest/)
  for (const repositoryId of [undefined, 0, -1, '1427517699', Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(downloadReleaseReport({ ...artifactProof, artifact: { ...artifactProof.artifact, repositoryId } }, {
      token: TOKEN, fetchImpl: async () => assert.fail('invalid repository proof must not request a URL'),
    }), /attestation/)
  }
  for (const url of ['http://productionresultssa12.blob.core.windows.net/file', 'https://attacker.example/file',
    'https://user:pass@productionresultssa12.blob.core.windows.net/file', 'https://127.0.0.1/file',
    'https://productionresultssa12.blob.core.windows.net:444/file', 'https://productionresultssa12.blob.core.windows.net.evil.example/file']) assert.throws(() => artifactRedirect(url))
})

test('driver accepts automatic execution only with exact source/attempt/artifact/worker attestation and both models', () => {
  const good = proof()
  assert.equal(readOptions(['--execute'], env(), good).execute, true)
  assert.throws(() => readOptions(['--execute'], env()))
  assert.throws(() => readOptions([], env(), good))
  assert.throws(() => readOptions(['--execute'], { ...env(), TASK_SECRETS_MODEL_CASE: 'claude' }, good))
  assert.throws(() => readOptions(['--execute', '--production-canary'], env(), good))
  for (const mutate of [row => { row.selected = false }, row => { row.sourceCommit = OTHER }, row => { row.upstream.runAttempt = 1 },
    row => { row.driver.runId++ }, row => { row.driver.runAttempt++ }, row => { row.publicBuild = OTHER },
    row => { row.workerSha = OTHER }, row => { row.templates.codex = 'different' }, row => { row.reportSha256 = '' }]) {
    const row = proof(); mutate(row); assert.throws(() => assertDriverAttestation(env(), row))
  }
  assert.throws(() => assertDriverAttestation({ ...env(), GITHUB_RUN_ATTEMPT: '3' }, good))
})

function responseFixture() {
  const a = artifact()
  return { workflow: structuredClone(workflow), run: structuredClone(run), jobs: jobs(), main: { object: { type: 'commit', sha: SHA } },
    artifact: a, listing: { total_count: 1, artifacts: [a] } }
}
function reader(fixture, mutate = () => {}) {
  const calls = []
  return { calls, fetchImpl: async (url, options) => {
    calls.push(url); mutate(fixture, calls)
    assert.equal(options.headers.authorization, `Bearer ${TOKEN}`); assert.equal(options.redirect, 'error')
    const data = { [`${IMMUTABLE_API}/actions/workflows/e2b-official-runtime.yml`]: fixture.workflow, [`${IMMUTABLE_API}/actions/runs/123`]: fixture.run,
      [`${IMMUTABLE_API}/git/ref/heads/main`]: fixture.main, [`${IMMUTABLE_API}/actions/runs/123/attempts/2/jobs?per_page=100`]: fixture.jobs,
      [`${IMMUTABLE_API}/actions/runs/123/artifacts?per_page=100`]: fixture.listing, [`${IMMUTABLE_API}/actions/artifacts/321`]: fixture.artifact }
    assert.ok(Object.hasOwn(data, url), 'only fixed read-only GitHub routes are used')
    return Response.json(data[url])
  } }
}

test('canonical Task release metadata uses immutable routes and keeps artifact identity checks', async () => {
  // The native old-name run URL returned HTTP301 to this immutable repository
  // route on 2026-11-21. A redirect:error reader cannot use the retired route.
  const fixture = responseFixture(), environment = env()
  environment.GITHUB_REPOSITORY = 'aspectly-labs/Mikka'
  environment.GITHUB_REPOSITORY_OWNER_ID = '359279274'
  fixture.run.event = 'workflow_run'
  for (const key of ['repository', 'head_repository'])
    fixture.run[key] = { id: 1427517699, full_name: environment.GITHUB_REPOSITORY, owner: { id: 359279274 } }
  fixture.artifact.url = 'https://api.github.com/repos/aspectly-labs/Mikka/actions/artifacts/321'
  fixture.artifact.archive_download_url = fixture.artifact.url + '/zip'
  const calls = [], data = {
    [`${IMMUTABLE_API}/actions/workflows/e2b-official-runtime.yml`]: fixture.workflow,
    [`${IMMUTABLE_API}/actions/runs/123`]: fixture.run,
    [`${IMMUTABLE_API}/git/ref/heads/main`]: fixture.main,
    [`${IMMUTABLE_API}/actions/runs/123/attempts/2/jobs?per_page=100`]: fixture.jobs,
    [`${IMMUTABLE_API}/actions/runs/123/artifacts?per_page=100`]: fixture.listing,
    [`${IMMUTABLE_API}/actions/artifacts/321`]: fixture.artifact,
  }
  const fetchImpl = async (url, options) => {
    calls.push(url)
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers.authorization, `Bearer ${TOKEN}`)
    if (url.startsWith(API + '/')) return new Response(null,
      { status: 301, headers: { location: IMMUTABLE_API + url.slice(API.length) } })
    assert.ok(Object.hasOwn(data, url), 'only the fixed immutable repository is read')
    return Response.json(data[url])
  }
  const request = { env: environment, event: { workflow_run: structuredClone(fixture.run) }, files: relevant, fetchImpl }
  const result = await verifyTaskRelease(request)
  assert.equal(result.selected, true)
  assert.equal(result.artifact.repositoryId, 1427517699)
  assert.equal(result.artifact.id, 321)
  assert.ok(calls.every(url => url.startsWith(IMMUTABLE_API + '/')))
  assert.equal(calls.filter(url => url.endsWith('/actions/runs/123')).length, 2)
  assert.equal(calls.filter(url => url.endsWith('/git/ref/heads/main')).length, 2)
  fixture.artifact.url = fixture.artifact.url.replace('aspectly-labs', 'foreign')
  await assert.rejects(verifyTaskRelease(request), /artifact_identity/)
})

test('live release verification rejects missing/duplicate artifacts and a rerun or moving main during the check', async () => {
  const good = reader(responseFixture())
  assert.equal((await verifyTaskRelease({ env: env(), event: event(), files: relevant, fetchImpl: good.fetchImpl })).selected, true)
  for (const mutate of [value => { value.listing = { total_count: 0, artifacts: [] } },
    value => { value.listing = { total_count: 2, artifacts: [value.artifact, value.artifact] } },
    value => { value.run.path = '.github/workflows/foreign.yml' }, value => { value.main.object.sha = OTHER }]) {
    const fixture = responseFixture(); mutate(fixture)
    await assert.rejects(verifyTaskRelease({ env: env(), event: event(), files: relevant, fetchImpl: reader(fixture).fetchImpl }))
  }
  for (const mutate of [value => { value.run.run_attempt++ }, value => { value.main.object.sha = OTHER }]) {
    const fake = reader(responseFixture(), (value, calls) => { if (calls.filter(url => url.endsWith('/actions/runs/123')).length === 2) mutate(value) })
    await assert.rejects(verifyTaskRelease({ env: env(), event: event(), files: relevant, fetchImpl: fake.fetchImpl }))
  }
  const skipped = reader(responseFixture())
  assert.equal((await verifyTaskRelease({ env: env(), event: event(), files: ['README.md'], fetchImpl: skipped.fetchImpl })).selected, false)
  assert.ok(skipped.calls.every(url => !url.includes('/artifacts')))
})

const workflowText = readFileSync(new URL('../../.github/workflows/task-secret-acceptance.yml', import.meta.url), 'utf8')
function metadataScript() {
  const lines = workflowText.split('\n'), start = lines.findIndex(line => line.trim() === "node --input-type=module <<'JS'")
  const end = lines.findIndex((line, index) => index > start && line.trim() === 'JS')
  assert.ok(start >= 0 && end > start)
  const indent = lines[start].match(/^ */)[0].length
  return lines.slice(start + 1, end).map(line => line.slice(indent)).join('\n')
}
function metadataFixture(t, mutate = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), 'task-secrets-metadata-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const fixture = { event: event(), environment: env(), ...responseFixture() }; mutate(fixture)
  const fixturePath = join(directory, 'fixture.json'), eventPath = join(directory, 'event.json'), output = join(directory, 'output')
  writeFileSync(fixturePath, JSON.stringify(fixture)); writeFileSync(eventPath, JSON.stringify(fixture.event)); writeFileSync(output, '')
  const setup = `import {readFileSync as fixtureRead} from 'node:fs'; const f=JSON.parse(fixtureRead(process.env.FIXTURE_PATH));\n`
    + `globalThis.fetch=async(url,options)=>{if(options.redirect!=='error'||options.headers.authorization!=='Bearer ${TOKEN}')throw Error('private');\n`
    + `const routes={'${IMMUTABLE_API}/actions/workflows/e2b-official-runtime.yml':f.workflow,'${IMMUTABLE_API}/actions/runs/123':f.run,'${IMMUTABLE_API}/git/ref/heads/main':f.main}; if(!Object.hasOwn(routes,url))throw Error('private');return Response.json(routes[url])};\n`
  const result = spawnSync(process.execPath, ['--input-type=module'], { input: setup + metadataScript(), encoding: 'utf8',
    env: { PATH: process.env.PATH, ...fixture.environment, FIXTURE_PATH: fixturePath, GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: output } })
  return { ...result, output: readFileSync(output, 'utf8') }
}

test('the actual pre-checkout script permits current official release or exact manual main', t => {
  const result = metadataFixture(t)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.output, `source-sha=${SHA}\nupstream-run-id=123\nupstream-run-attempt=2\n`)
  const manual = metadataFixture(t, value => { value.environment.GITHUB_EVENT_NAME = 'workflow_dispatch' })
  assert.equal(manual.status, 0, manual.stderr); assert.equal(manual.output, `source-sha=${SHA}\n`)
})

test('Cloudflare-triggered runtime metadata retains all pre-checkout identity checks', t => {
  const automatic = mutate => metadataFixture(t, value => {
    value.event.workflow_run.event = 'workflow_run'; value.run.event = 'workflow_run'
    value.environment.GITHUB_REPOSITORY = 'aspectly-labs/Mikka'; value.environment.GITHUB_REPOSITORY_OWNER_ID = '359279274'
    for (const source of [value.event.workflow_run, value.run]) for (const key of ['repository', 'head_repository'])
      source[key] = { id: 1427517699, full_name: 'aspectly-labs/Mikka', owner: { id: 359279274 } }
    mutate?.(value)
  })
  const result = automatic()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.output, `source-sha=${SHA}\nupstream-run-id=123\nupstream-run-attempt=2\n`)
  for (const mutate of [value => { value.event.workflow_run.head_repository.full_name = 'fork/Mikka' },
    value => { value.workflow.path = '.github/workflows/other.yml' }, value => { value.run.event = 'push' },
    value => { value.run.run_attempt++ }, value => { value.main.object.sha = OTHER },
    value => { value.environment.GITHUB_RUN_ATTEMPT = '3' },
    value => { value.environment.GITHUB_REPOSITORY_ID = '999' },
    value => { value.environment.GITHUB_REPOSITORY_OWNER_ID = '183887963' },
    value => { delete value.environment.GITHUB_REPOSITORY_OWNER_ID },
    value => { value.event.workflow_run.repository.id++ },
    value => { value.event.workflow_run.head_repository.owner.id = 183887963 },
    value => { value.run.repository.owner.id = 183887963 }, value => { value.run.head_repository.id++ }]) {
    const refused = automatic(mutate)
    assert.equal(refused.status, 1); assert.equal(refused.output, '')
    assert.equal(refused.stderr.trim(), 'task_secret_source_refused')
  }
})

test('the actual pre-checkout script refuses fork, PR, wrong workflow/attempt/source and exhausted receiver retry', t => {
  for (const mutate of [value => { value.environment.GITHUB_REPOSITORY = 'fork/Mikka' },
    value => { value.environment.GITHUB_EVENT_NAME = 'pull_request_target' }, value => { value.environment.GITHUB_REF = 'refs/heads/other' },
    value => { value.event.workflow_run.event = 'pull_request' }, value => { value.event.workflow_run.head_repository.full_name = 'fork/Mikka' },
    value => { value.event.workflow_run.head_sha = 'main\nprivate' }, value => { value.event.workflow_run.name = 'Task Secret scoped external acceptance' },
    value => { value.run.run_attempt++ }, value => { value.workflow.path = '.github/workflows/other.yml' },
    value => { value.run.conclusion = 'failure' }, value => { value.main.object.sha = OTHER },
    value => { value.environment.GITHUB_RUN_ATTEMPT = '3' },
    value => { value.environment.GITHUB_EVENT_NAME = 'workflow_dispatch'; value.environment.APPLICATION_SHA = OTHER }]) {
    const result = metadataFixture(t, mutate)
    assert.notEqual(result.status, 0); assert.equal(result.output, '')
    assert.equal(result.stderr.trim(), 'task_secret_source_refused')
    assert.ok(!(`${result.stdout}${result.stderr}`).includes(TOKEN))
  }
})

test('every OIDC read is directly preceded by source/attempt/public-build attestation and credentials stay scoped', () => {
  const beforeCheckout = workflowText.indexOf('Authenticate main and official upstream'), firstCheckout = workflowText.indexOf('uses: actions/checkout')
  assert.ok(beforeCheckout < firstCheckout)
  assert.match(workflowText, /workflow_run:\s+workflows: \[E2B additive runtime release\]/)
  assert.match(workflowText, /actions: read/)
  assert.doesNotMatch(workflowText, /actions: write|contents: write|pull-requests: write|issues: write|workflow_dispatch:\s+workflows/)
  const steps = workflowText.slice(workflowText.indexOf('  acceptance:')).split('\n  factory:')[0].split('      - name:')
  const credentials = steps.map((step, index) => ({ step, index })).filter(({ step }) => step.includes('Infisical/secrets-action'))
  assert.equal(credentials.length, 4)
  for (const { step, index } of credentials) {
    assert.match(steps[index - 1], /Recheck main, upstream attempt and public build immediately before/)
    assert.match(step, /identity-id: 2cf9fa19-b9db-4c08-8ca0-b31859f2cbac/)
    assert.match(step, /recursive: false/); assert.match(step, /include-imports: false/)
  }
  const database = credentials.find(({ step }) => step.includes('secret-name: MIKKA_DATABASE_URL'))
  assert.ok(database)
  assert.match(database.step, /^\s*if: env\.ACCEPTANCE_MODE == 'execute' && env\.PRODUCTION_CANARY == 'true'\s*$/m)
  assert.match(steps[database.index - 1], /^\s*if: env\.ACCEPTANCE_MODE == 'execute' && env\.PRODUCTION_CANARY == 'true'\s*$/m)
  assert.match(workflowText, /PRODUCTION_CANARY: \$\{\{ github.event_name == 'workflow_dispatch' && inputs.production_canary && 'true' \|\| 'false' \}\}/)
  assert.match(workflowText, /group: production-smoke-owner-acceptance/)
  assert.ok(!JSON.stringify(safeCIFailure(Error('PRIVATE_SECRET_URL'))).includes('PRIVATE'))
})

test('the actual Factory job condition never turns preflight or a single-model manual request into writes', () => {
  const factory = workflowText.split('\n  factory:')[1]
  assert.ok(factory)
  const expression = /^    if: >-\n((?:      [^\n]*\n)+)/m.exec(factory)?.[1]
  assert.ok(expression)
  const selected = (eventName, inputs, authorized = 'true') => runInNewContext(expression.trim(), {
    needs: { authorize: { outputs: { selected: authorized } } }, github: { event_name: eventName }, inputs,
  })
  assert.equal(selected('workflow_run', {}), true)
  assert.equal(selected('workflow_run', {}, 'false'), false)
  assert.equal(selected('workflow_dispatch', { mode: 'execute', model_case: 'all', factory_acceptance: true }), true)
  for (const inputs of [{ mode: 'preflight', model_case: 'all', factory_acceptance: true },
    { mode: 'execute', model_case: 'claude', factory_acceptance: true }, { mode: 'execute', model_case: 'codex', factory_acceptance: true },
    { mode: 'execute', model_case: 'all', factory_acceptance: false }, { mode: 'execute', model_case: 'all' }]) {
    assert.ok(!selected('workflow_dispatch', inputs))
  }
  assert.equal(selected('pull_request', { mode: 'execute', model_case: 'all', factory_acceptance: true }), false)
})

test('Factory uses only the original ACME credentials and real execute path, with fresh guards at both OIDC reads', () => {
  const factory = workflowText.split('\n  factory:')[1], native = workflowText.split('\n  acceptance:')[1].split('\n  factory:')[0]
  assert.match(factory, /group: run-trace-production-acceptance/)
  assert.match(factory, /MIKKA_OBSERVABILITY_MODEL_CASE: all/)
  assert.match(factory, /run: node scripts\/acceptance\/run-observability-workflow\.mjs --execute\n/)
  assert.match(factory, /production-run-observability-report\/report\.json/)
  assert.match(factory, /task-secrets-ci\.mjs prepare/)
  assert.match(factory, /factory-scope\.json/)
  assert.doesNotMatch(factory, /--prepare|--browser-submit|--runner-browser|MIKKA_ACCEPTANCE_PROGRESS_TOKEN|SMOKE_OWNER|E2B_API_KEY|issues: write|actions: write|contents: write/)
  assert.doesNotMatch(native, /ACME_DEMO/)
  const steps = factory.split('      - name:')
  const credentials = steps.map((step, index) => ({ step, index })).filter(({ step }) => step.includes('Infisical/secrets-action'))
  assert.equal(credentials.length, 2)
  for (const [{ step, index }, secret] of credentials.map((value, index) => [value, ['ACME_DEMO_EMAIL', 'ACME_DEMO_PASSWORD'][index]])) {
    assert.match(steps[index - 1], /Recheck Factory scope, main, upstream attempt and public build immediately before/)
    assert.ok(step.includes(`secret-name: ${secret}`))
    assert.match(step, /identity-id: 2cf9fa19-b9db-4c08-8ca0-b31859f2cbac/)
    assert.match(step, /secret-path: \/\n/); assert.match(step, /recursive: false/); assert.match(step, /include-imports: false/)
  }
  const base = { ...env(), ACCEPTANCE_MODE: 'execute', FACTORY_ACCEPTANCE_REQUESTED: 'true',
    TASK_SECRETS_MODEL_CASE: 'all', MIKKA_OBSERVABILITY_MODEL_CASE: 'all', MIKKA_EXPECTED_DEPLOYMENT_SHA: SHA }
  assert.match(factoryAcceptanceScope(base).workspaceSelection, /without_restoring_previous_selection$/)
  for (const patch of [{ FACTORY_ACCEPTANCE_REQUESTED: 'false' }, { ACCEPTANCE_MODE: 'preflight' },
    { TASK_SECRETS_MODEL_CASE: 'claude' }, { MIKKA_OBSERVABILITY_MODEL_CASE: 'codex' }, { MIKKA_EXPECTED_DEPLOYMENT_SHA: OTHER },
    { SMOKE_OWNER_EMAIL: 'PRIVATE' }, { SMOKE_OWNER_PASSWORD: 'PRIVATE' }, { MIKKA_ACCEPTANCE_PROGRESS_TOKEN: 'PRIVATE' },
    { ACCEPTANCE_PREPARE: 'true' }, { ACCEPTANCE_BROWSER_SUBMIT: 'true' }, { MIKKA_ACCEPTANCE_BASE_URL: 'https://foreign.invalid' }]) {
    assert.throws(() => factoryAcceptanceScope({ ...base, ...patch }), /factory_scope/)
  }
})

test('the existing Factory wrapper executes without a progress token, browser, GitHub request or credential alias', async () => {
  const child = new EventEmitter(), signals = new EventEmitter()
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true
  let launched
  const result = runObservabilityWorkflow({ args: ['--execute'], env: {
    ...env(), ACME_DEMO_EMAIL: 'synthetic-acme@example.invalid', ACME_DEMO_PASSWORD: 'synthetic-acme-password',
    MIKKA_EXPECTED_DEPLOYMENT_SHA: SHA, MIKKA_OBSERVABILITY_MODEL_CASE: 'all',
  }, signals, writeOutput: () => {}, spawnImpl: (_command, argv, settings) => { launched = { argv, settings }; return child },
  fetchImpl: () => { assert.fail('non-browser execution must not post comments') },
  startBrowserImpl: () => { assert.fail('Factory artifact execution does not start a browser') } })
  assert.deepEqual(launched.argv.slice(1), ['--execute'])
  assert.equal(launched.settings.env.ACME_DEMO_EMAIL, 'synthetic-acme@example.invalid')
  assert.equal(launched.settings.env.ACME_DEMO_PASSWORD, 'synthetic-acme-password')
  assert.equal(launched.settings.env.SMOKE_OWNER_EMAIL, undefined)
  assert.equal(launched.settings.env.SMOKE_OWNER_PASSWORD, undefined)
  assert.equal(launched.settings.env.GITHUB_TOKEN, undefined)
  assert.equal(launched.settings.env.MIKKA_ACCEPTANCE_PROGRESS_TOKEN, undefined)
  child.stdout.write('Result: runtime_verified\n'); child.stdout.end(); child.stderr.end()
  queueMicrotask(() => child.emit('close', 0, null))
  assert.equal(await result, 0)
})

/** Exercise prepare/attest with a real clean two-commit checkout and real ZIP
 * parsing/worker hashing. Only network reads are replaced by closed fixtures. */
test('real CI CLI binds artifact bytes then refuses changed source/attempt/public build before credentials', t => {
  const directory = mkdtempSync(join(tmpdir(), 'task-secrets-cli-')), root = join(directory, 'repo'), temp = join(directory, 'runner')
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  mkdirSync(root); mkdirSync(temp)
  for (const file of ['scripts/acceptance/task-secrets-ci.mjs', 'scripts/acceptance/thread-lifecycle-ci.mjs',
    'scripts/release/web-deploy.mjs', 'scripts/ci-docs-only.mjs', 'scripts/cloudflare-source.mjs',
    'scripts/e2b/runtime-report.mjs', 'scripts/e2b/build-template.py']) {
    const target = join(root, file); mkdirSync(dirname(target), { recursive: true }); copyFileSync(new URL('../../' + file, import.meta.url), target)
  }
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git(['init', '--quiet']); git(['add', '.']); git(['-c', 'user.name=CI fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture base'])
  mkdirSync(join(root, 'lib/secrets'), { recursive: true }); writeFileSync(join(root, 'lib/secrets/runtime.ts'), '// synthetic changed source\n')
  git(['add', '.']); git(['-c', 'user.name=CI fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture secret change'])
  const source = git(['rev-parse', 'HEAD'])
  const worker = execFileSync('python3', ['scripts/e2b/build-template.py', '--worker-hash', '--source-ref', source], { cwd: root, encoding: 'utf8' }).trim()
  const archive = zip([{ name: 'release.json', value: JSON.stringify(report(source, worker)) }])
  const f = responseFixture(); f.run.head_sha = source; f.main.object.sha = source
  f.jobs.jobs.forEach(row => { row.head_sha = source })
  f.artifact = artifact(archive); f.artifact.workflow_run.head_sha = source; f.listing = { total_count: 1, artifacts: [f.artifact] }
  f.publicBuild = source; f.archive = archive.toString('base64')
  const fixturePath = join(directory, 'fixture.json'), eventPath = join(directory, 'event.json'), output = join(directory, 'output'), environment = join(directory, 'env')
  writeFileSync(eventPath, JSON.stringify({ workflow_run: f.run })); writeFileSync(output, ''); writeFileSync(environment, '')
  const bootstrap = join(directory, 'fetch.mjs')
  writeFileSync(bootstrap, `import{readFileSync}from'node:fs';const f=JSON.parse(readFileSync(process.env.FIXTURE_PATH));globalThis.fetch=async(url,o)=>{\n`
    + `if((o.method??'GET')!=='GET')throw Error('write_refused');if(url==='https://productionresultssa12.blob.core.windows.net/result'){if(o.headers)throw Error('token_forwarded');return new Response(Buffer.from(f.archive,'base64'))}\n`
    + `if(url==='https://app.aspectlylabs.com/mikka/api/version')return Response.json({build:f.publicBuild});if(o.headers.authorization!=='Bearer ${TOKEN}')throw Error('token_missing');\n`
    + `if(url==='${IMMUTABLE_API}/actions/artifacts/321/zip')return new Response(null,{status:302,headers:{location:'https://productionresultssa12.blob.core.windows.net/result'}});\n`
    + `const routes={'${IMMUTABLE_API}/actions/workflows/e2b-official-runtime.yml':f.workflow,'${IMMUTABLE_API}/actions/runs/123':f.run,'${IMMUTABLE_API}/git/ref/heads/main':f.main,'${IMMUTABLE_API}/actions/runs/123/attempts/2/jobs?per_page=100':f.jobs,'${IMMUTABLE_API}/actions/runs/123/artifacts?per_page=100':f.listing,'${IMMUTABLE_API}/actions/artifacts/321':f.artifact};if(!Object.hasOwn(routes,url))throw Error('route_refused');return Response.json(routes[url])};\n`)
  const cliEnv = { PATH: process.env.PATH, ...env(), GITHUB_SHA: source, APPLICATION_SHA: source, EXPECTED_SOURCE_SHA: source,
    EXPECTED_WORKER_SHA: worker, EXPECTED_WORKER_SOURCE_SHA: source, RUNNER_TEMP: temp, FIXTURE_PATH: fixturePath,
    GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: output, GITHUB_ENV: environment }
  const invoke = command => {
    writeFileSync(fixturePath, JSON.stringify(f))
    return spawnSync(process.execPath, ['--import', bootstrap, join(root, 'scripts/acceptance/task-secrets-ci.mjs'), command],
      { cwd: root, env: cliEnv, encoding: 'utf8' })
  }
  const prepared = invoke('prepare'); assert.equal(prepared.status, 0, prepared.stderr)
  assert.match(readFileSync(environment, 'utf8'), new RegExp(`EXPECTED_WORKER_SHA=${worker}`))
  const attested = invoke('attest'); assert.equal(attested.status, 0, attested.stderr)
  assert.equal(JSON.parse(readFileSync(join(temp, 'task-secrets-ci/attestation.json'))).publicBuild, source)
  for (const mutate of [() => { f.publicBuild = OTHER }, () => { f.run.run_attempt++ }, () => { f.main.object.sha = OTHER },
    () => { f.artifact.digest = 'sha256:' + 'f'.repeat(64) }]) {
    const saved = structuredClone(f); mutate()
    const refused = invoke('attest'); assert.notEqual(refused.status, 0)
    assert.doesNotMatch(refused.stdout + refused.stderr, /synthetic-private|PRIVATE|Bearer /)
    Object.assign(f, saved)
  }
  writeFileSync(join(root, 'lib/secrets/runtime.ts'), '// uncommitted change\n')
  assert.notEqual(invoke('attest').status, 0, 'dirty checkout never receives a receipt')
})
