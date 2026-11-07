import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { assertConservation, currentWorkerSha, pairEnv, publish, runtimeConfigurationSha, PROJECT, TEAM } from './publish-template-env.mjs'
import * as webRelease from '../release/web-deploy.mjs'
import * as runtimePublisher from './publish-template-env.mjs'

const SHA = 'a'.repeat(40), COMMIT = 'b'.repeat(40), OTHER = 'c'.repeat(40)
const report = harness => ({ harness, installed: true, version: null, models: ['fixture-model'] })
const MODELS = { desktop: [report('claude_code'), report('codex')], claude: [report('claude_code')], codex: [report('codex')] }
const TEMPLATES = { desktop: 'tpl-desktop', claude: 'tpl-claude', codex: 'tpl-codex' }
const PROOF = { entries: 100, sha256: 'd'.repeat(64) }
const POLICY_SHA = createHash('sha256').update(readFileSync(new URL('./e2b-finalization-files.json', import.meta.url))).digest('hex')
const SHARED = { verified: true, access: 'workspace_share', requesterHash: '1'.repeat(16), payerHash: '2'.repeat(16), workspaceHash: '3'.repeat(64),
  connectionHash: '4'.repeat(16), bindingHash: '5'.repeat(16), connectionRevision: '2', profileVersion: 1, profileDigest: '6'.repeat(64) }
const conservation = kind => ({ before: PROOF, after: PROOF, finalization: {
  kind, policySha256: POLICY_SHA, before: PROOF, after: PROOF, originalBefore: PROOF, originalAfter: PROOF, providerChanges: [],
} })
const EVIDENCE = { sourceCommit: COMMIT, workerSha: SHA, acceptanceScope: { account: 'shared_smoke', workspaceRestored: true,
  requesterHash: SHARED.requesterHash, payerHash: SHARED.payerHash,
  team: { teamWorkspaceConfirmed: true, teamAdminMembershipVerified: true, teamWorkspaceHash: SHARED.workspaceHash } },
  templates: Object.fromEntries(Object.entries(TEMPLATES).map(([kind, templateId]) => [kind, {
  templateId, buildId: `build-${kind}`, baseTemplate: kind, preinstalled: true, public: true, buildStatus: 'ready',
  conservation: conservation(kind), models: MODELS[kind],
}])), subscriptionAcceptance: Object.fromEntries([['claude', 'claude_code', 'claude-haiku-5-5'], ['codex', 'codex', 'gpt-6-luna']].map(([kind, harness, model]) => [kind, {
  status: 'passed', templateId: TEMPLATES[kind], sourceCommit: COMMIT, workerSha: SHA, harness, model,
  credentialRoute: 'subscription', replyVerified: true, runId: `run-${kind}`, deviceId: `device-${kind}`,
  replyVerifiedAfterTool: true, toolEvidence: { toolCallHash: 'd'.repeat(16), outcome: 'ok' },
  officialBinarySha256: 'e'.repeat(64), officialCliVersion: 'fixture-version',
  agentAcceptance: { runIdHash: createHash('sha256').update(`run-${kind}`).digest('hex').slice(0, 16), harness,
    kind: harness === 'claude_code' ? 'claude_user_ack' : 'codex_turn_start_ack', at: 1100, ms: 100 },
  runtimeAuthorization: { source: 'http_server_link', complete: true, truncated: false, extraRemoteCalls: 0 },
  sharedScope: { ...SHARED },
}])) }
const STORED = Object.fromEntries(pairEnv({ templates: TEMPLATES, sourceSha: SHA, sourceCommit: COMMIT, models: MODELS }).map(row => [row.key, row.value]))
STORED.MIKKA_CLOUD_WORKER_SOURCE_COMMIT = COMMIT
const OLD_STORED = Object.fromEntries(pairEnv({ templates: TEMPLATES, sourceSha: OTHER, sourceCommit: OTHER, models: MODELS }).map(row => [row.key, row.value]))
OLD_STORED.MIKKA_CLOUD_WORKER_SOURCE_COMMIT = OTHER

