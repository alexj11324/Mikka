import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { affectsWorker } from './select-release.mjs'
import { readWebAuthority } from '../release/cloudflare-promoted-web.mjs'
import { ALIAS, PROJECT, TEAM, WORKER, deployGateway, gitRepository, readJson, validateConfig } from './deploy.mjs'

const SOURCE = 'a'.repeat(40), OLD = 'b'.repeat(40), NEW = 'c'.repeat(40)
const VERSION = '11111111-1111-4111-8111-111111111111'
const NAMESPACE = 'd'.repeat(32), ACCOUNT = 'e'.repeat(32)
const configText = readFileSync(new URL('../../cloudflare/device-gateway/wrangler.jsonc', import.meta.url), 'utf8')

function fixture() {
  const state = { main: SOURCE, live: SOURCE, same: true, writes: 0, waits: 0, calls: [], status: 'READY', namespace: NAMESPACE,
    migration: 'v1', secret: true, project: PROJECT, aliasProject: PROJECT, activeVersion: VERSION, cfStatus: 200 }
  const repository = {
    async assertCheckout() {},
    async refreshMain() { return state.main },
    async contains(before, after) { return before === after || before === OLD || before === SOURCE && after === NEW },
    async sameInputs() { return state.same },
  }
  const fetchImpl = async (url, init) => {
    url = new URL(url)
    state.calls.push(url.pathname)
    if (url.hostname === 'cloudflare-dns.com' || url.hostname === ALIAS) {
      assert.equal(init.headers.authorization, undefined)
      return url.hostname === ALIAS ? Response.json({build:state.live}, {headers:{'x-vercel-id':'fixture'}})
        : Response.json({Status:3, Question:[{name:'_mikka-release.aspectlylabs.com.', type:16}]})
    }
    assert.equal(init.method ?? 'GET', 'GET', 'all preflight/provider readback calls are read-only')
    assert.equal(init.redirect, 'error')
    let data
    if (url.origin === 'https://api.cloudflare.com') {
      assert.equal(init.headers.authorization, 'Bearer fixture-cf')
      assert.ok(url.pathname.startsWith(`/client/v4/accounts/${ACCOUNT}/workers/`))
      if (state.cfStatus !== 200) return new Response('not a credential-safe upstream error', { status: state.cfStatus })
      if (url.pathname.endsWith('/settings')) data = { bindings: [
        { type: 'durable_object_namespace', name: 'DEVICE_SESSION', class_name: 'DeviceSession', namespace_id: state.namespace },
        ...(state.secret ? [{ type: 'secret_text', name: 'GATEWAY_PUSH_SECRET' }] : []),
      ] }
      else if (url.pathname.endsWith(`/services/${WORKER}`)) data = { default_environment: { script: { migration_tag: state.migration } } }
      else if (url.pathname.endsWith('/deployments')) data = { deployments: [{ versions: [{ version_id: state.activeVersion, percentage: 100 }] }] }
      else throw new Error(`unexpected fixture endpoint ${url.pathname}`)
      data = { success: true, result: data }
    } else {
      assert.equal(url.origin, 'https://api.vercel.com')
      assert.equal(init.headers.authorization, 'Bearer fixture-vercel')
      assert.equal(url.searchParams.get('teamId'), TEAM)
      if (url.pathname === `/v9/projects/${PROJECT}`) data = { id: state.project, accountId: TEAM, link: { type: 'github', repoId: 1427517699 } }
      else if (url.pathname === `/v4/aliases/${ALIAS}`) data = { alias: ALIAS, projectId: state.aliasProject, deploymentId: 'dpl_fixture' }
      else if (url.pathname === '/v13/deployments/dpl_fixture') data = { id: 'dpl_fixture', projectId: PROJECT, ownerId: TEAM,
        target: 'production', readyState: state.status, aliasAssigned: true,
        meta: { githubOrg: 'alexj11324', githubRepo: 'Mikka', githubCommitSha: state.live }, gitSource: { sha: state.live } }
      else throw new Error(`unexpected fixture endpoint ${url.pathname}`)
    }
    return Response.json(data)
  }
  const options = { sourceCommit: SOURCE, accountId: ACCOUNT, cloudflareToken: 'fixture-cf', vercelToken: 'fixture-vercel',
    repository, configText, fetchImpl, log() {}, maxPolls: 3,
    async wait(ms) { assert.equal(ms, 30_000); state.waits++ },
    async deployWorker(sha) { assert.equal(sha, SOURCE); state.writes++; return VERSION },
  }
  return { state, options }
}

