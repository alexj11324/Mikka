import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { assertConservation, assertReleaseEvidence, currentWorkerSha, pairEnv, publicationInputFromFile, publish, runtimeConfigurationSha, PROJECT, TEAM } from './publish-template-env.mjs'
import { reportDigest, templateModelsDigest } from './runtime-report.mjs'
import * as webRelease from '../release/web-deploy.mjs'

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
const ROOT_CA = '/usr/local/share/ca-certificates/e2b-ca.crt'
// Desktop is official-only artifact 13538924302; Claude is the d63 fresh-scan
// failure (42326876749 / 128264238545), not by itself a production gate pass.
// Codex is official-only control 42670291715/1, artifact 13697989038.
// Codex is the official-only ready/fresh observation in run 42670291715.
const ROOT_CA_ROTATIONS = {
  codex: ['713ed37b92f312cf89345677c1d7f413c55b38ca0c1c636ce0fecc672d08ed9a', '545244c4bc7f902ed9a6d843dd6ccaed08d0a59bbfc1b60064bd0278e026da5a'],
  desktop: ['7177f680c9c87f91ff9ab72a4409511cc4781d7c3dc549f302bfa17bd973b6b9', '88a5a279fec06a155bf9de1dd28abc93aae0f17db5f9febe69d5e25b15f8ff4d'],
  claude: ['fd1175201e861f159f0d6ae42523b0f5d754ade8a36d105e8b7110b180101862', '21899698fbaa1da5314e42bc049b146f16cddb2e7540822b2a15f009f8342996'],
}
const mcpTiming = (runId, harness) => ({ version: 1, source: 'mikka_mcp_physical_fetch', scope: 'observed_mikka_mcp_children',
  generationCoverage: 'unverified', allFirstPartyHttpComplete: false, remoteMcpServerCount: 0, childPathAuditVersion: 1,
  runIdHash: createHash('sha256').update(runId).digest('hex').slice(0, 16), harness, startedAt: 1010, endedAt: 1900,
  expectedChildren: 1, observedChildren: 1, closedChildren: 0, observedComplete: true, childLifecycleComplete: false,
  rejectedEvents: 0, truncated: false,
  children: [{ child: 1, startedAt: 1020, closedAt: null, lastSequence: 3, sent: 1, completed: 1, lost: 0 }],
  requests: [{ child: 1, sequence: 1, operation: 'decision_catalogue', startedAt: 1040, endedAt: 1050, durationMs: 10, status: 200, outcome: 'ok' }] })
const bootstrapAcceptance = (runId, harness) => {
  const base = { version: 1, runIdHash: createHash('sha256').update(runId).digest('hex').slice(0, 16), harness,
    outcome: 'ok', truncated: false }
  const source = harness === 'codex' ? 'bootstrap_codex_initialize' : 'bootstrap_claude_start'
  return { version: 1, runIdHash: base.runIdHash, harness, source, bootstrapSha256: '1'.repeat(64), hintSha256: '2'.repeat(64),
    startupTiming: { ...base, startedAt: 1200, endedAt: 1600, ms: 400, phases: [] },
    preparationTiming: { ...base, startedAt: 1000, endedAt: 1500, ms: 500, source,
      ...(harness === 'claude_code' ? { claimAuthentication: 'oauth_environment', observedAuthSource: 'oauth_environment' } : {}),
      phases: [{ name: 'daemon.adapter.cli_init.prewarm', startMs: 0, endMs: 300, ms: 300, outcome: 'ok' },
        { name: 'daemon.adapter.cli_init', startMs: 490, endMs: 500, ms: 10, outcome: 'ok' }] } }
}
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
  bootstrapAcceptance: bootstrapAcceptance('run-' + kind, harness),
  agentAcceptance: { runIdHash: createHash('sha256').update(`run-${kind}`).digest('hex').slice(0, 16), harness,
    kind: harness === 'claude_code' ? 'claude_user_ack' : 'codex_turn_start_ack', at: 1100, ms: 100 },
  runtimeAuthorization: { source: 'http_server_link', scope: 'daemon_http_server_link_and_task_fetch', complete: true, truncated: false, extraRemoteCalls: 0,
    hostAuthorizationComplete: true, basis: 'host_authorization_census_and_closed_mcp_business_paths', allFirstPartyHttpComplete: false,
    mcpHttpTiming: mcpTiming(`run-${kind}`, harness), observedProviderEvents: 1, officialDelivery: 'best_effort_not_a_complete_call_count' },
  sharedScope: { ...SHARED },
}])) }
const STORED = Object.fromEntries(pairEnv({ templates: TEMPLATES, sourceSha: SHA, sourceCommit: COMMIT, models: MODELS }).map(row => [row.key, row.value]))
STORED.MIKKA_CLOUD_WORKER_SOURCE_COMMIT = COMMIT
const OLD_STORED = Object.fromEntries(pairEnv({ templates: TEMPLATES, sourceSha: OTHER, sourceCommit: OTHER, models: MODELS }).map(row => [row.key, row.value]))
OLD_STORED.MIKKA_CLOUD_WORKER_SOURCE_COMMIT = OTHER