test('large complete runtime receipts cross the process boundary by file without env truncation', () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-receipt-'))
  try {
    const file = join(root, 'release.json'), evidence = structuredClone(EVIDENCE)
    evidence.templates.claude.conservation.providerManifest = Array.from({ length: 5000 }, (_, index) => ({ path: `official/file-${index}`, sha256: 'd'.repeat(64) }))
    const bytes = JSON.stringify(evidence)
    assert.ok(Buffer.byteLength(bytes) > 310410, 'regress the actual execve per-env limit, preserving the whole proof')
    writeFileSync(file, bytes)
    assert.deepEqual(runtimePublisher.readReleaseEvidenceFile(file), evidence)
    const module = new URL('./publish-template-env.mjs', import.meta.url).href
    const child = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { readReleaseEvidenceFile } from ${JSON.stringify(module)}; import { createHash } from 'node:crypto'; const data=JSON.stringify(readReleaseEvidenceFile(process.env.RUNTIME_RELEASE_EVIDENCE_FILE)); console.log(createHash('sha256').update(data).digest('hex'))`],
    { env: { RUNTIME_RELEASE_EVIDENCE_FILE: file }, encoding: 'utf8' })
    assert.equal(child.status, 0, child.stderr)
    assert.equal(child.stdout.trim(), createHash('sha256').update(bytes).digest('hex'))
    writeFileSync(file, '{private-broken-json')
    assert.throws(() => runtimePublisher.readReleaseEvidenceFile(file), /runtime_release_file_invalid/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('candidate, cleanup and queued Web publication all transfer full evidence through artifacts', () => {
  const builder = readFileSync(new URL('../../.github/workflows/e2b-template.yml', import.meta.url), 'utf8')
  const gate = readFileSync(new URL('../../.github/workflows/e2b-official-runtime.yml', import.meta.url), 'utf8')
  const web = readFileSync(new URL('../../.github/workflows/web-deploy.yml', import.meta.url), 'utf8')
  assert.doesNotMatch(builder, /candidate-report=\$\{JSON\.stringify\(report\)\}/)
  assert.match(builder, /candidate-report-artifact-id: \$\{\{ steps\.candidate-report\.outputs\.artifact-id \}\}/)
  assert.equal((gate.match(/artifact-ids: \$\{\{ needs\.validate\.outputs\.candidate-report-artifact-id \}\}/g) ?? []).length, 2)
  assert.doesNotMatch(gate, /CANDIDATE_REPORT:|process\.env\.CANDIDATE_REPORT|release-evidence=\$\{JSON\.stringify\(report\)\}/)
  assert.match(gate, /runtime-release-evidence-artifact-id: \$\{\{ needs\.subscriptions\.outputs\.release-evidence-artifact-id \}\}/)
  assert.match(web, /artifact-ids: \$\{\{ inputs\.runtime-release-evidence-artifact-id \}\}/)
  assert.match(web, /RUNTIME_RELEASE_EVIDENCE_FILE: \$\{\{ runner\.temp \}\}\/runtime-release\/release\.json/)
  assert.doesNotMatch(web, /RUNTIME_RELEASE_EVIDENCE:/)
})

test('failed artifact downloads never pass a partial JSON file into the strict cleanup parser', () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-cleanup-transport-'))
  try {
    const workflow = readFileSync(new URL('../../.github/workflows/e2b-official-runtime.yml', import.meta.url), 'utf8')
    const step = workflow.split('      - name: Close this attempt\'s instances and remove only its private candidates\n')[1].split('      - name:')[0]
    const run = /        run: (.*)/.exec(step)[1]
    const command = run === '|' ? step.split('        run: |\n')[1].split('        env:')[0].replace(/^          /gm, '') : run.slice(1, -1)
    const bin = join(root, 'e2b-cleanup/bin'), argsFile = join(root, 'args.json')
    mkdirSync(bin, { recursive: true }); mkdirSync(join(root, 'runtime-candidates'))
    writeFileSync(join(root, 'runtime-candidates/candidates.json'), '{partial')
    writeFileSync(join(bin, 'python'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.ARGS_FILE, JSON.stringify(process.argv.slice(2)))\n`, { mode: 0o700 })
    for (const outcome of ['failure', 'skipped', 'success']) {
      const child = spawnSync('/bin/bash', ['-e', '-c', command], { encoding: 'utf8',
        env: { RUNNER_TEMP: root, CANDIDATE_DOWNLOAD_OUTCOME: outcome, ARGS_FILE: argsFile } })
      assert.equal(child.status, 0, child.stderr)
      const args = JSON.parse(readFileSync(argsFile, 'utf8'))
      assert.equal(args.includes('--report'), outcome === 'success', `${outcome} must select the correct exact-attempt cleanup path`)
      assert.equal(args[0], 'scripts/e2b/cleanup-template-candidates.py')
      assert.ok(args.includes('--output'))
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('conservation requires both strict installation and exact provider-only finalization changes', () => {
  const proof = conservation('claude')
  proof.finalization.providerChanges.push({ path: '/.e2b', before: { sha256: 'a'.repeat(64) }, after: { sha256: 'b'.repeat(64) } })
  assert.doesNotThrow(() => assertConservation(proof, 'claude'))
  for (const mutate of [
    value => { delete value.finalization },
    value => { value.after = { ...PROOF, sha256: 'e'.repeat(64) } },
    value => { value.finalization.providerChanges[0].path = '/usr/local/bin/codex' },
    value => { value.finalization.providerChanges[0] = { path: '/.e2b', before: { uid: 0 }, after: { uid: 1000 } } },
    value => { value.finalization.providerChanges[0] = { path: '/usr/local/share/e2b/ssl-certs.tar', before: { mode: 420 }, after: { mode: 438 } } },
    value => { value.finalization.originalBefore = { ...PROOF, sha256: 'e'.repeat(64) } },
  ]) {
    const invalid = structuredClone(proof); mutate(invalid)
    assert.throws(() => assertConservation(invalid, 'claude'), /runtime_release_conservation_invalid/)
  }
})

test('certificate conversion proof fixes the original bytes and exact link target', () => {
  const certificate = JSON.parse(readFileSync(new URL('./e2b-certificate-relinks.json', import.meta.url)))
    .find(row => row.templates.includes('claude') && !row.providerRoot)
  const proof = conservation('claude')
  proof.finalization.providerChanges = [{ path: certificate.path, kind: 'file',
    before: { kind: 'file', mode: 420, sha256: certificate.sha256, target: null },
    after: { kind: 'link', mode: 511, sha256: null, target: certificate.target }, resolvedSha256: certificate.sha256 }]
  assert.doesNotThrow(() => assertConservation(proof, 'claude'))
  for (const mutate of [
    row => { row.after.target = '/opt/mikka/replaced.crt' },
    row => { row.resolvedSha256 = 'a'.repeat(64) },
    row => { delete row.resolvedSha256 },
    row => { row.path = '/etc/ssl/certs/unobserved.pem' },
    row => { row.before.sha256 = 'a'.repeat(64) },
  ]) {
    const invalid = structuredClone(proof); mutate(invalid.finalization.providerChanges[0])
    assert.throws(() => assertConservation(invalid, 'claude'), /runtime_release_conservation_invalid/)
  }
})

function fixture(options = {}) {
  const calls = [], logs = [], stored = { ...(options.stored ?? STORED), ...(options.previous ? { MIKKA_CLOUD_RUNTIME_PREVIOUS: options.previous } : {}) }
  let wrote = false, mainReads = 0, uncertain = options.uncertainPost === true
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input), method = init.method ?? 'GET'
    calls.push({ origin: url.origin, method, path: url.pathname, search: url.search, body: init.body && JSON.parse(init.body) })
    if (url.origin === 'https://api.github.com') {
      assert.equal(method, 'GET')
      assert.equal(init.headers.authorization, 'Bearer github-read-fixture')
      mainReads++
      return Response.json({ object: { type: 'commit', sha: mainReads > 1 ? options.afterReadsMain ?? options.currentMain ?? COMMIT : options.currentMain ?? COMMIT } })
    }
    if (url.origin === 'https://app.aspectlylabs.com') {
      assert.equal(init.headers.authorization, undefined)
      return Response.json({ build: options.publicBuild ?? COMMIT })
    }
    assert.equal(url.origin, 'https://api.vercel.com')
    assert.equal(url.searchParams.get('teamId'), TEAM)
    assert.equal(init.headers.authorization, 'Bearer vercel-fixture')
    if (url.pathname.startsWith('/v4/aliases/')) {
      assert.equal(url.searchParams.get('projectId'), PROJECT)
      return Response.json({ deploymentId: 'dpl_live' })
    }
    if (url.pathname === '/v13/deployments/dpl_live') return Response.json({ meta: { githubCommitSha: options.aliasBuild ?? COMMIT } })
    if (method === 'POST' && url.pathname.endsWith('/env')) {
      wrote = true
      for (const row of JSON.parse(init.body)) if (!options.stored || !(row.key in options.stored)) stored[row.key] = row.value
      if (uncertain) { uncertain = false; throw Error('fixture response lost after mutation') }
      if (options.postStatus) return new Response('private-response-marker', { status: options.postStatus })
      return Response.json({ created: [] })
    }
    const source = wrote || options.unchanged ? stored : options.before ?? OLD_STORED
    if (url.pathname.endsWith('/env')) return Response.json({ envs: Object.keys(stored).flatMap(key => [
      { id: `preview-${key}`, key, target: ['preview'] },
      { id: `branch-${key}`, key, target: ['production'], gitBranch: 'other' },
      { id: `id-${key}`, key, target: ['production'] },
    ]) })
    if (url.pathname.includes('/env/id-')) return Response.json({ value: source[url.pathname.split('/env/id-')[1]] })
    assert.fail(`unexpected release request ${method} ${url.pathname}`)
  }
  const run = extra => publish({ token: 'vercel-fixture', githubToken: 'github-read-fixture', templates: TEMPLATES,
    sourceSha: SHA, sourceCommit: COMMIT, models: MODELS, releaseEvidence: EVIDENCE, fetchImpl, log: message => logs.push(message), ...extra })
  return { calls, logs, fetchImpl, run, stored }
}

