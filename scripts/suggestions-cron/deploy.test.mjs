import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { MIKKA_URL, WORKER, deployCron, gitRepository, validateConfig } from './deploy.mjs'

const SOURCE = 'a'.repeat(40), OLD = 'b'.repeat(40), NEW = 'c'.repeat(40), ACCOUNT = 'e'.repeat(32)
const VERSION = '11111111-1111-4111-8111-111111111111'
const configText = readFileSync(new URL('../../cloudflare/suggestions-cron/wrangler.jsonc', import.meta.url), 'utf8')

function fixture() {
  const state = { main: SOURCE, live: SOURCE, same: true, writes: 0, waits: 0, calls: [],
    secret: true, origin: MIKKA_URL, extraBinding: false, observability: true, publicUrl: false, previews: false,
    schedules: ['* * * * *'], activeVersion: VERSION, cfStatus: 200 }
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
    } else throw new Error('unexpected fixture endpoint ' + url.href)

    return Response.json(data)
  }
  const options = { sourceCommit: SOURCE, accountId: ACCOUNT, cloudflareToken: 'fixture-cf', readPromotedWeb: async () => ({ id: 'release-1', sha: state.live }),
    repository, configText, fetchImpl, log() {}, maxPolls: 3,
    async wait(ms) { assert.equal(ms, 30_000); state.waits++ },
    async deployWorker(sha, authority) {
      assert.equal(sha, SOURCE)
      assert.deepEqual(authority, { accountId: ACCOUNT, cloudflareToken: 'fixture-cf' })
      state.writes++
      state.schedules = ['0,15,30,45 * * * *']
      return VERSION
    },
  }
  return { state, options }
}

test('deploys once only after Cloudflare release proof is stable', async () => {
  const { state, options } = fixture()
  let reads = 0
  const read = options.readPromotedWeb
  options.readPromotedWeb = async () => { reads++; return read() }
  const report = await deployCron(options)
  assert.equal(reads, 2)
  assert.equal(state.writes, 1)
  assert.deepEqual(report.production, { id: 'release-1', sha: SOURCE })
  assert.ok(state.calls.every(url => new URL(url).origin === 'https://api.cloudflare.com'))
})

test('pending promotion waits; stale and changed releases never write', async () => {
  const pending = fixture()
  let reads = 0
  pending.options.readPromotedWeb = async () => ++reads === 1 ? null : { id: 'release-1', sha: SOURCE }
  await deployCron(pending.options)
  assert.equal(pending.state.waits, 1)
  assert.equal(pending.state.writes, 1)
  const stale = fixture()
  stale.options.readPromotedWeb = async () => null
  await assert.rejects(deployCron(stale.options), /production_release_wait_timeout/)
  assert.equal(stale.state.writes, 0)
  const changed = fixture()
  let count = 0
  changed.options.maxPolls = 1
  changed.options.readPromotedWeb = async () => ({ id: ++count === 1 ? 'one' : 'two', sha: SOURCE })
  await assert.rejects(deployCron(changed.options), /production_release_wait_timeout/)
  assert.equal(changed.state.writes, 0)
})

test('unchanged inputs on later main are allowed; changed inputs supersede', async () => {
  const later = fixture()
  later.state.main = NEW
  assert.equal((await deployCron(later.options)).skipped, false)
  const changed = fixture()
  changed.state.same = false
  assert.deepEqual(await deployCron(changed.options), { skipped: true, reason: 'newer_cron_source' })
  assert.equal(changed.state.writes, 0)
})

test('mismatched release and main movement cannot authorize a write', async () => {
  const mismatch = fixture()
  mismatch.options.readPromotedWeb = async () => ({ id: 'wrong', sha: OLD })
  await assert.rejects(deployCron(mismatch.options), /production_release_wait_timeout/)
  assert.equal(mismatch.state.writes, 0)
  const moved = fixture()
  let reads = 0
  moved.options.repository.refreshMain = async () => { if (++reads === 2) moved.state.same = false; return SOURCE }
  assert.equal((await deployCron(moved.options)).skipped, true)
  assert.equal(moved.state.writes, 0)
})

test('missing Worker or mismatched existing configuration refuses all writes', async () => {
  for (const patch of [{ cfStatus: 404 }, { secret: false }, { origin: 'https://other.example/mikka' }, { extraBinding: true },
    { observability: false }, { publicUrl: true }, { previews: true }, { schedules: [] }, { schedules: ['* * * * *', '0 * * * *'] }]) {
    const { state, options } = fixture()
    Object.assign(state, patch)
    await assert.rejects(() => deployCron(options), /cloudflareWeb:productionSource|provider_read_http_404|cron_bindings_mismatch|cron_observability_mismatch|cron_public_url_enabled|cron_schedule_mismatch/)
    assert.equal(state.writes, 0)
  }
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
  lost.options.readPromotedWeb = async () => { throw Error('promotion_unavailable') }
  await assert.rejects(() => deployCron(lost.options), /promotion_unavailable/)
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