test('waits for the fixed application on the pinned production alias before the single Worker write', async () => {
  const { state, options } = fixture()
  state.live = OLD
  options.wait = async ms => { assert.equal(ms, 30_000); assert.equal(state.writes, 0); state.waits++; state.live = SOURCE }
  const report = await deployGateway(options)
  assert.equal(state.waits, 1)
  assert.equal(state.writes, 1)
  assert.equal(state.calls.filter(path => path === `/v4/aliases/${ALIAS}`).length, 3)
  assert.deepEqual(report, { skipped: false, sourceCommit: SOURCE, production: { id: 'dpl_fixture', sha: SOURCE }, versionId: VERSION, namespaceId: NAMESPACE })
})

test('an unchanged gateway in a later main/production commit is safe; a changed gateway supersedes this release', async () => {
  const newer = fixture()
  newer.state.main = NEW
  newer.state.live = NEW
  assert.equal((await deployGateway(newer.options)).skipped, false)
  const superseded = fixture()
  superseded.state.live = OLD
  superseded.options.wait = async () => { superseded.state.main = NEW; superseded.state.same = false }
  assert.deepEqual(await deployGateway(superseded.options), { skipped: true, reason: 'newer_gateway_source' })
  assert.equal(superseded.state.writes, 0)
})

test('a new gateway main commit between eligibility and final check prevents an obsolete write', async () => {
  const { state, options } = fixture()
  let reads = 0
  options.repository.refreshMain = async () => {
    if (++reads === 2) { state.main = NEW; state.same = false }
    return state.main
  }
  assert.equal((await deployGateway(options)).skipped, true)
  assert.equal(state.writes, 0)
})

test('missing Worker/bindings, unapplied migrations and foreign projects fail before any deploy', async () => {
  for (const patch of [{ cfStatus: 404 }, { secret: false }, { migration: '' }, { namespace: '' }, { project: 'prj_foreign' }, { aliasProject: 'prj_foreign' }]) {
    const { state, options } = fixture()
    Object.assign(state, patch)
    await assert.rejects(() => deployGateway(options), /provider_read_http_404|gateway_bindings_mismatch|gateway_existing_migration_required|production_project_mismatch|production_identity_mismatch/)
    assert.equal(state.writes, 0)
  }
})

test('a permanently old or unready production deployment times out without repairing the socket early', async () => {
  for (const patch of [{ live: OLD }, { status: 'BUILDING' }]) {
    const { state, options } = fixture()
    Object.assign(state, patch)
    await assert.rejects(() => deployGateway(options), /production_release_wait_timeout/)
    assert.equal(state.waits, 2)
    assert.equal(state.writes, 0)
  }
})

test('an uncertain write or mismatched active version is never retried or reported as deployed', async () => {
  const unknown = fixture()
  unknown.options.deployWorker = async () => { unknown.state.writes++; throw new Error('gateway_deploy_failed_or_uncertain') }
  await assert.rejects(() => deployGateway(unknown.options), /gateway_deploy_failed_or_uncertain/)
  assert.equal(unknown.state.writes, 1)
  const different = fixture()
  different.state.activeVersion = '22222222-2222-4222-8222-222222222222'
  await assert.rejects(() => deployGateway(different.options), /gateway_deployment_not_active/)
  assert.equal(different.state.writes, 1)
})