test('verified versioned templates, worker and previous release go to production in one upsert', async () => {
  const fake = fixture()
  assert.deepEqual(await fake.run(), { changed: true, requiresWebBuild: true, sourceCommit: COMMIT, workerSha: SHA })
  const writes = fake.calls.filter(call => call.method === 'POST')
  assert.equal(writes.length, 1)
  assert.equal(writes[0].path, `/v10/projects/${PROJECT}/env`)
  assert.match(writes[0].search, /upsert=true/)
  assert.deepEqual(writes[0].body.map(row => [row.key, row.value, row.target]), Object.entries({ ...STORED, MIKKA_CLOUD_RUNTIME_PREVIOUS: JSON.stringify({ version: 1, configuration: OLD_STORED }) }).map(([key, value]) => [key, value, ['production']]))
  assert.equal(fake.calls.filter(call => call.path.includes('/env/id-')).length, 13, 'read current configuration and verify new configuration plus rollback receipt')
  assert.doesNotMatch(fake.logs.join('\n'), /fixture-model|vercel-fixture|github-read-fixture/)
})

test('runtime configuration never asks Vercel to rebuild source; the caller must use Web deploy', async () => {
  const fake = fixture()
  await fake.run()
  assert.equal(fake.calls.filter(call => call.method === 'POST' && call.path === '/v13/deployments').length, 0)
  assert.equal(fake.calls.filter(call => call.method === 'POST' && call.path.endsWith('/env')).length, 1)
})

