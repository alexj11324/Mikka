import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { CodedError } from '@mikka/protocol/coded-error'
import { issueEgressCapability } from './egress-capability'
import {
  EGRESS_MAX_REQUEST_BYTES, EGRESS_MAX_RESPONSE_BYTES, executeEgressRequest, isPublicEgressAddress, pinnedEgressRequestOptions,
  type EgressHttpOptions, type EgressHttpRequest, type EgressHttpTarget, type EgressUpstreamResponse,
} from './egress-http'

const env = { WORKSPACE_SECRETS_KEY: randomBytes(32).toString('hex') }
const now = Date.parse('2026-11-08T12:00:00.000Z')
const secret = 'synthetic-only-canary-secret-1'
const grantInput = {
  ownerId: 'owner-a', workspaceId: 'workspace-a', repository: 'owner/repository', runId: 'run-a', deviceId: 'device-a', deviceTokenId: 'token-a', attempt: 1,
  name: 'EXAMPLE_API_KEY', secret,
  http: { origin: 'https://api.example.com', header: 'authorization' as const, prefix: 'Bearer ', rules: [
    { method: 'GET' as const, path: '/v1/widgets', match: 'prefix' as const },
    { method: 'POST' as const, path: '/v1/widgets', match: 'exact' as const },
  ] }, leaseExpiresAt: now + 90_000,
}
const capability = issueEgressCapability(grantInput, now, env).capability
const request: EgressHttpRequest = { capability, method: 'GET', path: '/v1/widgets?limit=2', headers: [['accept', 'application/json']] }
const reason = (detail: string) => (error: unknown) => error instanceof CodedError && error.code === 'task_secret_unavailable' && error.detail === detail
const ok = (): EgressUpstreamResponse => ({ status: 200, headers: [['content-type', 'application/json']], body: Buffer.from('{"items":[]}') })

function fixture(overrides: EgressHttpOptions = {}) {
  const targets: EgressHttpTarget[] = [], hosts: string[] = []
  const options: EgressHttpOptions = {
    env, now: () => now,
    resolve: async hostname => { hosts.push(hostname); return [{ address: '93.184.216.34', family: 4 }] },
    transport: async target => { targets.push(target); return ok() },
    ...overrides,
  }
  return { targets, hosts, options, run: (input: EgressHttpRequest = request) => executeEgressRequest(input, { runId: 'run-a' }, options) }
}

test('the trusted boundary injects only its sealed credential and preserves supported request/response bytes', async () => {
  const f = fixture({ transport: async target => {
    f.targets.push(target)
    return { status: 201, headers: [['content-type', 'application/json'], ['retry-after', '2'], ['set-cookie', 'unrelated=1']], body: Buffer.from('{"id":"new"}') }
  } })
  const body = Buffer.from('{"name":"example"}')
  const result = await f.run({ ...request, method: 'POST', path: '/v1/widgets', headers: [['Content-Type', 'application/json'], ['idempotency-key', 'request-1']], bodyBase64: body.toString('base64') })
  assert.deepEqual(f.hosts, ['api.example.com'])
  assert.equal(f.targets.length, 1)
  const target = f.targets[0]
  assert.equal(target.url.href, 'https://api.example.com/v1/widgets')
  assert.equal(target.headers.authorization, `Bearer ${secret}`)
  assert.equal(target.headers['accept-encoding'], 'identity')
  assert.deepEqual(target.body, body)
  assert.deepEqual(target.address, { address: '93.184.216.34', family: 4 })
  assert.deepEqual(result, { status: 201, headers: { 'content-type': 'application/json', 'retry-after': '2' }, bodyBase64: Buffer.from('{"id":"new"}').toString('base64') })
  assert.ok(!JSON.stringify(result).includes(secret))
})