test('provider failures do not expose credentials/upstream payloads and redirects are refused', async () => {
  await assert.rejects(() => readJson(new URL('https://evil.example/'), 'fixture-secret'), /^Error: provider_origin_invalid$/)
  await assert.rejects(() => readJson(new URL('https://api.vercel.com/x'), 'fixture-secret', async (_url, init) => {
    assert.equal(init.redirect, 'error')
    throw new Error('Authorization: Bearer fixture-secret')
  }), /^Error: provider_read_unavailable$/)
  await assert.rejects(() => readJson(new URL('https://api.cloudflare.com/x'), 'fixture-secret', async () => new Response('fixture-secret', { status: 403 })), /^Error: provider_read_http_403$/)
})

test('release config cannot introduce another Worker, resource, namespace migration or environment', () => {
  const config = validateConfig(configText)
  for (const patch of [{ name: 'another-worker' }, { r2_buckets: [{ binding: 'EXTRA', bucket_name: 'new' }] }, { env: { production: {} } },
    { migrations: [...config.migrations, { tag: 'v2', new_sqlite_classes: ['NewClass'] }] }]) {
    assert.throws(() => validateConfig(JSON.stringify({ ...config, ...patch })), /gateway_resource_change_refused/)
  }
})

test('the command-line entry refuses PRs and non-main runs before reading provider credentials', () => {
  const script = fileURLToPath(new URL('./deploy.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8', env: {
    PATH: process.env.PATH, GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'alexj11324/Mikka',
    GITHUB_REF: 'refs/pull/1/merge', GITHUB_EVENT_NAME: 'pull_request',
  } })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr.trim(), 'reviewed_main_workflow_required')
})