test('an explicit refresh still requires a Web build after an earlier env write succeeded', async () => {
  const fake = fixture({ unchanged: true })
  assert.deepEqual(await fake.run(), { changed: false, requiresWebBuild: true, sourceCommit: COMMIT, workerSha: SHA })
  assert.equal(fake.calls.filter(call => call.method === 'POST').length, 0)
})

test('a readback mismatch fails before the caller can build', async () => {
  const fake = fixture({ stored: { ...STORED, E2B_CODEX_TEMPLATE: 'old' } })
  await assert.rejects(fake.run(), /env_not_updated E2B_CODEX_TEMPLATE/)
  assert.equal(fake.calls.filter(call => call.method === 'POST').length, 1)
})

test('an uncertain mutation is never retried; an explicit rerun reads it and still requires a build', async () => {
  const fake = fixture({ uncertainPost: true })
  await assert.rejects(fake.run(), error => {
    assert.match(error.message, /vercel_api_unavailable POST/)
    assert.doesNotMatch(error.message, /fixture response lost after mutation/)
    return true
  })
  assert.equal(fake.calls.filter(call => call.method === 'POST').length, 1)
  assert.equal((await fake.run()).requiresWebBuild, true)
  assert.equal(fake.calls.filter(call => call.method === 'POST').length, 1)
})

