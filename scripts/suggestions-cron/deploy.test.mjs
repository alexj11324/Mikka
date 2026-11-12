import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ALIAS, PROJECT, TEAM } from '../device-gateway/deploy.mjs'
import { MIKKA_URL, WORKER, deployCron, gitRepository, validateConfig, webDeployRun } from './deploy.mjs'

const SOURCE = 'a'.repeat(40), OLD = 'b'.repeat(40), NEW = 'c'.repeat(40), ACCOUNT = 'e'.repeat(32)
const VERSION = '11111111-1111-4111-8111-111111111111'
const configText = readFileSync(new URL('../../cloudflare/suggestions-cron/wrangler.jsonc', import.meta.url), 'utf8')
const webRun = sha => ({ id: 42, head_sha: sha, head_branch: 'main', event: 'push', repository: { full_name: 'alexj11324/Mikka' },
  path: '.github/workflows/web-deploy.yml', status: 'completed', conclusion: 'success' })

function fixture() {
  const state = { main: SOURCE, live: SOURCE, build: SOURCE, same: true, writes: 0, waits: 0, calls: [], status: 'READY',
    secret: true, origin: MIKKA_URL, extraBinding: false, observability: true, publicUrl: false, previews: false,
    schedules: ['* * * * *'], project: PROJECT, aliasProject: PROJECT, activeVersion: VERSION, cfStatus: 200, webStatus: 'success' }
  const repository = {
    async assertCheckout() {},
    async refreshMain() { return state.main },
    async contains(before, after) { return before === after || before === OLD || before === SOURCE && after === NEW },
    async sameInputs() { return state.same },
  }
  const fetchImpl = async (input, init) => {
    const url = new URL(input)
    state.calls.push(url.href)
    assert.equal(init.method ?? 'GET', 'GET', 'preflight and readback never mutate providers or application')
    assert.equal(init.redirect, 'error')
    let data
    if (url.origin === 'https://api.cloudflare.com') {
      assert.equal(init.headers.authorization, 'Bearer fixture-cf')
      assert.ok(url.pathname.startsWith('/client/v4/accounts/' + ACCOUNT + '/workers/scripts/' + WORKER + '/'))
      if (state.cfStatus !== 200) return new Response('do not log fixture-upstream-secret', { status: state.cfStatus })
      if (url.pathname.endsWith('/settings')) data = { bindings: [
        { type: 'plain_text', name: 'MIKKA_URL', text: state.origin },
        ...(state.secret ? [{ type: 'secret_text', name: 'CRON_SECRET' }] : []),
        ...(state.extraBinding ? [{ type: 'kv_namespace', name: 'UNMANAGED', namespace_id: 'x' }] : []),
      ], observability: { enabled: state.observability } }
      else if (url.pathname.endsWith('/subdomain')) data = { enabled: state.publicUrl, previews_enabled: state.previews }
      else if (url.pathname.endsWith('/schedules')) data = { schedules: state.schedules.map(cron => ({ cron })) }
      else if (url.pathname.endsWith('/deployments')) data = { deployments: [{ versions: [{ version_id: state.activeVersion, percentage: 100 }] }] }
      else throw new Error('unexpected fixture endpoint ' + url.pathname)
      data = { success: true, result: data }
    } else if (url.origin === 'https://api.vercel.com') {
      assert.equal(init.headers.authorization, 'Bearer fixture-vercel')
      assert.equal(url.searchParams.get('teamId'), TEAM)
      if (url.pathname === '/v9/projects/' + PROJECT) data = { id: state.project, accountId: TEAM, link: { type: 'github', repoId: 1427517699 } }
      else if (url.pathname === '/v4/aliases/' + ALIAS) data = { alias: ALIAS, projectId: state.aliasProject, deploymentId: 'dpl_fixture' }
      else if (url.pathname === '/v13/deployments/dpl_fixture') data = { id: 'dpl_fixture', projectId: PROJECT, ownerId: TEAM,
        target: 'production', readyState: state.status, aliasAssigned: true,
        meta: { githubOrg: 'alexj11324', githubRepo: 'Mikka', githubCommitSha: state.live }, gitSource: { sha: state.live } }
      else throw new Error('unexpected fixture endpoint ' + url.pathname)
    } else if (url.origin === 'https://cloudflare-dns.com') {
      assert.equal(init.headers.authorization, undefined)
      assert.equal(init.headers.accept, 'application/dns-json')
      data = { Status: 3, Question: [{ type: 16, name: '_mikka-release.aspectlylabs.com.' }] }
    } else if (url.origin === 'https://api.github.com') {
      assert.equal(init.headers.authorization, 'Bearer fixture-github')
      assert.equal(url.pathname, '/repos/alexj11324/Mikka/actions/workflows/web-deploy.yml/runs')
      assert.equal(url.searchParams.get('head_sha'), state.live)
      data = { workflow_runs: state.webStatus === 'pending' ? [] : [{ ...webRun(state.live), conclusion: state.webStatus }] }
    } else {
      assert.equal(url.href, MIKKA_URL + '/api/version')
      assert.equal(init.headers.authorization, undefined, 'public version receives no provider or GitHub token')
      assert.equal(init.cache, 'no-store')
      data = { build: state.build }
    }
    return Response.json(data, { headers: url.href === MIKKA_URL + '/api/version' ? { 'x-vercel-id': 'fixture' } : {} })
  }
  const options = { sourceCommit: SOURCE, accountId: ACCOUNT, cloudflareToken: 'fixture-cf', vercelToken: 'fixture-vercel',
    githubToken: 'fixture-github', repository, configText, fetchImpl, log() {}, maxPolls: 3,
    async wait(ms) { assert.equal(ms, 30_000); state.waits++ },
    async deployWorker(sha, authority) {
      assert.equal(sha, SOURCE)
      assert.deepEqual(authority, { accountId: ACCOUNT, cloudflareToken: 'fixture-cf' })
      state.writes++
      return VERSION
    },
  }
  return { state, options }
}