test('route run binding and expiry fail before DNS or upstream work', async () => {
  const f = fixture()
  await assert.rejects(executeEgressRequest(request, { runId: 'run-b' }, f.options), reason('binding_mismatch'))
  await assert.rejects(executeEgressRequest(request, { runId: 'run-a' }, { ...f.options, now: () => now + 90_000 }), reason('expired_capability'))
  await assert.rejects(f.run({ ...request, capability: `${capability}=bad` }), reason('invalid_capability'))
  assert.deepEqual(f.hosts, []); assert.deepEqual(f.targets, [])
})

test('origin, path and method cannot be widened by URL parsing or a prefix collision', async () => {
  const f = fixture()
  for (const path of ['//evil.example/v1/widgets', 'https://evil.example/v1/widgets', '/v1/widgets\\evil', '/v1/widgets#fragment', '/v1/widgets\r\nX-Host: evil', '/v1/widgets/with space'])
    await assert.rejects(f.run({ ...request, path }), reason('invalid_request'), path)
  for (const path of ['/v1/widgetsevil', '/v1/widgets;admin', '/v1/widgets/../admin', '/v1/widgets/%2e%2e/admin', '/v1/widgets/%252e%252e/admin', '/v1/widgets//admin', '/v1/other'])
    await assert.rejects(f.run({ ...request, path }), reason('destination_denied'), path)
  await assert.rejects(f.run({ ...request, method: 'DELETE' }), reason('destination_denied'))
  await assert.rejects(f.run({ ...request, method: 'get' }), reason('invalid_request'))
  await assert.rejects(f.run({ ...request, method: 'CONNECT' }), reason('invalid_request'))
  await assert.rejects(f.run({ ...request, method: 'POST', path: '/v1/widgets/subresource' }), reason('destination_denied'))
  assert.deepEqual(f.hosts, [])
  await f.run({ ...request, path: '/v1/widgets/item-1?cursor=a%2Fb' })
  assert.equal(f.targets[0].url.search, '?cursor=a%2Fb')
})

test('authentication, host, proxy, cookie and duplicate headers cannot enter the upstream request', async () => {
  const f = fixture()
  for (const name of ['authorization', 'AUTHORIZATION', 'x-api-key', 'api-key', 'x-goog-api-key', 'host', 'cookie', 'proxy-authorization', 'x-forwarded-host', 'content-length', 'transfer-encoding', 'connection', 'accept-encoding'])
    await assert.rejects(f.run({ ...request, headers: [[name, 'attacker-chosen']] }), reason('invalid_request'), name)
  await assert.rejects(f.run({ ...request, headers: [['Accept', 'one'], ['accept', 'two']] }), reason('invalid_request'))
  await assert.rejects(f.run({ ...request, headers: [['content-type', 'application/json\r\nX-Injected: true']] }), reason('invalid_request'))
  await assert.rejects(f.run({ ...request, headers: [['accept', 'x'.repeat(16_385)]] }), reason('limit_exceeded'))
  await assert.rejects(f.run({ ...request, headers: [['accept', 'value', 'extra']] as unknown as Array<[string, string]> }), reason('invalid_request'))
  await assert.rejects(f.run({ ...request, ownerId: 'other', secret: 'attacker-value' } as EgressHttpRequest), reason('invalid_request'))
  assert.deepEqual(f.hosts, []); assert.deepEqual(f.targets, [])
})

test('body encoding, method and byte limits are enforced before contacting the destination', async () => {
  const f = fixture()
  for (const bodyBase64 of ['not-base64', 'YQ=', 'YR==', 'YQ==\n'])
    await assert.rejects(f.run({ ...request, method: 'POST', bodyBase64 }), reason('invalid_request'))
  await assert.rejects(f.run({ ...request, bodyBase64: Buffer.from('a').toString('base64') }), reason('invalid_request'))
  await assert.rejects(f.run({ ...request, method: 'POST', bodyBase64: Buffer.alloc(EGRESS_MAX_REQUEST_BYTES + 1).toString('base64') }), reason('limit_exceeded'))
  assert.deepEqual(f.hosts, [])
  await f.run({ ...request, method: 'POST', path: '/v1/widgets', bodyBase64: Buffer.alloc(EGRESS_MAX_REQUEST_BYTES, 'x').toString('base64') })
  assert.equal(f.targets[0].body.length, EGRESS_MAX_REQUEST_BYTES)
})