test('an HTTP mutation error has one attempt and never exposes the response body', async () => {
  const fake = fixture({ postStatus: 503 })
  await assert.rejects(fake.run(), error => {
    assert.match(error.message, /vercel_api_http_503 POST/)
    assert.doesNotMatch(error.message, /private-response-marker/)
    return true
  })
  assert.equal(fake.calls.filter(call => call.method === 'POST').length, 1)
})

test('main advancing during configuration reads prevents the single env mutation', async () => {
  const fake = fixture({ afterReadsMain: OTHER })
  await assert.rejects(fake.run(), /mainChanged/)
  assert.equal(fake.calls.filter(call => call.method === 'POST').length, 0)
})

test('obsolete refreshes fail even when their old runtime env already matches', async () => {
  const fake = fixture({ unchanged: true, currentMain: OTHER })
  await assert.rejects(fake.run(), /mainChanged/)
  assert.equal(fake.calls.filter(call => call.origin === 'https://api.vercel.com').length, 0)
})

test('a different serving alias or public version prevents every configuration write', async () => {
  for (const options of [{ aliasBuild: OTHER }, { publicBuild: OTHER }]) {
    const fake = fixture(options)
    await assert.rejects(fake.run(), /production_source_changed/)
    assert.equal(fake.calls.filter(call => call.method === 'POST').length, 0)
  }
})

test('does not search past a newer application for an older matching READY deployment', async () => {
  const fake = fixture({ aliasBuild: OTHER })
  await assert.rejects(fake.run(), /production_source_changed/)
  assert.equal(fake.calls.filter(call => call.path === '/v6/deployments').length, 0)
  assert.equal(fake.calls.filter(call => call.method === 'POST').length, 0)
})

test('refuses missing or short source identities and candidate mismatches before requests', async () => {
  for (const extra of [{ sourceCommit: undefined }, { sourceCommit: 'short' }, { templates: { ...TEMPLATES, codex: 'private-old' } }]) {
    const fake = fixture()
    await assert.rejects(fake.run(extra), /official_source_commit_invalid|runtime_release_template_invalid/)
    assert.equal(fake.calls.length, 0)
  }
})

test('pair validation still rejects short worker SHA, odd or missing template IDs and unmeasured harnesses', () => {
  assert.throws(() => pairEnv({ templates: TEMPLATES, sourceSha: 'abc1234' }), /source_sha_invalid/)
  assert.throws(() => pairEnv({ templates: { ...TEMPLATES, claude: 'a/b' }, sourceSha: SHA }), /template_id_invalid claude/)
  assert.throws(() => pairEnv({ templates: { desktop: 'tpl1', claude: 'tpl2' }, sourceSha: SHA }), /template_id_invalid codex/)
  assert.throws(() => pairEnv({ templates: TEMPLATES, sourceSha: SHA }), /template_models_invalid/)
  assert.throws(() => pairEnv({ templates: TEMPLATES, sourceSha: SHA, models: { ...MODELS, desktop: [report('codex')] } }), /template_models_missing desktop claude_code/)
})

test('only a complete matching runtime tuple returns the current worker hash', async () => {
  assert.equal(await currentWorkerSha({ token: 'vercel-fixture', fetchImpl: fixture({ unchanged: true }).fetchImpl }), SHA)
  assert.equal(await currentWorkerSha({ token: 'vercel-fixture', fetchImpl: fixture({ stored: {} }).fetchImpl }), '')
  for (const partial of [
    { ...STORED, E2B_CODEX_TEMPLATE: 'other-template' },
    { ...STORED, MIKKA_CLOUD_WORKER_SHA: OTHER },
    { ...STORED, MIKKA_CLOUD_WORKER_SOURCE_COMMIT: OTHER },
    { ...STORED, MIKKA_CLOUD_TEMPLATE_MODELS: '{}' },
  ]) {
    assert.equal(await currentWorkerSha({ token: 'vercel-fixture', fetchImpl: fixture({ unchanged: true, stored: partial }).fetchImpl }), '')
  }
})

