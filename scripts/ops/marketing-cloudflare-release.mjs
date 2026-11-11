import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { releaseIdentity } from '../release/ci-gate.mjs'

const account = 'd8f6630c7869111a5139bc5ed4d24ace'
const zone = 'c71d288fdeb11a7ebf3c179d8a4961c8'
const apex = 'aspectlylabs.com'
const www = 'www.aspectlylabs.com'
const staging = 'https://mikka-marketing-staging.orvilo-preview.workers.dev'
const expected = {
  source: 'b0b06c7ca67c0fdeec115fe5693ba2944fb4397c', buildId: 'eMdbNKbma_qazyrLGcbbb',
  stageVersion: 'f36a479f-a46d-49e1-a66c-8380dff15c7e', prodVersion: '4585533a-28ba-44b5-8dea-7c1d621ff177',
  stageEtag: '506272d6c16e78199785c5cea368ddf968e66031592aa5e01d2d7fa0f4422929', prodEtag: '506272d6c16e78199785c5cea368ddf968e66031592aa5e01d2d7fa0f4422929',
}
const records = [
  { name: www, id: '0604716318108604a5996ac8ed151589', type: 'CNAME', origin: 'cname.vercel-dns.com', target: apex },
  { name: apex, id: 'c637fdf7438d15660c23f38268e89226', type: 'A', origin: '76.76.21.21', target: '192.0.2.1' },
]
const routePattern = apex + '/*'
const redirect = {
  ref: 'mikka_marketing_www_apex', description: 'Preserve the marketing www canonical redirect',
  expression: '(http.host eq "www.aspectlylabs.com")', action: 'redirect', enabled: true,
  action_parameters: { from_value: { status_code: 308, target_url: { expression: 'concat("https://aspectlylabs.com", http.request.uri.path)' }, preserve_query_string: true } },
}
const zonePath = '/zones/' + zone
const workersPath = '/accounts/' + account + '/workers/scripts/'
const operation = process.argv[2]

