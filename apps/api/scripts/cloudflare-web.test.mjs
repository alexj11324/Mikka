import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import gateway from '../../../cloudflare/web/gateway.mjs'
import release from '../../../cloudflare/web/release.mjs'
import { gatewayConfig, releaseConfig } from '../../../cloudflare/web/prepare.mjs'

const request = (path, init) => new Request(new URL(path, 'https://app.example'), init)
const services = () => ({
  API: { fetch: r => Response.json({ service: 'api', path: new URL(r.url).pathname }) },
  CLOUD: { fetch: r => Response.json({ service: 'cloud', path: new URL(r.url).pathname }) },
  ASSETS: { fetch: r => new Response(new URL(r.url).pathname === '/index.html' ? '<html lang="zh-CN">app</html>' : 'asset') },
})

test('official pages preserve localization, credential referrer policy, raw-index denial and GitHub setup', async () => {
  const env = services()
  const localized = await release.fetch(request('/mikka/en/sign-in', { headers: { 'sec-fetch-dest': 'document' } }), env)
  assert.match(await localized.text(), /lang="en"/)
  assert.match(localized.headers.get('set-cookie'), /NEXT_LOCALE=en/)
  assert.equal(localized.headers.get('cache-control'), 'no-store')
  assert.equal((await release.fetch(request('/mikka/device'), env)).headers.get('referrer-policy'), 'no-referrer')
  for (const path of ['/mikka/index.html', '/mikka/%69ndex.html', '/mikka/.vite/manifest.json', '/outside/logo.svg']) {
    assert.equal((await release.fetch(request(path), env)).status, 404)
  }
  const setup = await release.fetch(request('/mikka?installation_id=123&state=mikka-gh.' + 'a'.repeat(36) + '.' + 'b'.repeat(43)), env)
  assert.equal(setup.status, 302)
  assert.equal(new URL(setup.headers.get('location')).pathname, '/mikka/cloud/v1/github/setup')
})

test('assets drop credentials, keep conditional requests, and only cache successful immutable files', async () => {
  const env = services()
  env.ASSETS.fetch = r => {
    assert.equal(r.headers.get('authorization'), null)
    assert.equal(r.headers.get('cookie'), null)
    assert.equal(r.headers.get('if-none-match'), '"hash"')
    const url = new URL(r.url)
    assert.equal(url.search, '')
    return new Response(null, { status: url.pathname.endsWith('missing.js') ? 404 : 304 })
  }
  for (const [path, cache] of [['/mikka/assets/hash.js?dpl=test','public, max-age=31536000, immutable'], ['/mikka/icon.svg','public, max-age=0, must-revalidate'], ['/mikka/assets/missing.js','no-store']]) {
    const response = await release.fetch(request(path, { headers: { authorization: 'fixture', cookie: 'fixture', 'if-none-match': '"hash"' } }), env)
    assert.equal(response.headers.get('cache-control'), cache)
  }
})

test('machine and private cloud paths preserve request identity, streaming bodies and backend status', async () => {
  for (const [path, binding] of [['/mikka/%61pi/agents/stream','API'], ['/.well-known/workflow/v1/step','API'], ['/mikka/cloud/v1/github/setup','CLOUD'], ['/mikka/%63loud/v1/github/setup','CLOUD']]) {
    const env = services(), input = request(path, { method: 'POST', body: 'fixture' })
    const source = new Response('data: event\n\n', { headers: { 'content-type': 'text/event-stream' } })
    env[binding].fetch = async r => { assert.equal(r, input); assert.equal(await r.text(), 'fixture'); return source }
    assert.equal(await release.fetch(input, env), source)
  }
})

test('gateway honors retained asset/API pins, uses current for version and navigation, rejects missing and conflicting pins', async () => {
  const env = { CURRENT_RELEASE: 'new', RELEASES: { old: 'OLD', new: 'NEW' } }
  for (const binding of ['NEW', 'OLD']) env[binding] = { fetch: r => {
    assert.equal(r.headers.has('cloudflare-workers-version-overrides'), false)
    return new Response(binding)
  } }
  const go = (path, headers = {}) => gateway.fetch(request(path, { headers: { 'cloudflare-workers-version-overrides': 'untrusted', ...headers } }), env)
  assert.equal(await (await go('/mikka/api/rpc', { 'x-deployment-id': 'old' })).text(), 'OLD')
  assert.equal(await (await go('/mikka/assets/old.js?dpl=old')).text(), 'OLD')
  assert.equal(await (await go('/mikka/api/version?dpl=old', { 'x-deployment-id': 'old' })).text(), 'NEW')
  assert.equal(await (await go('/mikka/en/sign-in?dpl=old')).text(), 'NEW')
  assert.equal((await go('/mikka/api/rpc', { 'x-deployment-id': 'retired' })).status, 409)
  assert.equal((await go('/mikka/assets/chunk.js?dpl=new&dpl=old')).status, 400)
  assert.equal((await go('/mikka/api/rpc?dpl=new', { 'x-deployment-id': 'old' })).status, 400)
  assert.equal((await go('/mikka/assets/chunk.js?dpl=constructor')).status, 409)
  delete env.NEW
  assert.equal((await go('/mikka/api/version')).status, 503)
})

test('release config requires the official compiled shell, matching pins and private service bindings', async t => {
  const assets = await mkdtemp(join(tmpdir(), 'cf-web-'))
  t.after(() => rm(assets, { recursive: true, force: true }))
  const input = { id: 'abcdef0-1-1', assets, api: 'mikka-api-fixture', cloud: 'mikka-cloud-fixture' }
  const inventory = { target: 'web', serverModules: [], inputs: ['components/slots/navigation.tsx'] }
  const put = data => writeFile(join(assets, 'renderer-manifest.json'), JSON.stringify(data))
  await put(inventory)
  await writeFile(join(assets, 'index.html'), '<script src="/mikka/assets/main.js?dpl=abcdef0-1-1"></script>')
  await assert.rejects(releaseConfig(input), /OFFICIAL_UI_REQUIRED/)
  await put({ ...inventory, inputs: ['.hosted-ui/slots/navigation.tsx'] })
  const config = await releaseConfig(input)
  assert.equal(config.workers_dev, false)
  assert.equal(config.preview_urls, false)
  assert.equal(config.assets.run_worker_first, true)
  assert.equal(config.assets.html_handling, 'none')
  await assert.rejects(releaseConfig({ ...input, id: 'abcdef0-2-1' }), /PIN_MISMATCH/)
  await writeFile(join(assets, 'chunk.js.map'), '{}')
  await assert.rejects(releaseConfig(input), /sourceInOutput/)
  assert.throws(() => gatewayConfig({ current: 'new', retained: ['old'] }), /RETENTION_INVALID/)
  const routes = gatewayConfig({ current: input.id, retained: ['abcdef0-0-1', input.id] })
  assert.equal(routes.services[1].service, config.name)
})