test('repairing a partial upsert keeps the last valid rollback snapshot', async () => {
  const previous = JSON.stringify({ version: 1, configuration: OLD_STORED })
  const fake = fixture({ before: { ...OLD_STORED, MIKKA_CLOUD_WORKER_SHA: SHA }, previous })
  assert.equal((await fake.run()).changed, true)
  const write = fake.calls.find(call => call.method === 'POST')
  assert.equal(write.body.some(row => row.key === 'MIKKA_CLOUD_RUNTIME_PREVIOUS'), false)
  assert.equal(fake.stored.MIKKA_CLOUD_RUNTIME_PREVIOUS, previous)
  assert.equal(runtimeConfigurationSha(fake.stored), SHA)
})

test('a valid legacy official catalogue can be backed up while requiring fresh validation', async () => {
  const legacy = Object.fromEntries(pairEnv({ templates: { desktop: 'desktop', claude: 'claude', codex: 'codex' }, sourceSha: OTHER, models: MODELS }).map(row => [row.key, row.value]))
  legacy.MIKKA_CLOUD_WORKER_SOURCE_COMMIT = OTHER
  const catalogue = JSON.parse(legacy.MIKKA_CLOUD_TEMPLATE_MODELS)
  for (const row of Object.values(catalogue.templates)) { delete row.baseTemplate; delete row.preinstalled }
  legacy.MIKKA_CLOUD_TEMPLATE_MODELS = JSON.stringify(catalogue)
  assert.equal(runtimeConfigurationSha(legacy), '')
  assert.equal(runtimeConfigurationSha(legacy, { allowLegacy: true }), OTHER)
  const fake = fixture({ before: legacy })
  await fake.run()
  const previous = fake.calls.find(call => call.method === 'POST').body.find(row => row.key === 'MIKKA_CLOUD_RUNTIME_PREVIOUS')
  assert.deepEqual(JSON.parse(previous.value), { version: 1, configuration: legacy })
})

test('GitHub-only build timeline waits for source upload before the single runtime env publication', async () => {
  let elapsed = 0, wrote = false, published
  const calls = []
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input), method = init.method ?? 'GET'
    calls.push({ origin: url.origin, path: url.pathname, method, at: elapsed })
    if (url.origin === 'https://api.github.com') {
      if (url.pathname.endsWith('/git/ref/heads/main')) return Response.json({ object: { type: 'commit', sha: COMMIT } })
      if (url.pathname.endsWith('/actions/workflows/web-deploy.yml/runs')) return Response.json({ workflow_runs: [{
        id: 70, run_attempt: 1, head_sha: COMMIT, head_branch: 'main', path: '.github/workflows/web-deploy.yml',
        repository: { full_name: 'alexj11324/Mikka' }, head_repository: { full_name: 'alexj11324/Mikka' }, event: 'push',
        status: elapsed < 200 ? 'in_progress' : 'completed', conclusion: elapsed < 200 ? null : 'success',
      }] })
      assert.equal(url.pathname, '/repos/alexj11324/Mikka/actions/runs/70/attempts/1/jobs')
      return Response.json({ total_count: 1, jobs: [{ name: 'deploy', head_sha: COMMIT, status: 'completed', conclusion: 'success',
        steps: ['Build (runs migrations last, as the Vercel build did)', 'Upload the prebuilt output to production',
          'Verify the public production version before releasing the deployment queue'].map(name => ({ name, status: 'completed', conclusion: 'success' })),
      }] })
    }
    if (url.origin === 'https://app.aspectlylabs.com') return Response.json({ build: elapsed < 300 ? OTHER : COMMIT })
    assert.equal(url.origin, 'https://api.vercel.com')
    if (method === 'POST' && url.pathname.endsWith('/env')) { wrote = true; published = Object.fromEntries(JSON.parse(init.body).map(row => [row.key, row.value])); return Response.json({ created: [] }) }
    const values = wrote ? published : { ...STORED, MIKKA_CLOUD_WORKER_SHA: OTHER }
    if (url.pathname.endsWith('/env')) return Response.json({ envs: Object.keys(values).map(key => ({ id: `id-${key}`, key, target: ['production'] })) })
    if (url.pathname.includes('/env/id-')) return Response.json({ value: values[url.pathname.split('/env/id-')[1]] })
    // Reproduce the observed gap: while GitHub is building there is NO Vercel
    // in-flight deployment, only the previous READY application. The legacy
    // orchestration fails production_source_changed here without waiting.
    if (url.pathname === '/v6/deployments') return Response.json({ deployments: [{ uid: 'dpl_live', name: 'mikka', state: 'READY',
      meta: { githubCommitSha: elapsed < 300 ? OTHER : COMMIT } }] })
    if (url.pathname.startsWith('/v4/aliases/')) return Response.json({ deploymentId: 'dpl_live' })
    if (url.pathname === '/v13/deployments/dpl_live') return Response.json({ meta: { githubCommitSha: elapsed < 300 ? OTHER : COMMIT } })
    assert.fail(`unexpected publication ${method} ${url.pathname}`)
  }
  // Run the same fixture with either checkout's actual orchestration. The
  // workflow contract test separately requires the new lock-free await step.
  const workflow = readFileSync(new URL('../../.github/workflows/e2b-official-runtime.yml', import.meta.url), 'utf8')
  if (workflow.includes('\n  await-web:')) await webRelease.waitForWebDeployment({ expectedBuild: COMMIT, token: 'github-read-fixture',
    fetchImpl, now: () => elapsed, wait: async ms => { elapsed += ms }, intervalMs: 100, maxWaitMs: 500 })
  const result = await publish({ token: 'vercel-fixture', githubToken: 'github-read-fixture', templates: TEMPLATES, sourceSha: SHA,
    sourceCommit: COMMIT, models: MODELS, releaseEvidence: EVIDENCE, fetchImpl, log: () => {}, wait: async ms => { elapsed += ms } })
  assert.equal(result.requiresWebBuild, true)
  assert.equal(elapsed, 300)
  assert.deepEqual(calls.filter(call => call.method === 'POST'), [{ origin: 'https://api.vercel.com', path: `/v10/projects/${PROJECT}/env`, method: 'POST', at: 300 }])
})


