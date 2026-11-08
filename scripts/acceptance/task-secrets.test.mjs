import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readOptions, nativeCommand, nativeReceipt, productionCanaryPlan, runTaskSecretsAcceptance, safeFailure } from './task-secrets.mjs'
import { nativeScope, nativeGitProof, scanCanary } from './task-secrets-native.mjs'
import { buildFixtureBundles, createIsolatedFixture } from './task-secrets-fixture.mjs'
import { startFixture } from './task-secrets-fixture-runtime.mjs'
import { cleanupCase } from './cloud-startup.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const caseId = '11111111-1111-4111-8111-111111111111', runId = '22222222-2222-4222-8222-222222222222'
const config = { caseId, harness: 'codex', repository: 'alexj11324/Mikka-handoff', sourceCommit: 'a'.repeat(40),
  workerSha: 'b'.repeat(40), workerSourceCommit: 'c'.repeat(40), fixtureOrigin: 'https://8081-fixture.e2b.app',
  upstreamOrigin: 'https://8080-fixture.e2b.app', bootstrapToken: 'd'.repeat(64), canarySha256: 'e'.repeat(64), responseSha256: 'f'.repeat(64) }
const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: config.sourceCommit,
  APPLICATION_SHA: config.sourceCommit, EXPECTED_WORKER_SHA: config.workerSha, EXPECTED_WORKER_SOURCE_SHA: config.workerSourceCommit,
  EXPECTED_CLAUDE_TEMPLATE: 'released-claude', EXPECTED_CODEX_TEMPLATE: 'released-codex' }

test('default is read-only preflight; execute requires exact main and worker/template pins', () => {
  assert.equal(readOptions([], env).execute, false)
  assert.equal(readOptions(['--execute'], env).execute, true)
  for (const patch of [{ GITHUB_ACTIONS: 'false' }, { GITHUB_EVENT_NAME: 'push' }, { GITHUB_REF: 'refs/heads/other' },
    { APPLICATION_SHA: 'e'.repeat(40) }, { EXPECTED_WORKER_SHA: '' }, { EXPECTED_CODEX_TEMPLATE: '' }, { TASK_SECRETS_MODEL_CASE: 'paid' }]) {
    assert.throws(() => readOptions(['--execute'], { ...env, ...patch }))
  }
  assert.throws(() => readOptions(['--execute', '--execute'], env))
  assert.throws(() => readOptions(['--allow-production'], env))
})

test('a production canary request returns the concrete review plan before any account or provider access', async () => {
  let touched = false
  const result = await runTaskSecretsAcceptance({ ...readOptions(['--execute', '--production-canary'], env) }, {
    env: {}, sessionClient: () => { touched = true; throw Error('unexpected') }, createFixture: () => { touched = true; throw Error('unexpected') },
  })
  assert.equal(touched, false)
  assert.equal(result.status, 'blocked')
  assert.equal(result.productionStoreMutated, false)
  assert.deepEqual(result.productionCanary, productionCanaryPlan())
  assert.equal(result.productionCanary.executed, false)
  assert.ok(result.productionCanary.changes.includes('delete_only_created_fixture_ids'))
})

test('native scope fixes the repository, branch prefix, model harness and public fixture origin', () => {
  assert.equal(nativeScope(config).branch, `acceptance/1712/${caseId}/codex`)
  for (const patch of [{ repository: 'alexj11324/Mikka' }, { caseId: '../main' }, { harness: 'paid' },
    { fixtureOrigin: 'https://example.com' }, { fixtureOrigin: 'http://8081-fixture.e2b.app' },
    { fixtureOrigin: 'https://user:pass@8081-fixture.e2b.app' }, { upstreamOrigin: 'https://8080-fixture.e2b.app/private' },
    { workerSourceCommit: 'main' }, { bootstrapToken: 'short' }]) assert.throws(() => nativeScope({ ...config, ...patch }))
})

test('the exact native launcher verifies bundle bytes and never includes the synthetic canary or sealing key', () => {
  const command = nativeCommand(config, '7'.repeat(64))
  assert.match(command, /hashlib\.sha256\(source\)\.hexdigest\(\)/)
  assert.match(command, /TemporaryDirectory/)
  assert.match(command, /check=True, timeout=300/)
  assert.doesNotMatch(command, /WORKSPACE_SECRETS_KEY|SMOKE_OWNER_PASSWORD|mikka1712s_[a-f0-9]{64}/)
  assert.throws(() => nativeCommand({ ...config, fixtureOrigin: 'https://evil.example' }, '7'.repeat(64)))
})

