import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fixtureGitResponse, relayTarget, startLocalRelay } from './local-api-relay.mjs'

const origins = { localOrigin: 'http://localhost:3110', relayOrigin: 'https://relay.example' }
const request = () => ({ id: randomUUID(), origin: origins.relayOrigin, method: 'POST', path: `/mikka/v1/devices/${randomUUID()}/register`, scope: 'device', headers: {}, body: '' })

test('the local relay rejects foreign origins and every path outside the scoped endpoints', () => {
  assert.equal(relayTarget(request(), origins).origin, origins.localOrigin)
  for (const path of ['/mikka/api/auth/get-session', '/mikka/api/mcp', '//foreign.example/mikka/v1/a', '/mikka/v1/../api/x', '/mikka/v1/%2fsecret', '/mikka/v1/%252fsecret', '/mikka/v1//x', '/mikka/v1/x#secret', '/mikka/v1/x\\y']) {
    assert.throws(() => relayTarget({ ...request(), path }, origins), undefined, path)
  }
  assert.throws(() => relayTarget({ ...request(), origin: 'https://foreign.example' }, origins))
  assert.throws(() => relayTarget(request(), { ...origins, localOrigin: 'https://production.example' }))
  assert.throws(() => relayTarget({ ...request(), method: 'CONNECT' }, origins))
})

test('forwarded Host retains the exact HTTPS relay identity', async () => {
  const abort = new AbortController(), deviceToken = `orv_${randomBytes(32).toString('base64url')}`, controlToken = randomBytes(32).toString('base64url')
  const fixture = request(), actions = []
  let issued = false, finished
  const observed = new Promise(resolve => { finished = resolve })
  const send = async (url, options = {}) => {
    const target = new URL(url)
    if (target.origin === origins.localOrigin) {
      assert.equal(options.headers.host, 'relay.example')
      assert.equal(options.headers['x-forwarded-host'], 'relay.example')
      assert.equal(options.headers['x-forwarded-proto'], 'https')
      assert.equal(options.headers.authorization, `Bearer ${deviceToken}`)
      assert.equal(options.headers.cookie, undefined)
      return Response.json({ deviceId: randomUUID() })
    }
    assert.equal(options.headers.authorization, `Bearer ${controlToken}`)
    if (target.pathname === '/control/next') {
      if (!issued) { issued = true; return Response.json(fixture) }
      return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
    }
    actions.push(target.pathname.split('/').at(-1))
    return new Response(null, { status: 204 })
  }
  const relay = await startLocalRelay({ ...origins, deviceToken, controlToken, signal: abort.signal, send, observe: finished })
  try { await observed; assert.deepEqual(actions, ['start', 'chunk', 'end']) }
  finally { await relay.stop() }
})

test('a successful claim with a different signed issuer is refused before delivery', async () => {
  const deviceToken = `orv_${randomBytes(32).toString('base64url')}`, controlToken = randomBytes(32).toString('base64url')
  const fixture = { ...request(), path: `/mikka/v1/devices/${randomUUID()}/runs/${randomUUID()}/claim` }
  let issued = false
  const send = async (url, options) => {
    const target = new URL(url)
    if (target.origin === origins.localOrigin) return Response.json({ policySnapshot: { payload: { issuer: 'https://foreign.example/mikka' } } })
    if (target.pathname === '/control/next' && !issued) { issued = true; return Response.json(fixture) }
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
  }
  const relay = await startLocalRelay({ ...origins, deviceToken, controlToken, send })
  try { await assert.rejects(relay.done, /policy issuer mismatch/) }
  finally { await relay.stop() }
})

test('Git CGI serves only the admitted fixture upload-pack and never receive-pack or another repository', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-git-cgi-')), barePath = join(directory, 'origin.git')
  try {
    execFileSync('git', ['init', '--bare', '-q', '-b', 'main', barePath])
    const input = { origin: origins.relayOrigin, method: 'GET', path: '/mikka/v1/git/core-loop.git/info/refs?service=git-upload-pack', headers: {}, body: '' }
    const response = await fixtureGitResponse(input, { barePath, relayOrigin: origins.relayOrigin })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'application/x-git-upload-pack-advertisement')
    assert.match(await response.text(), /# service=git-upload-pack/)
    for (const path of ['/mikka/v1/git/foreign.git/info/refs?service=git-upload-pack', '/mikka/v1/git/core-loop.git/info/refs?service=git-receive-pack', '/mikka/v1/git/core-loop.git/HEAD', '/mikka/v1/git/core-loop.git/../secrets']) {
      await assert.rejects(fixtureGitResponse({ ...input, path }, { barePath, relayOrigin: origins.relayOrigin }))
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
