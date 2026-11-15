import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'
import { readFile } from 'node:fs/promises'

test('native traces keep private capability request headers out of invocation logs', async () => {
  const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'))
  assert.equal(config.observability.enabled, true)
  assert.equal(config.observability.traces.enabled, true)
  assert.equal(config.observability.logs.invocation_logs, false)
})

const stateKey = 'mikka:eve-host:lifecycle:v1'
const env = {
  EVE_SOURCE_SHA: 'a'.repeat(40), EVE_UI_SHA: 'b'.repeat(40), EVE_RELEASE_ID: 'fixture-1',
  EVE_PUBLIC_ORIGIN: 'https://eve.example.test',
  EVE_ENV_MIKKA_DATABASE_URL: 'postgres://fixture:private-password@127.0.0.1/product_e2e',
  EVE_ENV_BETTER_AUTH_URL: 'https://app.example.test',
  EVE_ENV_MIKKA_DEPLOYMENT_STAGE: 'preview',
  EVE_ENV_BETTER_AUTH_SECRET: 'private-fixture-auth-key-at-least-thirty-two',
  EVE_RUNTIME: {},
}
let selected, forwarded, calls = 0
class NativeContainer {
  constructor(ctx) { this.ctx = ctx; this.pending = []; this.stops = 0; this.failedStarts = 0; this.started = false }
  async fetch(request) { this.calls = (this.calls ?? 0) + 1; return this.respond ? this.respond(request) : new Response('fixture') }
  renewActivityTimeout() { this.renewed = (this.renewed ?? 0) + 1 }
  async getState() { return { status: this.started ? 'running' : 'stopped' } }
  async stop() { this.stops++; this.started = false; await this.onStop() }
  async startAndWaitForPorts() {
    if (this.failedStarts-- > 0) throw new Error('private-provider-failure')
    this.started = true; await this.onStart()
  }
  async listSchedules(name) { return this.pending.filter(row => row.callback === name) }
  async schedule(when, callback, payload) {
    const row = { taskId: String(this.pending.length), when, callback, payload }
    this.pending.push(row); return row
  }
  deleteSchedules(name) { this.pending = this.pending.filter(row => row.callback !== name) }
}
mock.module('@cloudflare/containers', { namedExports: {
  Container: NativeContainer,
  getContainer: (_binding, id) => {
    calls++; assert.equal(id, env.EVE_RELEASE_ID)
    return { fetch: request => { forwarded = request; return selected } }
  },
} })
const { default: ingress, EveRuntime } = await import('../src/index.mjs')

function fixture(map = new Map(), bindings = env) {
  const storage = {
    kv: { get: key => map.get(key), put: (key, value) => map.set(key, value) },
    async get(key) { return structuredClone(map.get(key)) },
    async put(key, value) { map.set(key, structuredClone(value)) },
    async transaction(work) { return work(storage) },
  }
  return { host: new EveRuntime({ storage, container: { async interceptOutboundHttps() {} }, exports: { EveProductOutbound: x => x } }, bindings), map }
}
beforeEach(() => { calls = 0; forwarded = undefined; selected = new Response('native'); mock.restoreAll() })

test('the Worker forwards only the native mount and returns the original streaming response', async () => {
  const bytes = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2])); controller.close() } })
  selected = new Response(bytes)
  const output = await ingress.fetch(new Request('https://app.example.test/mikka/api/agents/eve/v1/health'), env)
  assert.equal(output, selected)
  assert.equal(forwarded.url, 'https://app.example.test/eve/v1/health')
  assert.equal(calls, 1)
  assert.equal((await ingress.fetch(new Request('https://app.example.test/mikka/api/auth/session'), env)).status, 404)
  assert.equal(calls, 1)
})

test('native WebSocket upgrade responses are returned without reconstruction', async () => {
  selected = { status: 101, headers: new Headers(), webSocket: { fixture: true } }
  assert.equal(await ingress.fetch(new Request('https://app.example.test/mikka/api/agents/eve/v1/session/s/stream'), env), selected)
})

test('explicit owner cleanup persists across DO restoration and suppresses pending starts', async () => {
  const { host, map } = fixture()
  await host.onStart(); await host.onStop()
  await assert.rejects(host.stopForOwner('another-release'), /CF_EVE_RELEASE_MISMATCH/)
  await host.stopForOwner('fixture-1')
  assert.equal(host.pending.length, 0)
  assert.equal(map.get(stateKey).stopped, true)
  const restored = fixture(map).host
  await restored.onStop()
  assert.equal(restored.started, false)
  await restored.onStart()
  assert.equal(map.get(stateKey).stopped, true)
  assert.equal(restored.stops, 1)
  assert.equal((await restored.fetch(new Request('https://app.example.test/eve/v1/health'))).status, 503)
  assert.equal(restored.calls, undefined)
})

test('the shared-service idle hook does not destroy sessions when a Task settles', async () => {
  const { host } = fixture()
  await host.onActivityExpired()
  assert.equal(host.stops, 0)
  assert.equal(host.renewed, undefined)
})

test('SDK error bodies and thrown messages never become public configuration disclosures', async () => {
  const errors = []
  mock.method(console, 'error', value => { errors.push(value) })
  const { host } = fixture()
  for (const respond of [
    () => new Response('private-token-or-database-url', { status: 500 }),
    () => { throw new Error('private-token-or-database-url') },
  ]) {
    host.respond = respond
    const response = await host.fetch(new Request('https://app.example.test/eve/v1/health'))
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { ok: false, error: 'coordinatorUnavailable' })
  }
  assert.ok(errors.every(value => !value.includes('private-token')))
})