function goodReceipt() {
  const scan = { matched: false, files: 10, bytes: 1000, unavailable: 0, truncated: false }
  return { version: 1, caseId, runId, harness: 'codex', status: 'passed', productionStoreMutated: false,
    runtime: { workerSha: config.workerSha, sourceCommit: config.workerSourceCommit, node: 'v24.0.0' }, before: scan, after: scan,
    github: { branch: `acceptance/1712/${caseId}/codex`, filename: `acceptance-1712-${caseId}.txt`, cleanup: true,
      commit: '1'.repeat(40), defaultBranchBefore: '2'.repeat(40), defaultBranchAfter: '2'.repeat(40), draftPrNumber: 3,
      fileSha256: '4'.repeat(64), fileBytes: 100, githubActorHash: '5'.repeat(16), times: { cloneMs: 1, fetchMs: 2, pushMs: 3, draftPrMs: 4 } },
    http: { scope: 'isolated_key_and_canary_real_egress_and_bridge_code', samples: 10, productionClaimTested: false,
      productionStoreRotationTested: false, direct: { p50Ms: 1, p95Ms: 2 }, protected: { p50Ms: 3, p95Ms: 4 },
      statuses: { method: 403, path: 403, echo: 502, redirect: 502, origin: 403, authOverride: 403, expired: 410, crossRun: 403, rotatedKey: 401 } } }
}
function toolPair(value, command) {
  return { chunks: [{ chunk: { type: 'tool-input-available', toolCallId: `${runId}:tool1`, toolName: 'bash', input: { command } } },
    { chunk: { type: 'tool-output-available', toolCallId: `${runId}:tool1`, output: `MIKKA_1712_NATIVE ${JSON.stringify(value)}\n` } }] }
}

test('only the exact native tool input/output pair can supply a receipt; model prose and other runs cannot', () => {
  const command = nativeCommand(config, '7'.repeat(64)), expected = { ...config, runId }
  const output = nativeReceipt(toolPair(goodReceipt(), command), expected, command)
  assert.equal(output.status, 'passed')
  assert.equal(output.github.cleanup, true)
  assert.equal(output.http.productionClaimTested, false)
  assert.equal(nativeReceipt({ chunks: [{ chunk: { type: 'text-delta', delta: `MIKKA_1712_NATIVE ${JSON.stringify(goodReceipt())}` } }] }, expected, command), null)
  assert.equal(nativeReceipt(toolPair(goodReceipt(), command + '\necho changed'), expected, command), null)
  const wrong = toolPair(goodReceipt(), command)
  wrong.chunks.forEach(item => { item.chunk.toolCallId = `${randomUUID()}:tool1` })
  assert.equal(nativeReceipt(wrong, expected, command), null)
})

test('receipt projection drops arbitrary credentials/URLs and refuses unconfirmed cleanup, leaked canaries and changed versions', () => {
  const command = nativeCommand(config, '7'.repeat(64)), expected = { ...config, runId }
  const value = goodReceipt()
  value.secret = 'DO_NOT_EXPORT'; value.runtime.env = 'DO_NOT_EXPORT'; value.github.token = 'DO_NOT_EXPORT'; value.http.url = 'DO_NOT_EXPORT'
  assert.doesNotMatch(JSON.stringify(nativeReceipt(toolPair(value, command), expected, command)), /DO_NOT_EXPORT/)
  for (const mutate of [value => { value.github.cleanup = false }, value => { value.before.matched = true },
    value => { value.runtime.workerSha = '0'.repeat(40) }, value => { value.github.defaultBranchAfter = '3'.repeat(40) },
    value => { value.http.productionClaimTested = true }, value => { value.http.statuses.echo = 200 }]) {
    const changed = goodReceipt(); mutate(changed)
    assert.throws(() => nativeReceipt(toolPair(changed, command), expected, command))
  }
})