test('deploys the existing Worker once after exact Web deploy, READY alias and public build agree', async () => {
  const { state, options } = fixture()
  const report = await deployCron(options)
  assert.equal(state.writes, 1)
  assert.equal(state.waits, 0)
  assert.equal(state.calls.filter(url => url === MIKKA_URL + '/api/version').length, 5)
  assert.deepEqual(report, { skipped: false, sourceCommit: SOURCE, production: { id: 'dpl_fixture', sha: SOURCE },
    webDeployRunId: 42, versionId: VERSION, cron: '* * * * *', publicUrls: false, secretBinding: 'CRON_SECRET', observability: true })
  assert.equal(state.calls.some(url => /\/secrets(?:\/|$)/.test(url)), false)
})

const promotion = { schema: 'mikka.cloudflare-promotion.v1', approvalComment: '1954', approvalSha256: '2'.repeat(64),
  product: SOURCE, overlay: OLD, releasePin: 'aaaaaaaa-1953-1', gatewayVersionSha256: '3'.repeat(64),
  inventorySha256: '4'.repeat(64), verifiedAt: '2026-11-12T07:00:00.000Z', outcome: 'promoted' }

test('the protected Cloudflare promotion is re-read before the single existing minute Worker write', async () => {
  const { options, state } = fixture()
  let observations = 0
  const report = await deployCron({ ...options, vercelToken: undefined, githubToken: undefined,
    readPromotedWeb: async () => { observations++; return promotion } })
  assert.equal(observations, 2)
  assert.equal(state.writes, 1)
  assert.equal(state.waits, 0)
  assert.equal(Object.hasOwn(report, 'webDeployRunId'), false)
  assert.equal(report.production.sha, SOURCE)
  assert.equal(report.versionId, VERSION)
  assert.ok(state.calls.every(url => new URL(url).origin === 'https://api.cloudflare.com'))
})

test('revoked, mismatched or rotated Web promotion never writes a minute Worker under the first release', async () => {
  for (const changed of [() => { throw Error('promotion_withdrawn') }, () => ({ ...promotion, product: OLD }),
    () => null, () => ({ ...promotion, gatewayVersionSha256: '5'.repeat(64) })]) {
    const { options, state } = fixture()
    let observations = 0
    await assert.rejects(deployCron({ ...options, maxPolls: 1, githubToken: undefined, vercelToken: undefined,
      readPromotedWeb: async () => ++observations === 1 ? promotion : changed() }))
    assert.equal(state.writes, 0)
    assert.ok(state.calls.every(url => new URL(url).origin === 'https://api.cloudflare.com'))
  }
})

test('waits for application, Web deploy and public alias propagation without an early write', async () => {
  for (const patch of [{ live: OLD }, { status: 'BUILDING' }, { webStatus: 'pending' }, { build: OLD }]) {
    const { state, options } = fixture()
    Object.assign(state, patch)
    options.wait = async () => {
      assert.equal(state.writes, 0)
      state.waits++
      Object.assign(state, { live: SOURCE, status: 'READY', webStatus: 'success', build: SOURCE })
    }
    await deployCron(options)
    assert.equal(state.waits, 1)
    assert.equal(state.writes, 1)
  }
})