test('real Git ancestry and file comparisons permit unrelated main changes and reject new gateway inputs or dirty checkout', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mikka-gateway-release-'))
  const git = args => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  try {
    git(['init', '--quiet'])
    git(['config', 'user.name', 'Isolated release fixture'])
    git(['config', 'user.email', 'fixture@example.invalid'])
    mkdirSync(join(directory, 'lib'))
    mkdirSync(join(directory, 'cloudflare/device-gateway/src'), { recursive: true })
    writeFileSync(join(directory, 'lib/device-presence.ts'), 'export const fixture = true\n')
    writeFileSync(join(directory, 'cloudflare/device-gateway/src/source.ts'), 'export const version = 1\n')
    git(['add', '.']); git(['commit', '--quiet', '-m', 'presence and gateway'])
    const source = git(['rev-parse', 'HEAD'])
    writeFileSync(join(directory, 'business.ts'), 'export const unrelated = true\n')
    git(['add', '.']); git(['commit', '--quiet', '-m', 'business only'])
    const business = git(['rev-parse', 'HEAD'])
    const repository = gitRepository(directory)
    assert.equal(await repository.contains(source, business), true)
    assert.equal(await repository.contains(business, source), false)
    assert.equal(await repository.sameInputs(source, business), true)
    await repository.assertCheckout(business)
    writeFileSync(join(directory, 'cloudflare/device-gateway/src/source.test.ts'), 'export const tests = true\n')
    git(['add', '.']); git(['commit', '--quiet', '-m', 'new gateway regression only'])
    assert.equal(await repository.sameInputs(source, git(['rev-parse', 'HEAD'])), true, 'a test-only push must not abandon an in-flight release')
    mkdirSync(join(directory, 'lib/live'), { recursive: true })
    writeFileSync(join(directory, 'lib/live/presence.ts'), 'export const protocol = 1\n')
    writeFileSync(join(directory, 'lib/device-presence-grant.ts'), 'export const signature = 1\n')
    git(['add', '.']); git(['commit', '--quiet', '-m', 'presence protocol'])
    const presence = git(['rev-parse', 'HEAD'])
    assert.equal(await repository.sameInputs(business, presence), false, 'new signing/protocol inputs must supersede an older Worker release')
    await repository.assertCheckout(presence)
    writeFileSync(join(directory, 'cloudflare/device-gateway/src/source.ts'), 'export const version = 2\n')
    await assert.rejects(() => repository.assertCheckout(presence), /release_checkout_changed/)
    git(['add', '.']); git(['commit', '--quiet', '-m', 'newer gateway'])
    assert.equal(await repository.sameInputs(source, git(['rev-parse', 'HEAD'])), false)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('only production runtime and protocol changes qualify automatic publication', () => {
  for (const p of ['cloudflare/device-gateway/src/route.ts', 'cloudflare/device-gateway/wrangler.jsonc',
    'lib/live/revocation.ts', 'lib/device-presence-grant.ts', 'lib/live/session-ticket.ts']) assert.ok(affectsWorker('device', p))
  for (const p of ['cloudflare/device-gateway/src/route.test.ts', 'cloudflare/device-gateway/test/runtime.test.mjs',
    'scripts/device-gateway/deploy.mjs', 'lib/db/commit-effects.ts', 'lib/db/commit-effects.test.ts',
    '.github/workflows/device-gateway.yml', 'cloudflare/suggestions-cron/src/index.mjs']) assert.equal(affectsWorker('device', p), false)
  assert.ok(affectsWorker('cron', 'cloudflare/suggestions-cron/src/index.mjs'))
  assert.ok(affectsWorker('cron', 'cloudflare/suggestions-cron/wrangler.jsonc'))
  assert.equal(affectsWorker('cron', 'cloudflare/suggestions-cron/src/index.test.mjs'), false)
  assert.throws(() => affectsWorker('unknown', 'any'), /unknown_edge_workload/)
})

test('legacy credentials remain unavailable to ambiguous and Cloudflare origin observations', async () => {
  const question = [{name:'_mikka-release.aspectlylabs.com.', type:16}]
  const answer = [{...question[0], data:'"mikka-release-v1=sha256:' + '1'.repeat(64) + '"'}]
  const cfHeaders = {'cf-ray':'fixture', 'x-mikka-gateway-version-sha256':'2'.repeat(64)}
  const read = (dns, headers) => async (url, init) => {
    assert.equal(init.headers.authorization, undefined)
    return new URL(url).hostname === ALIAS ? Response.json({build:SOURCE}, {headers}) : Response.json(dns)
  }
  assert.equal((await readWebAuthority(read({Status:0, Question:question, Answer:answer}, cfHeaders))).provider, 'cloudflare')
  for (const observer of [read({Status:2, Question:question},{'x-vercel-id':'iad'}), read({Status:3, Question:question},cfHeaders),
    read({Status:0, Question:question, Answer:answer},{'x-vercel-id':'iad'}), read({Status:0, TC:true, Question:question},{'x-vercel-id':'iad'})]) {
    await assert.rejects(readWebAuthority(observer))
  }
})

test('protected promotion is checked twice with version identity, with no Vercel reads or secrets', async () => {
  const promotion = {schema:'mikka.cloudflare-promotion.v1',approvalComment:'1954',approvalSha256:'2'.repeat(64),
    product:SOURCE,overlay:OLD,releasePin:'aaaaaaaa-1953-1',gatewayVersionSha256:'3'.repeat(64),
    inventorySha256:'4'.repeat(64),verifiedAt:'2026-11-12T07:00:00.000Z',outcome:'promoted'}
  for (const next of [promotion, {...promotion,gatewayVersionSha256:'5'.repeat(64)}, {...promotion,product:OLD}, {ready:true}]) {
    const {state,options} = fixture()
    let reads = 0
    const release = deployGateway({...options,vercelToken:undefined, readPromotedWeb:async () => ++reads === 1 ? promotion : next})
    if (next === promotion) {
      assert.equal((await release).production.id, promotion.releasePin)
      assert.equal(state.writes, 1)
    } else {
      await assert.rejects(release)
      assert.equal(state.writes, 0)
    }
    assert.equal(reads, 2)
    assert.ok(state.calls.every(path => path.startsWith('/client/v4/')))
  }
})
