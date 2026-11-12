import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readRendererActions, rendererActionContract } from '../../../lib/renderer-actions.mjs'
import gateway from '../../../cloudflare/web/gateway.mjs'
import release from '../../../cloudflare/web/release.mjs'
import { gatewayConfig, prepareRelease, releaseConfig } from '../../../cloudflare/web/prepare.mjs'

const request = (path, init) => new Request(new URL(path, 'https://app.example'), init)
const services = () => ({
  API: { fetch: r => Response.json({ service: 'api', path: new URL(r.url).pathname }) },
  CLOUD: { fetch: r => Response.json({ service: 'cloud', path: new URL(r.url).pathname }) },
  ASSETS: { fetch: r => new Response(new URL(r.url).pathname === '/index.html' ? '<html lang="zh-CN">app</html>' : 'asset') },
})

test('the real sign-in shell declares shipped PNG, ICO and Apple icons', async () => {
  const shell = await readFile(new URL('../../frontend/index.html', import.meta.url), 'utf8')
  const icons = [...shell.matchAll(/<link\b[^>]*rel="(?:icon|apple-touch-icon)"[^>]*href="([^"]+)"[^>]*>/g)]
    .map(match => match[1])
  assert.equal(icons.length, 5)
  assert.ok(icons.every(path => path.startsWith('/mikka/') && /\.(?:png|ico)$/.test(path)))
  assert.doesNotMatch(shell, /icon\.svg/)
  assert.match(shell, /<meta name="robots" content="noindex,nofollow"/)
  const env = services()
  env.ASSETS.fetch = async req => {
    const path = new URL(req.url).pathname
    if (path === '/index.html') return new Response(shell)
    const content = await readFile(new URL(`../../../public${path}`, import.meta.url))
    return new Response(content, { headers: { 'content-type': path.endsWith('.png') ? 'image/png' : 'image/x-icon' } })
  }
  const page = await release.fetch(request('/mikka/en/sign-in'), env)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /<html lang="en"/)
  for (const path of icons) {
    const response = await release.fetch(request(path), env)
    assert.equal(response.status, 200, path)
    assert.equal(response.headers.get('cache-control'), 'public, max-age=0, must-revalidate')
    const bytes = Buffer.from(await response.arrayBuffer())
    if (path.endsWith('.png')) {
      assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
      const size = path.endsWith('apple-icon.png') ? 180 : Number(/-(\d+)\.png$/.exec(path)[1])
      assert.equal(bytes.readUInt32BE(16), size)
      assert.equal(bytes.readUInt32BE(20), size)
    } else {
      assert.equal(bytes.readUInt32LE(0), 65536)
      assert.equal(bytes.readUInt16LE(4), 3)
    }
  }
})