test('old/unready/mismatched public production times out with zero mutations', async () => {
  for (const patch of [{ live: OLD }, { status: 'BUILDING' }, { webStatus: 'pending' }, { build: OLD }]) {
    const { state, options } = fixture()
    Object.assign(state, patch)
    await assert.rejects(() => deployCron(options), /^Error: production_release_wait_timeout$/)
    assert.equal(state.writes, 0)
    assert.equal(state.waits, 2)
  }
})

test('missing Worker or mismatched existing configuration refuses all writes', async () => {
  for (const patch of [{ cfStatus: 404 }, { secret: false }, { origin: 'https://other.example/mikka' }, { extraBinding: true },
    { observability: false }, { publicUrl: true }, { previews: true }, { schedules: [] }, { schedules: ['* * * * *', '0 * * * *'] },
    { project: 'prj_foreign' }, { aliasProject: 'prj_foreign' }, { webStatus: 'failure' }, { build: 'not-a-build' }]) {
    const { state, options } = fixture()
    Object.assign(state, patch)
    await assert.rejects(() => deployCron(options), /cloudflareWeb:productionSource|provider_read_http_404|cron_bindings_mismatch|cron_observability_mismatch|cron_public_url_enabled|cron_schedule_mismatch|production_project_mismatch|production_identity_mismatch|web_deploy_failed|production_version_invalid/)
    assert.equal(state.writes, 0)
  }
})

test('unchanged input on a later main commit is permitted, changed inputs supersede the older release', async () => {
  const later = fixture()
  Object.assign(later.state, { main: NEW, live: NEW, build: NEW })
  assert.equal((await deployCron(later.options)).skipped, false)
  const changed = fixture()
  changed.state.same = false
  assert.deepEqual(await deployCron(changed.options), { skipped: true, reason: 'newer_cron_source' })
  assert.equal(changed.state.writes, 0)
})

test('a source or public build change during the final check cannot authorize an obsolete write', async () => {
  const changedSource = fixture()
  let reads = 0
  changedSource.options.repository.refreshMain = async () => {
    if (++reads === 2) { changedSource.state.main = NEW; changedSource.state.same = false }
    return changedSource.state.main
  }
  assert.equal((await deployCron(changedSource.options)).skipped, true)
  assert.equal(changedSource.state.writes, 0)
  const changedBuild = fixture()
  let builds = 0
  const fetchImpl = changedBuild.options.fetchImpl
  changedBuild.options.fetchImpl = async (url, init) => {
    if (new URL(url).href === MIKKA_URL + '/api/version' && ++builds >= 4) changedBuild.state.build = OLD
    return fetchImpl(url, init)
  }
  await assert.rejects(() => deployCron(changedBuild.options), /production_release_wait_timeout/)
  assert.equal(changedBuild.state.writes, 0)
})

test('a changed binding before upload and lost post-upload settings fail instead of reporting success', async () => {
  for (const afterWrite of [false, true]) {
    const { state, options } = fixture()
    let reads = 0
    const fetchImpl = options.fetchImpl
    options.fetchImpl = async (url, init) => {
      if (new URL(url).pathname.endsWith('/settings') && ++reads === (afterWrite ? 3 : 2)) state.secret = false
      return fetchImpl(url, init)
    }
    await assert.rejects(() => deployCron(options), /cron_bindings_mismatch/)
    assert.equal(state.writes, afterWrite ? 1 : 0)
  }
})

test('unknown write result, missing receipt and inactive version are never retried', async () => {
  const unknown = fixture()
  unknown.options.deployWorker = async () => { unknown.state.writes++; throw Error('cron_deploy_failed_or_uncertain') }
  await assert.rejects(() => deployCron(unknown.options), /^Error: cron_deploy_failed_or_uncertain$/)
  assert.equal(unknown.state.writes, 1)
  const noReceipt = fixture()
  noReceipt.options.deployWorker = async () => { noReceipt.state.writes++; return undefined }
  await assert.rejects(() => deployCron(noReceipt.options), /cron_deploy_receipt_missing/)
  assert.equal(noReceipt.state.writes, 1)
  const otherVersion = fixture()
  otherVersion.state.activeVersion = '22222222-2222-4222-8222-222222222222'
  await assert.rejects(() => deployCron(otherVersion.options), /cron_deployment_not_active/)
  assert.equal(otherVersion.state.writes, 1)
})

test('provider response/transport errors remain bounded and never expose arbitrary body or bearer', async () => {
  const denied = fixture()
  denied.state.cfStatus = 403
  await assert.rejects(() => deployCron(denied.options), /^Error: provider_read_http_403$/)
  assert.equal(denied.state.writes, 0)
  const lost = fixture()
  const fetchImpl = lost.options.fetchImpl
  lost.options.fetchImpl = async (url, init) => {
    if (url.origin === 'https://api.github.com') throw Error('fixture-github and upstream contents must not escape')
    return fetchImpl(url, init)
  }
  await assert.rejects(() => deployCron(lost.options), /^Error: release_read_unavailable$/)
  assert.equal(lost.state.writes, 0)
})