test('SSRF rejects local, metadata, mapped, translated, tunnel, multicast, reserved and documentation addresses', async () => {
  for (const address of ['127.0.0.1', '0.0.0.0', '10.2.3.4', '100.100.100.200', '169.254.169.254', '172.16.0.1', '192.168.0.1', '192.0.2.10', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255',
    '::', '::1', 'fc00::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::7f00:1', '2002:7f00:1::', '2001:db8::1', '2001::1', '3fff::1', '2001:4860::1%eth0', 'not-an-ip'])
    assert.equal(isPublicEgressAddress(address), false, address)
  for (const address of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '2606:4700:4700::1111', '2001:4860:4860::8888'])
    assert.equal(isPublicEgressAddress(address), true, address)
  for (const rows of [[], [{ address: '127.0.0.1', family: 4 }], [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }], [{ address: '1.1.1.1', family: 6 }]]) {
    const f = fixture({ resolve: async () => rows })
    await assert.rejects(f.run(), reason('destination_denied'))
    assert.deepEqual(f.targets, [])
  }
  for (const origin of ['https://127.0.0.1', 'https://0x7f000001', 'https://2130706433', 'https://[::ffff:7f00:1]']) {
    const token = issueEgressCapability({ ...grantInput, http: { ...grantInput.http, origin } }, now, env)
    const f = fixture()
    await assert.rejects(f.run({ ...request, capability: token.capability }), reason('destination_denied'))
    assert.deepEqual(f.hosts, []); assert.deepEqual(f.targets, [])
  }
})

test('DNS rebinding cannot change the address chosen for TLS and the approved hostname remains authenticated', async () => {
  let resolutions = 0
  const f = fixture({ resolve: async () => ++resolutions === 1 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }] })
  await f.run()
  assert.equal(resolutions, 1)
  const options = pinnedEgressRequestOptions(f.targets[0])
  assert.equal(options.agent, false)
  assert.equal(options.rejectUnauthorized, true)
  assert.equal(options.servername, 'api.example.com')
  assert.equal(options.family, 4)
  const single = await new Promise(resolve => options.lookup!('api.example.com', { all: false }, (error, address, family) => resolve([error, address, family])))
  assert.deepEqual(single, [null, '93.184.216.34', 4])
  const all = await new Promise(resolve => options.lookup!('attacker-changed.example', { all: true }, (error, addresses) => resolve([error, addresses])))
  assert.deepEqual(all, [null, [{ address: '93.184.216.34', family: 4 }]])
  await assert.rejects(f.run(), reason('destination_denied'))
  assert.equal(f.targets.length, 1)
})

test('every redirect is refused without following or returning its destination', async () => {
  for (const status of [300, 301, 302, 303, 304, 307, 308]) {
    let calls = 0
    const f = fixture({ transport: async () => { calls++; return { status, headers: [['location', 'https://evil.example/collect']], body: Buffer.alloc(0) } } })
    await assert.rejects(f.run(), reason('response_blocked'))
    assert.equal(calls, 1)
  }
})

test('raw and commonly encoded secret reflections in any response header or body are blocked before delivery', async () => {
  const representations = [secret, JSON.stringify({ authorization: `Bearer ${secret}` }), Buffer.from(secret).toString('base64'), Buffer.from(`Bearer ${secret}`).toString('base64'), Buffer.from(secret).toString('hex'),
    [...Buffer.from(secret)].map(byte => `%${byte.toString(16).padStart(2, '0')}`).join(''), [...Buffer.from(secret)].map(byte => `\\u${byte.toString(16).padStart(4, '0')}`).join('')]
  for (const representation of representations) {
    await assert.rejects(fixture({ transport: async () => ({ ...ok(), body: Buffer.from(`prefix ${representation} suffix`) }) }).run(), reason('response_blocked'))
    await assert.rejects(fixture({ transport: async () => ({ ...ok(), headers: [['set-cookie', `value=${representation}`]] }) }).run(), reason('response_blocked'))
  }
  for (const body of [Buffer.from(secret, 'utf16le'), Buffer.from(secret, 'utf16le').swap16()])
    await assert.rejects(fixture({ transport: async () => ({ ...ok(), body }) }).run(), reason('response_blocked'))
  await assert.rejects(fixture({ transport: async () => ({ ...ok(), headers: [['content-encoding', 'gzip']] }) }).run(), reason('response_blocked'))
  await assert.rejects(fixture({ transport: async () => ({ ...ok(), headers: [['content-type', 'text/plain'], ['Content-Type', 'application/json']] }) }).run(), reason('response_blocked'))
})