async function api(method, path, body, optional = false) {
  const response = await fetch('https://api.cloudflare.com/client/v4' + path, {
    method, headers: { authorization: 'Bearer ' + process.env.CLOUDFLARE_API_TOKEN, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000),
  })
  if (optional && response.status === 404) return null
  const data = await response.json()
  if (!response.ok || !data.success) throw Error('Cloudflare ' + method + ' ' + path + ' HTTP ' + response.status + ' errors ' + (data.errors ?? []).map(e => e.code).join(','))
  return data.result
}
async function checkMain() {
  const identity = releaseIdentity(process.env)
  assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, account)
  const response = await fetch('https://api.github.com/repos/' + identity.repository + '/git/ref/heads/main', {
    headers: { authorization: 'Bearer ' + process.env.GITHUB_TOKEN }, signal: AbortSignal.timeout(15000),
  })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).object.sha, identity.sha)
}
async function get(url) {
  return fetch(url, { redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(15000) })
}
async function releaseAt(origin) {
  const res = await get(origin + '/.well-known/mikka-release')
  assert.equal(res.status, 200)
  assert.ok(res.headers.get('cf-ray'))
  assert.deepEqual(await res.json(), { source: expected.source, buildId: expected.buildId })
}
async function smoke(origin) {
  await releaseAt(origin)
  const doc = await get(origin + '/mikka/docs/quickstart')
  assert.equal(doc.status, 200)
  const html = await doc.text()
  assert.ok(html.includes('Quickstart'))
  const fingerprints = [...new Set(html.match(/phc_[A-Za-z0-9]+/g) ?? [])].map(token => createHash('sha256').update(token).digest('hex').slice(0, 12))
  assert.ok(fingerprints.includes('b274b9d626b4'), 'Expected the existing public PostHog ingest project')
  const search = await get(origin + '/api/search?query=Quickstart')
  assert.ok((await search.json()).some(hit => hit.url?.includes('/mikka/docs/quickstart')))
  const icon = await get(origin + '/brand/mikka-app-icon.png')
  assert.equal(icon.status, 200)
  assert.equal(icon.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(createHash('sha256').update(Buffer.from(await icon.arrayBuffer())).digest('hex'), '1ac5e4de2016ed71c3ded137f0703fa4a6bd2f15bdcbe3378b06f62089b68bed')
}
async function version(script, id, etag) {
  const record = await api('GET', workersPath + script + '/versions/' + id)
  assert.equal(record.id, id)
  assert.equal(record.resources.script.etag, etag)
  assert.equal(record.annotations['workers/tag'], expected.source)
  assert.ok(record.resources.bindings.some(b => b.name === 'ASSETS' && b.type === 'assets'))
  return record
}
async function currentDeployments(script) {
  const value = await api('GET', workersPath + script + '/deployments')
  return (Array.isArray(value) ? value : value.deployments).at(0)?.versions
}
async function checkCandidate() {
  await smoke(staging)
  await version('mikka-marketing-staging', expected.stageVersion, expected.stageEtag)
  assert.deepEqual(await currentDeployments('mikka-marketing-staging'), [{ version_id: expected.stageVersion, percentage: 100 }])
  const prod = await version('mikka-marketing', expected.prodVersion, expected.prodEtag)
  assert.ok(prod.resources.bindings.some(b => b.type === 'queue' && b.name === 'SITE_VISITS' && b.queue_name === 'mikka-marketing-visits-48h'))
  const queues = await api('GET', '/accounts/' + account + '/queues?name=mikka-marketing-visits-48h')
  const queue = queues.find(q => q.queue_name === 'mikka-marketing-visits-48h')
  assert.equal(queue?.queue_id, 'f454165bbbc647d5bda8d6750d87c948')
  assert.ok(queue.settings.message_retention_period > 0 && queue.settings.message_retention_period <= 172800)
  assert.ok(Array.isArray(queue.consumers) && queue.consumers.length === queue.consumers_total_count && queue.consumers.every(c => c.type === 'http_pull' && !c.dead_letter_queue))
}
async function readRecord(record) {
  const dns = await api('GET', zonePath + '/dns_records/' + record.id)
  assert.equal(dns.name, record.name)
  assert.equal(dns.type, record.type)
  assert.equal(dns.ttl, 1)
  const actual = dns.content.replace(/\.$/, '')
  if (!dns.proxied && actual === record.origin) return 'vercel'
  if (dns.proxied && actual === record.target) return 'cloudflare'
  throw Error('Unexpected DNS state for ' + record.name)
}
async function changeRecord(record, target) {
  if (await readRecord(record) === target) return
  await api('PATCH', zonePath + '/dns_records/' + record.id, {
    content: target === 'vercel' ? record.origin : record.target, proxied: target === 'cloudflare', ttl: 1,
  })
  assert.equal(await readRecord(record), target)
}
async function prepareRoutes() {
  const certs = await api('GET', zonePath + '/ssl/certificate_packs')
  assert.ok(certs.some(c => c.status === 'active' && c.hosts.includes(apex) && c.hosts.includes('*.' + apex)))
  const rulesPath = zonePath + '/rulesets'
  const endpoint = await api('GET', rulesPath + '/phases/http_request_dynamic_redirect/entrypoint', undefined, true)
  const existing = endpoint?.rules?.find(r => r.ref === redirect.ref)
  if (existing) {
    for (const key of ['action', 'expression', 'enabled', 'action_parameters']) assert.deepEqual(existing[key], redirect[key])
  } else if (!endpoint) {
    await api('POST', rulesPath, { name: 'Marketing canonical hostname', kind: 'zone', phase: 'http_request_dynamic_redirect', rules: [redirect] })
  } else {
    await api('POST', rulesPath + '/' + endpoint.id + '/rules', redirect)
  }
  const routesPath = zonePath + '/workers/routes'
  const routes = await api('GET', routesPath)
  const previous = routes.find(r => r.pattern === routePattern)
  if (previous) assert.equal(previous.script, 'mikka-marketing')
  else await api('POST', routesPath, { pattern: routePattern, script: 'mikka-marketing' })
}
async function verifyHost(record, target) {
  if (record.name === apex) {
    if (target === 'cloudflare') return releaseAt('https://' + apex)
    const home = await get('https://' + apex + '/mikka')
    assert.equal(home.status, 200)
    assert.ok(home.headers.get('x-vercel-id'))
    return
  }
  const path = '/brand/mikka-app-icon.png?utm_source=migration'
  const reply = await get('https://' + www + path)
  assert.equal(reply.status, 308)
  assert.equal(reply.headers.get('location'), 'https://' + apex + path)
  if (target === 'vercel') assert.ok(reply.headers.get('x-vercel-id'))
  else assert.ok(reply.headers.get('cf-ray') && !reply.headers.get('x-vercel-id'))
}
async function waitForDNS(record, target = 'cloudflare') {
  const end = Date.now() + 6 * 60000
  for (;;) {
    try { await verifyHost(record, target); return } catch (cause) {
      if (Date.now() >= end) throw Error('External DNS/TLS witness failed for ' + record.name, { cause })
      await delay(10000)
    }
  }
}
async function rollback() {
  const failures = []
  for (const record of [...records].reverse()) {
    try { await changeRecord(record, 'vercel') } catch (error) { failures.push(error) }
  }
  if (failures.length) throw new AggregateError(failures, 'Marketing DNS rollback incomplete')
  await Promise.all(records.map(record => waitForDNS(record, 'vercel')))
  // DNS now resolves to the verified fallback. Remove only this release's
  // dedicated route/rule, preserving every unrelated zone resource.
  const routesPath = zonePath + '/workers/routes'
  const routes = await api('GET', routesPath)
  const route = routes.find(r => r.pattern === routePattern && r.script === 'mikka-marketing')
  if (route) await api('DELETE', routesPath + '/' + route.id)
  const rulesPath = zonePath + '/rulesets'
  const ruleset = await api('GET', rulesPath + '/phases/http_request_dynamic_redirect/entrypoint', undefined, true)
  const rule = ruleset?.rules.find(r => r.ref === redirect.ref)
  if (rule && rule.expression === redirect.expression) await api('DELETE', rulesPath + '/' + ruleset.id + '/rules/' + rule.id)
}
async function main() {
  if (operation === 'verify-staging') return smoke(staging)
  assert.ok(['publish', 'cutover', 'rollback'].includes(operation))
  await checkMain()
  if (operation === 'rollback') return rollback()
  await checkCandidate()
  if (operation === 'publish') {
    await api('POST', workersPath + 'mikka-marketing/deployments', {
      strategy: 'percentage', versions: [{ version_id: expected.prodVersion, percentage: 100 }],
      annotations: { 'workers/message': 'Marketing main ' + expected.source },
    })
    return
  }
  assert.deepEqual(await currentDeployments('mikka-marketing'), [{ version_id: expected.prodVersion, percentage: 100 }])
  const before = await Promise.all(records.map(readRecord))
  await prepareRoutes()
  try {
    if (before.every(target => target === 'vercel')) {
      // The www host only redirects. Rehearse the live fallback there before
      // moving the apex document and asset traffic.
      await changeRecord(records[0], 'cloudflare')
      await waitForDNS(records[0])
      await changeRecord(records[0], 'vercel')
      await waitForDNS(records[0], 'vercel')
      console.log('Verified www Cloudflare redirect and original Vercel fallback')
    }
    for (const record of records) {
      await checkMain()
      await changeRecord(record, 'cloudflare')
      await waitForDNS(record)
    }
    await smoke('https://' + apex)
  } catch (cause) {
    await rollback()
    throw Error('Marketing release failed; previous DNS restored', { cause })
  }
}
await main()
console.log(JSON.stringify({ operation, source: expected.source, buildId: expected.buildId, version: expected.prodVersion }))