test('the finite canary scan returns counts and booleans, never matching or unrelated file/environment values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mikka-1712-scan-test-'))
  try {
    const canary = `mikka1712s_${'9'.repeat(64)}`
    await writeFile(join(root, 'synthetic.txt'), `before ${canary} after`)
    const found = await scanCanary(hash(canary), { environment: { OTHER_PRIVATE: 'PRIVATE_VALUE' }, home: root, cwd: root })
    assert.equal(found.matched, true)
    assert.doesNotMatch(JSON.stringify(found), /mikka1712s_|PRIVATE_VALUE|synthetic.txt/)
    await rm(join(root, 'synthetic.txt'))
    assert.equal((await scanCanary(hash(canary), { environment: {}, home: root, cwd: root })).matched, false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

async function githubFake({ ambiguousCreate = false, tamperedHead = false, tamperedActor = false, oldPr = false } = {}) {
  const calls = [], commit = '1'.repeat(40), base = '2'.repeat(40), branch = `acceptance/1712/${caseId}/codex`
  let pushed = false, prCreated = false, prClosed = false, deleted = false, worktree, cleanupRead = false
  const pr = () => ({ number: 3, title: `测试 #1712 ${caseId}`, state: prClosed ? 'closed' : 'open', draft: true, merged: false, merged_at: null,
    created_at: oldPr ? '2020-01-01T00:00:00Z' : new Date().toISOString(),
    head: { ref: branch, sha: commit, repo: { full_name: config.repository } }, base: { ref: 'main', repo: { full_name: config.repository } }, user: { id: 7 } })
  const execute = async (command, args, options) => {
    calls.push({ command, args })
    const result = value => ({ stdout: typeof value === 'string' ? value : JSON.stringify(value) })
    if (command === 'git') {
      if (args[0] === 'ls-remote') {
        if (args[2] === 'refs/heads/main') return result(base + '\trefs/heads/main')
        return result(pushed && !deleted ? `${tamperedHead && prCreated ? '9'.repeat(40) : commit}\trefs/heads/${branch}` : '')
      }
      if (args[0] === 'clone') { worktree = args.at(-1); await mkdir(worktree); return result('') }
      if (args[0] === 'rev-parse') return result(commit)
      if (args[0] === 'diff-tree') return result(`acceptance-1712-${caseId}.txt`)
      if (args[0] === 'push') {
        assert.equal(args[1], 'origin')
        if (args[2] === `HEAD:refs/heads/${branch}`) pushed = true
        else if (args[2] === `:refs/heads/${branch}`) deleted = true
        else assert.fail('write outside the unique branch')
      }
      return result('')
    }
    assert.equal(command, 'gh')
    if (args[0] === 'api') {
      const path = args[1]
      if (path === 'user') assert.fail('installation tokens do not require /user')
      if (path === `repos/${config.repository}`) return result({ full_name: config.repository, default_branch: 'main', permissions: { push: true } })
      if (path.includes('/pulls?')) { cleanupRead = true; return result(prCreated ? [{ ...pr(), ...(tamperedActor ? { user: { id: 8 } } : {}) }] : []) }
      if (path.endsWith('/pulls/3')) return result({ ...pr(), ...(tamperedActor && cleanupRead ? { user: { id: 8 } } : {}) })
      if (path.includes('/contents/')) return result({ type: 'file', path: `acceptance-1712-${caseId}.txt`, encoding: 'base64',
        content: (await readFile(join(worktree, `acceptance-1712-${caseId}.txt`))).toString('base64') })
      assert.fail('unexpected GitHub path')
    }
    if (args[0] === 'pr' && args[1] === 'create') {
      assert.ok(args.includes('--draft')); assert.ok(args.includes('--body-file'))
      assert.equal(options.cwd, worktree); prCreated = true
      if (ambiguousCreate) throw Error('network response lost after write')
      return result(`https://github.com/${config.repository}/pull/3`)
    }
    if (args[0] === 'pr' && args[1] === 'close') { prClosed = true; return result('') }
    assert.fail('unexpected native command')
  }
  return { execute, calls, state: () => ({ pushed, prCreated, prClosed, deleted }) }
}

test('native Git exercises clone/fetch/push/draft-PR and verifies close/delete without a main write', async () => {
  const fake = await githubFake(), result = await nativeGitProof(config, fake)
  assert.equal(result.cleanup, true); assert.equal(result.draftPrNumber, 3)
  assert.deepEqual(fake.state(), { pushed: true, prCreated: true, prClosed: true, deleted: true })
  assert.ok(fake.calls.some(call => call.command === 'git' && call.args[0] === 'clone'))
  assert.ok(fake.calls.some(call => call.command === 'git' && call.args[0] === 'fetch'))
  assert.ok(!fake.calls.some(call => call.args.includes('--force') || call.args.includes('merge')))
})

test('ambiguous PR creation preserves remote evidence; changed heads or actors never authorize cleanup', async () => {
  const lost = await githubFake({ ambiguousCreate: true })
  await assert.rejects(nativeGitProof(config, lost), /cleanup_actor_unconfirmed/)
  assert.deepEqual(lost.state(), { pushed: true, prCreated: true, prClosed: false, deleted: false })
  const changed = await githubFake({ tamperedHead: true })
  await assert.rejects(nativeGitProof(config, changed), /cleanup_branch_changed/)
  assert.equal(changed.state().deleted, false)
  const actor = await githubFake({ tamperedActor: true })
  await assert.rejects(nativeGitProof(config, actor), /cleanup_pr_scope/)
  assert.equal(actor.state().prClosed, false)
  assert.equal(actor.state().deleted, false)
  const old = await githubFake({ oldPr: true })
  await assert.rejects(nativeGitProof(config, old), /cleanup_actor_unconfirmed/)
  assert.equal(old.state().prClosed, false)
  assert.equal(old.state().deleted, false)
})

test('normal task cleanup preserves the issue when external Git cleanup needs recovery, without changing its default', async () => {
  for (const preserveIssue of [false, true]) {
    const calls = [], record = { issueId: caseId, title: 'own test task' }
    const client = {
      json: async path => { assert.equal(path, `/api/factory/tasks?issueId=${caseId}`); return { issueId: caseId, tasks: [] } },
      rpc: async (name, args) => {
        calls.push(name)
        if (name === 'issues.getIssue') return { issue: { id: caseId, title: record.title, revision: 1 } }
        assert.equal(name, 'issue-operations.setIssueDeleted'); assert.equal(args[0].id, caseId); return null
      },
    }
    await cleanupCase(client, record, 'cloud', { preserveIssue })
    assert.equal(record.cleanup.status, 'passed')
    assert.equal(calls.includes('issue-operations.setIssueDeleted'), !preserveIssue)
    if (preserveIssue) assert.deepEqual(record.cleanup.retainedFixture, { issueId: caseId, runIds: [] })
  }
})

test('the bundled real egress and bridge source resolves without SQL/auth dependencies or secret configuration', async () => {
  const bundles = await buildFixtureBundles()
  assert.ok(bundles.server.bytes > 10000 && bundles.client.bytes > 10000 && bundles.client.bytes < 4 * 1024 * 1024)
  assert.equal(bundles.server.sha256, hash(bundles.server.source))
  assert.equal(bundles.client.sha256, hash(bundles.client.source))
  assert.doesNotMatch(bundles.server.source, /from ["'](?:pg|postgres|drizzle-orm)["']/)
})

test('the real local fixture binds one run, returns only sealed grants, and rejects expired, wrong-policy and rotated capabilities', async () => {
  const controlToken = '8'.repeat(64)
  const fixture = await startFixture({ fixtureId: caseId, controlToken, upstreamOrigin: config.upstreamOrigin,
    egressOrigin: config.fixtureOrigin }, '// synthetic reviewed test client', { listenHost: '127.0.0.1', upstreamPort: 0, egressPort: 0 })
  const local = `http://127.0.0.1:${fixture.egressAddress.port}`, upstream = `http://127.0.0.1:${fixture.upstreamAddress.port}`
  const post = (path, value, authorization) => fetch(local + path, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
    body: JSON.stringify(value), signal: AbortSignal.timeout(2000) })
  const control = value => post('/control', { caseId, ...value }, `Bearer ${controlToken}`)
  try {
    assert.equal((await post('/control', { action: 'create', caseId, bootstrapToken: config.bootstrapToken })).status, 401)
    const created = await (await control({ action: 'create', bootstrapToken: config.bootstrapToken })).json()
    assert.match(created.canarySha256, /^[a-f0-9]{64}$/)
    assert.doesNotMatch(JSON.stringify(created), /mikka1712s_|WORKSPACE_SECRETS_KEY|bootstrapToken/)
    assert.equal((await post(`/grant/${caseId}`, { runId, bootstrapToken: 'wrong' })).status, 403)
    // The grant can reach the server before the trusted control-plane bind.
    const earlyGrant = post(`/grant/${caseId}`, { runId, bootstrapToken: config.bootstrapToken })
    assert.equal((await control({ action: 'bind', runId })).status, 200)
    const response = await earlyGrant
    assert.equal(response.status, 200)
    const granted = await response.json()
    assert.equal(granted.grants.length, 1)
    assert.equal(granted.endpoint, `${config.fixtureOrigin}/egress/${runId}`)
    assert.doesNotMatch(JSON.stringify(granted), /mikka1712s_|WORKSPACE_SECRETS_KEY|bootstrapToken/)
    assert.equal((await post(`/grant/${caseId}`, { runId, bootstrapToken: config.bootstrapToken })).status, 409)
    assert.equal((await control({ action: 'bind', runId: randomUUID() })).status, 409)
    assert.equal((await fetch(`${upstream}/v1/protected/${caseId}`)).status, 401)
    const publicResponse = await fetch(`${upstream}/v1/public/${caseId}`)
    assert.equal(publicResponse.status, 200)
    assert.equal(hash(await publicResponse.text()), created.responseSha256)
    const envelope = capability => ({ capability, method: 'GET', path: `/v1/protected/${caseId}`, headers: [] })
    assert.equal((await post(`/egress/${runId}`, envelope(granted.expiredCapability))).status, 410)
    assert.equal((await post(`/egress/${runId}`, { ...envelope(granted.grants[0].capability), method: 'POST' })).status, 403)
    assert.equal((await post(`/egress/${randomUUID()}`, envelope(granted.grants[0].capability))).status, 403)
    assert.equal((await post(`/rotate/${caseId}`, { runId, bootstrapToken: config.bootstrapToken })).status, 200)
    assert.equal((await post(`/egress/${runId}`, envelope(granted.grants[0].capability))).status, 401)
    const receipt = await (await control({ action: 'receipt' })).json()
    assert.deepEqual(receipt.counts, { public: 1, protected: 0, echo: 0, redirect: 0 })
    assert.equal(receipt.rotated, true)
    assert.equal((await control({ action: 'delete' })).status, 200)
    assert.equal((await post(`/grant/${caseId}`, { runId, bootstrapToken: config.bootstrapToken })).status, 403)
  } finally { await fixture.close() }
})

test('fixture cleanup refuses a mismatched provider identity, and setup failure attempts cleanup on its own VM only', async () => {
  let killed = 0, evidence
  const sandbox = { sandboxId: 'fixture-owned', getHost: port => `${port}-fixture.e2b.app`,
    commands: { run: async command => {
      if (command.startsWith('install')) return {}
      throw Error('fixture failed')
    } }, files: { write: async () => {} },
    getInfo: async () => ({ sandboxId: 'fixture-owned', metadata: { application: 'foreign', acceptance: randomUUID() } }),
    kill: async () => { killed++; return true } }
  await assert.rejects(createIsolatedFixture({ fixtureId: caseId, sourceCommit: config.sourceCommit, apiKey: 'synthetic-key',
    bundles: { server: { source: '' }, client: { source: '' } } }, { sandboxFactory: async () => sandbox, onEvidence: value => { evidence = value } }))
  assert.equal(killed, 0)
  assert.equal(evidence.cleanup.outcome, 'unconfirmed')
  assert.equal(evidence.fixtureId, caseId)
  assert.equal(evidence.maximumLifetimeMs, 1_200_000)
  assert.doesNotMatch(JSON.stringify(evidence), /synthetic-key|controlToken|WORKSPACE_SECRETS_KEY/)
  sandbox.getInfo = async () => ({ sandboxId: 'fixture-owned', metadata: {
    application: 'mikka-1712-secret-fixture', acceptance: caseId, sourceCommit: config.sourceCommit } })
  await assert.rejects(createIsolatedFixture({ fixtureId: caseId, sourceCommit: config.sourceCommit, apiKey: 'synthetic-key',
    bundles: { server: { source: '' }, client: { source: '' } } }, { sandboxFactory: async () => sandbox, onEvidence: value => { evidence = value } }))
  assert.equal(killed, 1)
  assert.equal(evidence.cleanup.stopped, true)
  assert.equal(evidence.cleanup.outcome, 'provider_kill_acknowledged')
})

test('workflow reuses existing OIDC scopes and serial owner lane, with no GitHub write or production-canary switch', async () => {
  const source = await readFile(new URL('../../.github/workflows/task-secret-acceptance.yml', import.meta.url), 'utf8')
  assert.match(source, /group: production-smoke-owner-acceptance/)
  assert.match(source, /identity-id: 2cf9fa19-b9db-4c08-8ca0-b31859f2cbac/)
  assert.match(source, /secret-name: SMOKE_OWNER_EMAIL/)
  assert.match(source, /secret-name: SMOKE_OWNER_PASSWORD/)
  assert.match(source, /secret-name: E2B_API_KEY/)
  assert.doesNotMatch(source, /contents: write|pull-requests: write|issues: write|WORKSPACE_SECRETS_KEY|production-canary|VERCEL_TEAM_TOKEN/)
  assert.match(source, /persist-credentials: false/)
  assert.ok(source.indexOf('before credentials') < source.indexOf('Infisical/secrets-action'))
})

test('failures remain closed codes even when an exception carries a credential in message or cause', () => {
  assert.equal(safeFailure(Error('task_secrets_paid_fallback_enabled')), 'task_secrets_paid_fallback_enabled')
  assert.doesNotMatch(JSON.stringify(safeFailure(Error('PRIVATE_URL?token=PRIVATE_VALUE', { cause: Error('PRIVATE_CREDENTIAL') }))), /PRIVATE/)
})