test('many short headers do not repeatedly expand a maximum-sized authentication key', { timeout: 2_000 }, async () => {
  const longSecret = 'synthetic-' + 'x'.repeat(32 * 1024 - 10)
  const grant = issueEgressCapability({ ...grantInput, secret: longSecret }, now, env)
  const headers: Array<[string, string]> = Array.from({ length: 256 }, (_, index) => [`x-fixture-${index}`, 'ok'])
  const f = fixture({ transport: async () => ({ ...ok(), headers }) })
  assert.equal((await f.run({ ...request, capability: grant.capability })).status, 200)
})

test('upstream body/header bounds apply before converting a response to the wire envelope', async () => {
  await assert.rejects(fixture({ transport: async () => ({ ...ok(), body: Buffer.alloc(EGRESS_MAX_RESPONSE_BYTES + 1) }) }).run(), reason('limit_exceeded'))
  await assert.rejects(fixture({ transport: async () => ({ ...ok(), headers: [['x-large', 'x'.repeat(16_385)]] }) }).run(), reason('limit_exceeded'))
  for (const status of [400, 401, 429, 500, 503]) {
    const result = await fixture({ transport: async () => ({ ...ok(), status }) }).run()
    assert.equal(result.status, status)
  }
})

test('expiry during DNS prevents credential injection; cancellation and deadlines bound stalls', async () => {
  let clock = now
  const f = fixture({ now: () => clock, resolve: async () => { clock += 90_000; return [{ address: '93.184.216.34', family: 4 }] } })
  await assert.rejects(f.run(), reason('expired_capability'))
  assert.deepEqual(f.targets, [])
  const aborted = fixture({ signal: AbortSignal.abort() })
  await assert.rejects(aborted.run(), reason('upstream_unavailable'))
  assert.deepEqual(aborted.hosts, [])
  const stalled = fixture({ signal: AbortSignal.timeout(20), resolve: () => new Promise(() => {}) })
  await assert.rejects(stalled.run(), reason('upstream_unavailable'))
  const started = Date.now()
  const short = issueEgressCapability({ ...grantInput, leaseExpiresAt: started + 150 }, started, env)
  await assert.rejects(executeEgressRequest({ ...request, capability: short.capability }, { runId: 'run-a' }, {
    env, resolve: async () => [{ address: '93.184.216.34', family: 4 }], transport: () => new Promise(() => {}),
  }), reason('upstream_unavailable'))
  assert.ok(Date.now() - started < 2_000)
})

test('a response completed after expiry is never returned even if the timer has not run yet', async () => {
  let clock = now
  const f = fixture({ now: () => clock, transport: async () => { clock += 90_000; return ok() } })
  await assert.rejects(f.run(), reason('expired_capability'))
})

test('the process concurrency bound rejects excess work and releases every completed slot', async () => {
  const release: Array<(response: EgressUpstreamResponse) => void> = []
  const f = fixture({ transport: () => new Promise(resolve => { release.push(resolve) }) })
  const pending = Array.from({ length: 32 }, () => f.run())
  await new Promise(resolve => setImmediate(resolve))
  try { await assert.rejects(f.run(), reason('limit_exceeded')); assert.equal(release.length, 32) }
  finally { for (const finish of release) finish(ok()); await Promise.all(pending) }
  await fixture().run()
})