test('publication requires both real subscriptions on these exact candidates before any network request', async () => {
  for (const mutate of [
    evidence => { delete evidence.acceptanceScope },
    evidence => { evidence.acceptanceScope.account = 'owner_login' },
    evidence => { evidence.acceptanceScope.workspaceRestored = false },
    evidence => { evidence.subscriptionAcceptance.claude.sharedScope.payerHash = SHARED.requesterHash },
    evidence => { evidence.subscriptionAcceptance.codex.sharedScope.access = 'owner' },
    value => { delete value.subscriptionAcceptance.codex },
    value => { value.subscriptionAcceptance.claude.credentialRoute = 'api_key' },
    value => { value.subscriptionAcceptance.codex.model = 'other-model' },
    value => { value.subscriptionAcceptance.claude.workerSha = OTHER },
    value => { delete value.subscriptionAcceptance.codex.officialBinarySha256 },
    value => { value.subscriptionAcceptance.claude.agentAcceptance.kind = 'claude_system_init' },
    value => { value.subscriptionAcceptance.codex.agentAcceptance.runIdHash = 'f'.repeat(16) },
    value => { value.subscriptionAcceptance.codex.runtimeAuthorization.extraRemoteCalls = 1 },
    value => { delete value.subscriptionAcceptance.codex.replyVerifiedAfterTool },
    value => { value.subscriptionAcceptance.codex.replyVerifiedAfterTool = false },
    value => { delete value.subscriptionAcceptance.claude.toolEvidence },
    value => { value.subscriptionAcceptance.claude.toolEvidence.outcome = 'error' },
    value => { value.subscriptionAcceptance.claude.toolEvidence.toolCallHash = 'raw-id' },
    value => { value.subscriptionAcceptance.claude.toolEvidence.providerText = 'must-not-pass' },
    value => { value.templates.codex.models[0].models = ['unmeasured-model'] },
    value => { value.templates.desktop.conservation.after = { ...PROOF, sha256: 'e'.repeat(64) } },
    value => { value.templates.codex.public = false },
  ]) {
    const releaseEvidence = structuredClone(EVIDENCE)
    mutate(releaseEvidence)
    const fake = fixture()
    await assert.rejects(fake.run({ releaseEvidence }), /runtime_release_/)
    assert.equal(fake.calls.length, 0)
  }
})