test('official pages preserve localization, credential referrer policy, raw-index denial and GitHub setup', async () => {
  const env = services()
  const localized = await release.fetch(request('/mikka/en/sign-in', { headers: { 'sec-fetch-dest': 'document' } }), env)
  assert.match(await localized.text(), /lang="en"/)
  assert.match(localized.headers.get('set-cookie'), /NEXT_LOCALE=en/)
  assert.equal(localized.headers.get('cache-control'), 'no-store')
  assert.equal((await release.fetch(request('/mikka/device'), env)).headers.get('referrer-policy'), 'no-referrer')
  for (const path of ['/mikka/index.html', '/mikka/%69ndex.html', '/mikka/.vite/manifest.json', '/mikka/renderer-manifest.json', '/mikka/_headers', '/outside/logo.svg']) {
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
  for (const [path, cache] of [['/mikka/assets/hash.js?dpl=test','public, max-age=31536000, immutable'], ['/mikka/brand/mikka-app-icon-48.png','public, max-age=0, must-revalidate'], ['/mikka/assets/missing.js','no-store']]) {
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

test('GitHub callback keeps one ingress across pins and forwards the signed bytes and backend response', async () => {
  const calls = []
  const original = new TextEncoder().encode('{\r\n  "test": "验收"\r\n}\n')
  const env = { CURRENT_RELEASE: 'new', RELEASES: { old: 'OLD', new: 'NEW' },
    OLD: { fetch: () => new Response('old') }, NEW: { fetch: () => new Response('new') },
    GITHUB_WEBHOOK: { async fetch(input) {
      const url = new URL(input.url)
      assert.ok(['/mikka/api/webhooks/github', '/mikka/api/webhooks/github/'].includes(url.pathname))
      assert.equal(input.headers.get('cloudflare-workers-version-overrides'), null)
      assert.equal(input.headers.get('x-hub-signature-256'), 'test-signature')
      assert.deepEqual(new Uint8Array(await input.arrayBuffer()), original)
      calls.push(input.headers.get('x-github-event'))
      return new Response('upstream', { status: 401 })
    } },
  }
  for (const [path, event] of [['/mikka/api/webhooks/github?dpl=retired', 'workflow_run'],
    ['/mikka/api/webhooks/github/?dpl=new&dpl=old', 'pull_request'], ['/mikka/%61pi/webhooks/%67ithub?dpl=old', 'check_suite']]) {
    const result = await gateway.fetch(request(path, { method: 'POST', body: original, headers: {
      'x-github-event': event, 'x-hub-signature-256': 'test-signature', 'x-deployment-id': 'old',
      'cloudflare-workers-version-overrides': 'untrusted' } }), env)
    assert.equal(result.status, 401)
    assert.equal(await result.text(), 'upstream')
  }
  assert.deepEqual(calls, ['workflow_run', 'pull_request', 'check_suite'])
  assert.equal(await (await gateway.fetch(request('/mikka/api/webhooks/github/other?dpl=old'), env)).text(), 'old')
  env.GITHUB_WEBHOOK = null
  assert.equal((await gateway.fetch(request('/mikka/api/webhooks/github'), env)).status, 503)
  delete env.GITHUB_WEBHOOK
  assert.equal(await (await gateway.fetch(request('/mikka/api/webhooks/github?dpl=old'), env)).text(), 'old')
})

test('gateway config can bind a discrete webhook service for both current and rollback gateways', () => {
  const retained = ['abcdef0-1-1', 'abcdef0-2-1']
  for (const current of retained) {
    const input = { current, retained }
    assert.ok(gatewayConfig(input).services.every(s => s.binding !== 'GITHUB_WEBHOOK'))
    assert.deepEqual(gatewayConfig({ ...input, githubWebhook: 'github-events' }).services.at(-1),
      { binding: 'GITHUB_WEBHOOK', service: 'github-events' })
    for (const githubWebhook of [null, '', 'https://example.test', 'mikka-app-gateway', 'mikka-app-release-' + current]) {
      assert.throws(() => gatewayConfig({ ...input, githubWebhook }), /WEB_GITHUB_WEBHOOK_SERVICE_INVALID/)
    }
  }
})

test('only a successful version read carries the digest of the serving gateway version', async () => {
  const header = 'x-mikka-gateway-version-sha256'
  const id = '7dc7671b-543a-4220-b8d3-58193190ef4b'
  const expected = createHash('sha256').update(id).digest('hex')
  const value = { build: 'source', overlaySha: 'official', minMobileBuild: 0, mobileUpdateUrl: '', minDesktopVersion: null }
  let status = 200
  const env = { CURRENT_RELEASE: 'now', RELEASES: { now: 'APP' }, CF_VERSION_METADATA: { id }, APP: { fetch(input) {
    assert.equal(input.headers.has(header), false)
    return new Response(input.method === 'HEAD' ? null : JSON.stringify(value), {
      status, headers: { [header]: 'spoofed', 'cache-control': 'no-store' },
    })
  } } }
  const read = (path, method = 'GET') => gateway.fetch(request(path, { method, headers: { [header]: 'spoofed-client' } }), env)
  const get = await read('/mikka/api/version?dpl=stale')
  assert.equal(get.headers.get(header), expected)
  assert.deepEqual(await get.json(), value)
  const head = await read('/mikka/api/%76ersion', 'HEAD')
  assert.equal(head.headers.get(header), expected)
  assert.equal(head.headers.get('cache-control'), 'no-store')
  assert.equal(await head.text(), '')
  status = 503
  assert.equal((await read('/mikka/api/version')).headers.has(header), false)
  status = 200
  for (const binding of [undefined, { id: id.toUpperCase() }, { id: 'unknown' }]) {
    env.CF_VERSION_METADATA = binding
    assert.equal((await read('/mikka/api/version')).headers.has(header), false)
  }
  const stream = new Response(new ReadableStream(), { headers: { [header]: 'upstream-only' } })
  env.APP.fetch = input => { assert.equal(input.headers.get(header), 'spoofed-client'); return stream }
  for (const [path, method] of [['/mikka/api/version', 'POST'], ['/mikka/api/status', 'GET']]) {
    assert.equal(await read(path, method), stream)
  }
  await stream.body.cancel()
})

test('encoded route and asset names retain the same deployment and cache contract', async () => {
  const env = { CURRENT_RELEASE: 'new', RELEASES: { old: 'OLD', new: 'NEW' } }
  const seen = []
  for (const [id, binding] of Object.entries(env.RELEASES)) {
    const releaseEnv = services()
    releaseEnv.RELEASE_SHA = id
    releaseEnv.OVERLAY_SHA = id + '-ui'
    releaseEnv.API.fetch = async req => {
      const path = new URL(req.url).pathname
      seen.push([id, path])
      if (path === '/mikka/api/version') {
        assert.equal(req.method, 'GET')
        assert.equal(req.headers.has('cookie'), false)
        return Response.json({ build: id, overlaySha: id + '-ui', minMobileBuild: 0, mobileUpdateUrl: '', minDesktopVersion: null })
      }
      assert.equal(await req.text(), 'existing stream request')
      return new Response(id)
    }
    releaseEnv.ASSETS.fetch = () => new Response(id)
    env[binding] = { fetch: req => release.fetch(req, releaseEnv) }
  }
  const stream = '/mikka/%61pi/agents/stream'
  const retained = await gateway.fetch(request(stream, { method: 'POST', headers: { 'x-deployment-id': 'old' }, body: 'existing stream request' }), env)
  assert.equal(await retained.text(), 'old')
  assert.deepEqual(seen, [['old', stream]])
  const stale = await gateway.fetch(request(stream + '?dpl=retired'), env)
  assert.equal(stale.status, 409)
  const conflict = await gateway.fetch(request(stream + '?dpl=new', { headers: { 'x-deployment-id': 'old' } }), env)
  assert.equal(conflict.status, 400)
  const file = await gateway.fetch(request('/mikka/assets/example%2Ejs?dpl=old'), env)
  assert.equal(await file.text(), 'old')
  assert.equal(file.headers.get('cache-control'), 'public, max-age=31536000, immutable')
  for (const [route, method] of [['/mikka/%61pi/version', 'GET'], ['/mikka/api/%76ersion', 'HEAD']]) {
    const result = await gateway.fetch(request(route + '?dpl=old', { method, headers: { cookie: 'fixture' } }), env)
    assert.equal(result.headers.get('cache-control'), 'no-store, max-age=0')
    if (method === 'GET') assert.equal((await result.json()).build, 'new')
    else assert.equal(await result.text(), '')
  }
  assert.deepEqual(seen, [['old', stream], ['new', '/mikka/api/version']])
})

test('release config requires the official compiled shell, matching pins and private service bindings', async t => {
  const assets = await mkdtemp(join(tmpdir(), 'cf-web-'))
  t.after(() => rm(assets, { recursive: true, force: true }))
  const input = { sourceSha: 'abcdef0' + '0'.repeat(33), overlaySha: 'b'.repeat(40), id: 'abcdef0-1-1', assets, api: 'mikka-api-fixture', cloud: 'mikka-cloud-fixture' }
  const inventory = { version: 1, rendererBuild: 'a'.repeat(64), usedActions: ['issues.pollIssue'],
    modules: { issues: ['pollIssue', 'unusedAction'], internal: ['privateExport'] }, target: 'web', serverModules: [], inputs: ['components/slots/navigation.tsx'] }
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
  const parent = await mkdtemp(join(tmpdir(), 'cf-web-publish-'))
  t.after(() => rm(parent, { recursive: true, force: true }))
  await mkdir(join(assets, '.vite'))
  await writeFile(join(assets, '.vite', 'manifest.json'), '{}')
  await writeFile(join(assets, '_redirects'), '/old /new')
  const ready = await prepareRelease(input, parent)
  assert.deepEqual((await readdir(ready.assets.directory)).sort(), ['index.html', 'renderer-actions.json'])
  const actions = JSON.parse(await readFile(join(ready.assets.directory, 'renderer-actions.json'), 'utf8'))
  assert.deepEqual(actions, { version: 1, target: 'web', rendererBuild: 'a'.repeat(64),
    usedActions: ['issues.pollIssue'], modules: { issues: ['pollIssue'] } })
  assert.equal(await readFile(join(ready.assets.directory, 'index.html'), 'utf8'), await readFile(join(assets, 'index.html'), 'utf8'))
  assert.ok((await readFile(join(assets, 'renderer-manifest.json'), 'utf8')).includes('.hosted-ui'))
  await assert.rejects(prepareRelease(input, assets), /OUTPUT_INSIDE_BUILD/)
  await writeFile(join(assets, 'chunk.js.map'), '{}')
  await assert.rejects(releaseConfig(input), /sourceInOutput/)
  assert.throws(() => gatewayConfig({ current: 'new', retained: ['old'] }), /RETENTION_INVALID/)
  const routes = gatewayConfig({ current: input.id, retained: ['abcdef0-0-1', input.id] })
  assert.deepEqual(routes.version_metadata, { binding: 'CF_VERSION_METADATA' })
  assert.equal(routes.services[1].service, config.name)
})

test('version reads only public fields from the release backend, once per warm binding; HEAD is bodyless', async () => {
  const source = 'a'.repeat(40), overlay = 'b'.repeat(40)
  const value = { build: source, overlaySha: overlay, minMobileBuild: 0, mobileUpdateUrl: 'itms-beta://app', minDesktopVersion: null }
  let calls = 0
  const env = { RELEASE_SHA: source, OVERLAY_SHA: overlay, API: { async fetch(req) {
    calls++
    assert.equal(req.headers.get('cookie'), null)
    assert.equal(req.headers.get('authorization'), null)
    assert.equal(req.method, 'GET')
    assert.equal(new URL(req.url).search, '')
    return Response.json(value)
  } } }
  const first = await release.fetch(request('/mikka/api/version?dpl=old', { headers: { cookie: 'fixture', authorization: 'fixture' } }), env)
  assert.deepEqual(await first.json(), value)
  const head = await release.fetch(request('/mikka/api/version', { method: 'HEAD' }), env)
  assert.equal(await head.text(), '')
  assert.equal(head.headers.get('cache-control'), 'no-store, max-age=0')
  assert.equal(calls, 1)
  assert.equal((await release.fetch(request('/mikka/api/version'), { ...env, RELEASE_SHA: 'c'.repeat(40) })).status, 503)
  assert.equal(calls, 2)
})

test('version recovers from a stale overlay, unavailable backend and invalid document, without caching failures', async () => {
  const source = 'a'.repeat(40), overlay = 'b'.repeat(40)
  const value = { build: source, overlaySha: overlay, minMobileBuild: 0, mobileUpdateUrl: 'itms-beta://app', minDesktopVersion: null }
  const replies = [Response.json({ ...value, overlaySha: source }), Response.redirect('https://example.test/'),
    new Response('broken', { headers: { 'content-type': 'application/json' } }), Response.json({ ...value, unrecognized: true }), Response.json(value)]
  const env = { RELEASE_SHA: source, OVERLAY_SHA: overlay, API: { fetch: async () => replies.shift() } }
  for (let i = 0; i < 4; i++) assert.equal((await release.fetch(request('/mikka/api/version'), env)).status, 503)
  assert.deepEqual(await (await release.fetch(request('/mikka/api/version'), env)).json(), value)
})

test('rejected or stalled cold version reads free the upstream and an independent request can recover', async t => {
  const source = 'a'.repeat(40), overlay = 'b'.repeat(40)
  const value = { build: source, overlaySha: overlay, minMobileBuild: 0, mobileUpdateUrl: '', minDesktopVersion: null }
  let cancelled = false
  const env = { RELEASE_SHA: source, OVERLAY_SHA: overlay, API: { fetch: async () => new Response(new ReadableStream({
    cancel() { cancelled = true },
  }), { status: 502 }) } }
  const get = (e, init) => release.fetch(request('/mikka/api/version', init), e)
  const bad = await get(env)
  assert.equal(bad.status, 502)
  assert.equal(cancelled, true)
  assert.equal(bad.headers.get('cache-control'), 'no-store')
  env.API.fetch = async () => new Response(new ReadableStream({
    start(controller) { controller.error(new Error('upstream body already closed')) },
  }), { status: 429 })
  assert.equal((await get(env)).status, 429)

  const deadline = new AbortController()
  const timeout = t.mock.method(AbortSignal, 'timeout', ms => {
    assert.equal(ms, 5_000)
    return deadline.signal
  })
  const pending = () => {
    const started = Promise.withResolvers()
    env.API.fetch = req => {
      started.resolve()
      return new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true }))
    }
    return started.promise
  }
  const route = request('/mikka/api/version')
  const ready = pending(), slow = release.fetch(route, env)
  await ready
  deadline.abort(new DOMException('Timed out', 'TimeoutError'))
  const failed = await slow
  assert.equal(route.signal.aborted, false)
  assert.equal(failed.status, 503)
  assert.deepEqual(await failed.json(), { error: 'deploymentVersionUnavailable' })
  timeout.mock.restore()

  const caller = new AbortController()
  const active = pending(), disconnected = get(env, { signal: caller.signal })
  await active
  caller.abort()
  await assert.rejects(disconnected, { name: 'AbortError' })
  env.API.fetch = async () => Response.json(value)
  assert.deepEqual(await (await get(env)).json(), value)
  env.API.fetch = () => assert.fail('unexpected upstream read')
  assert.equal((await get(env, { method: 'HEAD' })).status, 200)
})

test('separate version bindings do not share cached values and private requests keep caller scope', async () => {
  const publicFields = { build: 'a'.repeat(40), overlaySha: 'b'.repeat(40), minMobileBuild: 0, minDesktopVersion: null }
  const scope = mobileUpdateUrl => ({
    RELEASE_SHA: publicFields.build, OVERLAY_SHA: publicFields.overlaySha,
    API: { async fetch(req) {
      if (req.method === 'GET' && new URL(req.url).pathname === '/mikka/api/version') {
        assert.equal(req.headers.get('authorization'), null)
        assert.equal(req.headers.get('cookie'), null)
        return Response.json({ ...publicFields, mobileUpdateUrl })
      }
      return new Response(req.headers.get('authorization'), { status: 202, headers: { 'cache-control': 'private, no-store' } })
    } },
  })
  const first = scope('itms-beta://first'), second = scope('itms-beta://second')
  for (const [env, link, tenant] of [[first, 'itms-beta://first', 'A'], [second, 'itms-beta://second', 'B'], [first, 'itms-beta://first', 'C']]) {
    const headers = { authorization: 'Bearer scope-' + tenant, cookie: 'workspace=' + tenant }
    const result = await release.fetch(request('/mikka/api/version', { headers }), env)
    assert.equal((await result.json()).mobileUpdateUrl, link)
    for (const path of ['/mikka/api/rpc', '/mikka/api/version']) {
      const reply = await release.fetch(request(path, { method: 'POST', headers, body: 'opaque' }), env)
      assert.equal(reply.status, 202)
      assert.equal(reply.headers.get('cache-control'), 'private, no-store')
      assert.equal(await reply.text(), headers.authorization)
    }
  }
})

test('published actions retain the compiler evidence and use the same deployment pin on the private-manifest 404', async () => {
  const compiled = { version: 1, target: 'web', rendererBuild: 'b'.repeat(64),
    usedActions: ['issues.pollIssue'], modules: { issues: ['pollIssue', 'unused'] } }
  const contract = rendererActionContract(compiled)
  for (const changed of [{ rendererBuild: 'wrong' }, { modules: {} },
    { modules: { issues: ['pollIssue', 'pollIssue'] } }, { usedActions: ['issues.unregistered'] }]) {
    assert.throws(() => rendererActionContract({ ...compiled, ...changed }))
  }
  const calls = []
  const result = await readRendererActions(async path => {
    calls.push(path)
    return path.includes('renderer-manifest') ? new Response(null, { status: 404 }) : Response.json(contract)
  }, '/mikka', 'abcdef0-1-1')
  assert.deepEqual(calls, ['/mikka/renderer-manifest.json?dpl=abcdef0-1-1', '/mikka/renderer-actions.json?dpl=abcdef0-1-1'])
  assert.deepEqual(await result.json(), contract)
  for (const status of [200, 401, 403, 500]) {
    let count = 0
    assert.equal((await readRendererActions(async () => { count++; return new Response(null, { status }) })).status, status)
    assert.equal(count, 1)
  }
})