test('publication reads complete file evidence and retains independently bound models, templates and all gates', t => {
  const dir = mkdtempSync(join(tmpdir(), 'publication-report-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'release.json'), evidence = structuredClone(EVIDENCE)
  for (const [kind, row] of Object.entries(evidence.templates)) row.name = `mikka-${COMMIT.slice(0, 12)}-123-2-${kind}`
  evidence.templates.claude.conservation.providerManifest = Array.from({ length: 5000 }, (_, index) => ({ path: `official/file-${index}`, sha256: 'd'.repeat(64) }))
  const bytes = Buffer.from(JSON.stringify(evidence) + '\n')
  assert.ok(bytes.length > 310446, 'the combined shared/native proof retains the complete report beyond the failing env payload')
  writeFileSync(path, bytes)
  const expected = { sha256: reportDigest(bytes), modelsSha256: templateModelsDigest(evidence), templates: TEMPLATES,
    sourceSha: SHA, sourceCommit: COMMIT, runId: '123', runAttempt: '2' }
  const input = publicationInputFromFile(path, expected)
  assert.deepEqual(input.releaseEvidence, evidence)
  assert.deepEqual(input.models, MODELS)
  assert.doesNotThrow(() => assertReleaseEvidence(input))
  assert.throws(() => publicationInputFromFile(path, { ...expected, modelsSha256: 'a'.repeat(64) }), /models_digest_mismatch/)
  assert.throws(() => publicationInputFromFile(path, { ...expected, runAttempt: '3' }), /attempt_mismatch/)
  assert.throws(() => publicationInputFromFile(path, { ...expected, sha256: 'c'.repeat(64) }), /digest_mismatch/)
  assert.throws(() => assertReleaseEvidence(publicationInputFromFile(path, { ...expected, templates: { ...TEMPLATES, codex: 'other' } })), /template_invalid/)
  delete evidence.subscriptionAcceptance.claude
  const invalid = Buffer.from(JSON.stringify(evidence))
  writeFileSync(path, invalid)
  assert.throws(() => assertReleaseEvidence(publicationInputFromFile(path, { ...expected, sha256: reportDigest(invalid) })), /runtime_release_shared_scope_invalid claude/)
})

test('the publisher CLI reports a closed parse error without printing the report cause', t => {
  const dir = mkdtempSync(join(tmpdir(), 'publication-report-invalid-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'release.json'), bytes = Buffer.from('{"CANARY_REPORT_CONTENT":invalid}')
  writeFileSync(path, bytes)
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./publish-template-env.mjs', import.meta.url)), path], {
    encoding: 'utf8', env: { PATH: process.env.PATH, RUNTIME_REPORT_SHA256: reportDigest(bytes) },
  })
  assert.equal(result.status, 1)
  assert.equal(result.stderr.trim(), 'runtime_report_json_invalid')
  assert.doesNotMatch(result.stdout + result.stderr, /CANARY|release\.json/)
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

for (const [kind, [beforeSha, afterSha]] of Object.entries(ROOT_CA_ROTATIONS)) {
  test(`${kind} exact root CA rotation permits only finalization with an unchanged installation proof`, () => {
    for (const modeChanged of [false, true]) {
      const proof = conservation(kind)
      proof.finalization.originalAfter = { ...PROOF, sha256: 'e'.repeat(64) }
      proof.finalization.providerChanges = [{ path: ROOT_CA, kind: 'file',
        before: { sha256: beforeSha, ...(modeChanged ? { mode: 420 } : {}) },
        after: { sha256: afterSha, ...(modeChanged ? { mode: 511 } : {}) } }]
      assert.doesNotThrow(() => assertConservation(proof, kind))
      const invalid = structuredClone(proof)
      invalid.after = proof.finalization.originalAfter
      assert.throws(() => assertConservation(invalid, kind), /runtime_release_conservation_invalid/)
    }
  })
}

test('exact root CA publication rules preserve metadata and reject other certificate or CLI paths', () => {
  const [beforeSha, afterSha] = ROOT_CA_ROTATIONS.desktop
  const forbidden = [
    { before: { uid: 0 }, after: { uid: 1000 } },
    { before: { gid: 0 }, after: { gid: 1000 } },
    { before: { mode: 420 }, after: { mode: 438 } },
    { before: { kind: 'file', sha256: beforeSha, target: null }, after: { kind: 'link', sha256: null, target: '/opt/mikka/replaced.crt' } },
    { before: { kind: 'file', sha256: beforeSha, target: null }, after: { kind: 'link', sha256: null, target: ROOT_CA } },
    { before: { kind: 'file', sha256: beforeSha }, after: { kind: 'directory', sha256: null } },
  ]
  for (const kind of ['claude', 'desktop', 'codex']) {
    for (const fields of forbidden) {
      const proof = conservation(kind)
      proof.finalization.providerChanges = [{ path: ROOT_CA, kind: 'file', ...fields }]
      assert.throws(() => assertConservation(proof, kind), /runtime_release_conservation_invalid/)
    }
    for (const path of ['/usr/local/share/ca-certificates/unobserved.crt', '/usr/local/share/ca-certificates/e2b-ca.crt.backup',
      '/etc/ssl/certs/unobserved.crt', '/usr/local/bin/claude', '/usr/local/bin/codex']) {
      const proof = conservation(kind)
      proof.finalization.providerChanges = [{ path, kind: 'file', before: { sha256: beforeSha }, after: { sha256: afterSha } }]
      assert.throws(() => assertConservation(proof, kind), /runtime_release_conservation_invalid/)
    }
    for (const side of ['before', 'after']) {
      for (const value of [null, '', 'f'.repeat(63), 'g'.repeat(64), 'A'.repeat(64), 123]) {
        const proof = conservation(kind)
        const change = { path: ROOT_CA, kind: 'file', before: { sha256: beforeSha }, after: { sha256: afterSha } }
        change[side].sha256 = value
        proof.finalization.providerChanges = [change]
        assert.throws(() => assertConservation(proof, kind), /runtime_release_conservation_invalid/)
      }
    }
  }
  const codex = conservation('codex')
  codex.finalization.providerChanges = [{ path: ROOT_CA, kind: 'file', before: { sha256: beforeSha }, after: { sha256: afterSha } }]
  assert.doesNotThrow(() => assertConservation(codex, 'codex'))
  codex.finalization.providerChanges[0] = { path: ROOT_CA, kind: 'file', before: { mode: 420 }, after: { mode: 493 } }
  assert.throws(() => assertConservation(codex, 'codex'), /runtime_release_conservation_invalid/)
})

test('Codex root CA mode-only evidence requires the observed regular file and exact modes', () => {
  const proof = conservation('codex')
  proof.finalization.providerChanges = [{ path: ROOT_CA, kind: 'file', before: { mode: 420 }, after: { mode: 511 } }]
  assert.doesNotThrow(() => assertConservation(proof, 'codex'))
  for (const kind of ['directory', 'link', undefined]) {
    const invalid = structuredClone(proof)
    if (kind === undefined) delete invalid.finalization.providerChanges[0].kind
    else invalid.finalization.providerChanges[0].kind = kind
    assert.throws(() => assertConservation(invalid, 'codex'), /runtime_release_conservation_invalid/)
  }
  for (const [before, after] of [[384, 511], [416, 511], [420, 438], [420, 493], [511, 420]]) {
    const invalid = structuredClone(proof)
    invalid.finalization.providerChanges[0].before.mode = before
    invalid.finalization.providerChanges[0].after.mode = after
    assert.throws(() => assertConservation(invalid, 'codex'), /runtime_release_conservation_invalid/)
  }
  for (const kind of ['claude', 'desktop']) {
    assert.throws(() => assertConservation(proof, kind), /runtime_release_conservation_invalid/)
  }
})

test('Codex observed root CA mode-only finalization does not require a simultaneous digest change', () => {
  const proof = conservation('codex')
  proof.finalization.originalAfter = { ...PROOF, sha256: 'e'.repeat(64) }
  // The official pre_finalization -> ready pair keeps the same 713ed37b digest.
  // The producer reports only changed fields; its outer kind is the original kind.
  proof.finalization.providerChanges = [{ path: ROOT_CA, kind: 'file', before: { mode: 420 }, after: { mode: 511 } }]
  assert.doesNotThrow(() => assertConservation(proof, 'codex'))
})

for (const [kind, path, entryKind, beforeMode] of [
  ['claude', '/usr/local/share/e2b', 'directory', 493],
  ['codex', ROOT_CA, 'file', 420],
]) {
  test(`${kind} finalization requires the policy's original ${entryKind} kind`, () => {
    const proof = conservation(kind)
    proof.finalization.originalAfter = { ...PROOF, sha256: 'e'.repeat(64) }
    proof.finalization.providerChanges = [{ path, kind: entryKind, before: { mode: beforeMode }, after: { mode: 511 } }]
    assert.doesNotThrow(() => assertConservation(proof, kind))
    for (const invalidKind of [undefined, null, 'link', entryKind === 'file' ? 'directory' : 'file', 1]) {
      const invalid = structuredClone(proof)
      if (invalidKind === undefined) delete invalid.finalization.providerChanges[0].kind
      else invalid.finalization.providerChanges[0].kind = invalidKind
      assert.throws(() => assertConservation(invalid, kind), /runtime_release_conservation_invalid/,
        `reject original kind ${String(invalidKind)}`)
    }
  })
}

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
  const workflow = readFileSync(new URL('../../.github/workflows/e2b-runtime-release.yml', import.meta.url), 'utf8')
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
    value => { delete value.subscriptionAcceptance.codex.runtimeAuthorization.mcpHttpTiming },
    value => { value.subscriptionAcceptance.codex.runtimeAuthorization.mcpHttpTiming.runIdHash = 'f'.repeat(16) },
    value => { value.subscriptionAcceptance.codex.runtimeAuthorization.mcpHttpTiming.remoteMcpServerCount = 1 },
    value => { value.subscriptionAcceptance.codex.runtimeAuthorization.mcpHttpTiming.childLifecycleComplete = true },
    value => { value.subscriptionAcceptance.codex.runtimeAuthorization.mcpHttpTiming.requests[0].sequence = 2 },
    value => { value.subscriptionAcceptance.codex.runtimeAuthorization.mcpHttpTiming.requests[0].status = 503 },
    value => { value.subscriptionAcceptance.codex.runtimeAuthorization.allFirstPartyHttpComplete = true },
    value => { value.subscriptionAcceptance.codex.runtimeAuthorization.basis = 'all_mikka_http_sends_during_execution_counted' },
    value => { value.subscriptionAcceptance.codex.runtimeAuthorization.observedProviderEvents = 0 },
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

test('publication requires the same bounded bootstrap adoption proof after the native subscription passed', () => {
  for (const mutate of [
    row => { delete row.bootstrapAcceptance },
    row => { row.bootstrapAcceptance.preparationTiming.source = 'prepared_agent_start' },
    row => { row.bootstrapAcceptance.preparationTiming.claimAuthentication = 'ordinary_path' },
    row => { row.bootstrapAcceptance.preparationTiming.observedAuthSource = 'oauth_descriptor' },
    row => { row.bootstrapAcceptance.preparationTiming.phases.push({ ...row.bootstrapAcceptance.preparationTiming.phases[0] }) },
    row => { row.bootstrapAcceptance.runIdHash = 'f'.repeat(16) },
    row => { row.bootstrapAcceptance.hintSha256 = '' },
    row => { row.bootstrapAcceptance.preparationTiming.phases[0].outcome = 'error' },
  ]) {
    const value = structuredClone(EVIDENCE); mutate(value.subscriptionAcceptance.claude)
    assert.throws(() => assertReleaseEvidence({ sourceCommit: COMMIT, sourceSha: SHA, templates: TEMPLATES, models: MODELS,
      releaseEvidence: value }), /runtime_release_subscription_missing claude/)
  }
})