test('configuration cannot create resources, change cadence or publish a public URL', () => {
  const config = validateConfig(configText)
  for (const patch of [{ name: 'another-worker' }, { main: '../other.mjs' }, { workers_dev: true }, { preview_urls: true },
    { vars: { MIKKA_URL: 'https://foreign.example' } }, { triggers: { crons: ['* * * * *', '0 * * * *'] } },
    { durable_objects: { bindings: [{ name: 'NEW', class_name: 'NewClass' }] } }, { env: { production: {} } }]) {
    assert.throws(() => validateConfig(JSON.stringify({ ...config, ...patch })), /cron_resource_change_refused/)
  }
})

test('Web deploy evidence rejects foreign runs and honors the latest exact commit attempt', () => {
  for (const patch of [{ head_sha: OLD }, { head_branch: 'preview' }, { event: 'pull_request' },
    { repository: { full_name: 'other/repo' } }, { path: '.github/workflows/unrelated.yml' }]) {
    assert.equal(webDeployRun([{ ...webRun(SOURCE), ...patch }], SOURCE), null)
  }
  assert.equal(webDeployRun([{ ...webRun(SOURCE), event: 'workflow_dispatch' }], SOURCE), 42)
  assert.equal(webDeployRun([webRun(SOURCE), { ...webRun(SOURCE), id: 43, status: 'in_progress', conclusion: null }], SOURCE), null)
  assert.throws(() => webDeployRun([webRun(SOURCE), { ...webRun(SOURCE), id: 43, conclusion: 'failure' }], SOURCE), /web_deploy_failed/)
})

test('CLI refuses PR and non-main invocation before inspecting credentials', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./deploy.mjs', import.meta.url))], { encoding: 'utf8', env: {
    PATH: process.env.PATH, GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'alexj11324/Mikka',
    GITHUB_REF: 'refs/pull/1/merge', GITHUB_EVENT_NAME: 'pull_request',
  } })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr.trim(), 'reviewed_main_workflow_required')
})

test('real Git checks reject dirty checkouts and supersede only changed minute Worker inputs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mikka-minute-release-'))
  const git = args => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  try {
    git(['init', '--quiet'])
    git(['config', 'user.name', 'Isolated release fixture'])
    git(['config', 'user.email', 'fixture@example.invalid'])
    mkdirSync(join(directory, 'cloudflare/suggestions-cron/src'), { recursive: true })
    mkdirSync(join(directory, 'scripts/device-gateway'), { recursive: true })
    writeFileSync(join(directory, 'cloudflare/suggestions-cron/src/index.mjs'), 'export default {}\n')
    writeFileSync(join(directory, 'scripts/device-gateway/deploy.mjs'), 'export const version = 1\n')
    git(['add', '.']); git(['commit', '--quiet', '-m', 'initial Worker'])
    const source = git(['rev-parse', 'HEAD'])
    writeFileSync(join(directory, 'business.ts'), 'export const unrelated = true\n')
    git(['add', '.']); git(['commit', '--quiet', '-m', 'business only'])
    const business = git(['rev-parse', 'HEAD'])
    const repository = gitRepository(directory)
    assert.equal(await repository.contains(source, business), true)
    assert.equal(await repository.contains(business, source), false)
    assert.equal(await repository.sameInputs(source, business), true)
    await repository.assertCheckout(business)
    writeFileSync(join(directory, 'scripts/device-gateway/deploy.mjs'), 'export const version = 2\n')
    await assert.rejects(() => repository.assertCheckout(business), /release_checkout_changed/)
    writeFileSync(join(directory, 'cloudflare/suggestions-cron/src/index.test.mjs'), '// offline coverage\n')
    git(['add', '.']); git(['commit', '--quiet', '-m', 'release tooling and tests changed'])
    const tooling = git(['rev-parse', 'HEAD'])
    assert.equal(await repository.sameInputs(source, tooling), true)
    writeFileSync(join(directory, 'cloudflare/suggestions-cron/wrangler.jsonc'), '{}\n')
    git(['add', '.']); git(['commit', '--quiet', '-m', 'Worker configuration changed'])
    const configured = git(['rev-parse', 'HEAD'])
    assert.equal(await repository.sameInputs(tooling, configured), false)
    git(['mv', 'cloudflare/suggestions-cron/src/index.mjs', 'retired-entry.mjs'])
    git(['commit', '--quiet', '-m', 'Worker entry moved outside the package'])
    assert.equal(await repository.sameInputs(configured, git(['rev-parse', 'HEAD'])), false)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
