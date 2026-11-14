import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { previewBootstrap, previewCapability, verifyExistingTaskPreview, verifyPreviewTargetRefusals } from './task-review-preview.mjs'

const id = digit => `00000000-0000-4000-8000-${String(digit).padStart(12, '0')}`
const taskId = id(1), runId = id(2), fixtureId = id(3), sandboxId = 'synthetic-sandbox', build = 'a'.repeat(40)
const privateValue = 'PRIVATE_PREVIEW_TICKET_COOKIE_OR_NATIVE_OUTPUT'
const origin = `https://41001-${sandboxId}.e2b.app`, capabilityUrl = `${origin}/__mikka/preview/open?ticket=${privateValue}`
const cleanupReceipt = { status: 'passed', prNumber: 31, candidateSha: 'b'.repeat(40), prClosed: true, branchDeleted: true, defaultBranchUnchanged: true }

function fixture({ harness = 'claude_code', rawExposed = false, expireAtEnd = false, failCleanup = false, badCapability = false } = {}) {
  const framework = harness === 'claude_code' ? 'vite' : 'next', marker = `mikka-preview-${framework}-${fixtureId}`
  const events = [], commands = [], requests = [], sockets = []
  let ended = false, updated = false, cleaned = false, entries = 0, commandAtArm = 0
  const controls = { expiresAt: Date.now() + 300000, remaining() { return controls.expiresAt - Date.now() },
    async run(command, settings) { commands.push({ command, settings }); return { exitCode: 0 } }, async expectText() {} }
  const client = {
    async request(path, init = {}) {
      events.push(`product:${init.method ?? 'GET'}:${path}`)
      if (path.endsWith('/review/terminal') || path.endsWith('/input')) {
        assert.equal(ended, true); return Response.json({ error: 'review_machine_gone' }, { status: 409 })
      }
      if (path.includes('?url=') || path.includes('&port=') || path.includes('?sandboxId='))
        return Response.json({ error: 'review_preview_unavailable', code: 'review_preview_unavailable', detail: 'configuration' }, { status: 400 })
      if (ended) return Response.json({ error: 'review_machine_gone' }, { status: 409 })
      if (!path.includes('?')) return Response.json({ running: false }, { status: 404 })
      return Response.json({ running: true, url: badCapability ? capabilityUrl.replace(sandboxId, 'other-sandbox') : capabilityUrl })
    },
    async json(path, init) {
      assert.equal(path, `/api/threads/${runId}/machine`); assert.deepEqual(JSON.parse(init.body), { action: 'end' })
      assert.equal(cleaned, true); assert.equal(sockets.length, 2)
      assert.equal(sockets.every(socket => socket.expected), true)
      events.push('machine:end'); ended = true
      if (expireAtEnd) controls.expiresAt = Date.now() - 1
      return { runId, state: 'ended' }
    },
    async rpc(action, args) {
      assert.equal(action, 'agents.getThreadMachine'); assert.deepEqual(args, [taskId, runId])
      return { kind: 'cloud', state: 'ended', cloud: null }
    },
  }
  const fetchImpl = async (value, settings) => {
    const url = new URL(value), headers = settings.headers
    requests.push({ value, settings }); assert.equal(settings.redirect, 'manual')
    assert.equal(headers?.Cookie?.includes('main-cookie'), undefined === headers?.Cookie ? undefined : false)
    if (url.origin !== origin) return new Response(rawExposed ? marker : 'denied', { status: rawExposed ? 200 : 403 })
    if (!headers?.Cookie) return new Response('denied', { status: 401 })
    assert.equal(headers.Cookie, `__Host-mikka_preview=${privateValue}`); assert.equal(headers.Origin, origin)
    if (ended) return new Response('gone', { status: 403 })
    if (url.pathname === '/') {
      if (cleaned) events.push('alive:http')
      return new Response(`<main>${marker}-${updated ? 'v2' : 'v1'}</main><script src="/asset.js"></script><script>self.__next_r="synthetic-hmr-id"</script>`)
    }
    if (url.pathname === '/@vite/client') return new Response("const wsToken = 'synthetic-ws-token'")
    if (url.pathname === '/main.js') return new Response(`export const version = ${updated ? 2 : 1}; if (import.meta.hot) import.meta.hot.accept();`)
    if (url.pathname === '/asset.js') return new Response('synthetic asset '.repeat(20))
    assert.fail('unexpected preview request')
  }
  const bootstrap = async value => {
    assert.equal(value, capabilityUrl); entries++
    if (entries > 1) return new Response('replay denied', { status: 403 })
    return new Response('<script nonce="fixture-nonce">history.replaceState(null,"","/");location.replace("/")</script>', { headers: {
      'content-type': 'text/html; charset=utf-8', 'referrer-policy': 'no-referrer',
      'set-cookie': `__Host-mikka_preview=${privateValue}; Secure; HttpOnly; SameSite=None; Partitioned; Path=/`,
      'content-security-policy': "default-src 'none'; script-src 'nonce-fixture-nonce'; frame-ancestors https://app.aspectlylabs.com",
    } })
  }
  const observe = (url, protocols, headers) => {
    assert.ok(url.startsWith(origin.replace('https:', 'wss:')))
    assert.equal(headers.Cookie, `__Host-mikka_preview=${privateValue}`)
    assert.deepEqual(protocols, harness === 'claude_code' ? ['vite-hmr'] : [])
    const socket = { expected: false, async ready() { events.push(cleaned ? 'alive:ws' : 'hmr:ready') },
      arm() { commandAtArm = commands.length }, async updated() { assert.ok(commands.length > commandAtArm); updated = true; return framework === 'vite' ? 'update' : 'built' },
      expectRevoke() { assert.equal(ended, false); socket.expected = true },
      async revoked() { assert.equal(ended, true); events.push('hmr:revoked'); return { closed: true, messages: 2, bytes: 100, closeCode: 1008 } },
      close() { events.push('socket:close') } }
    sockets.push(socket); return socket
  }
  const options = { client, taskId, runId, fixtureId, harness, sandboxId, expectedBuild: build, workerSha: 'c'.repeat(40), workerSourceCommit: 'd'.repeat(40),
    beforeEnd: async () => { cleaned = true; events.push('pr:cleanup'); return failCleanup ? { status: 'unconfirmed' } : { ...cleanupReceipt, raw: privateValue } } }
  const deps = { fetchImpl, bootstrap, observe, Socket: class {}, fixtureFiles: { 'package.json': Buffer.from('{}'), 'package-lock.json': Buffer.from('{}') },
    terminal: async (received, work) => {
      assert.equal(received.client, client)
      try { return { status: 'passed', value: await work(controls), cleanup: { status: 'machine_ended' } } }
      catch { return { status: 'failed', cleanup: { status: ended ? 'machine_ended' : 'closed' } } }
    } }
  return { options, deps, events, requests, commands }
}

for (const harness of ['claude_code', 'codex']) test(`${harness}: normal discovery, isolated cookie, real-protocol HMR observation and explicit machine end are ordered`, async () => {
  const f = fixture({ harness }), report = await verifyExistingTaskPreview(f.options, f.deps)
  assert.equal(report.status, 'passed_for_requested_scope')
  assert.equal(report.checks.noServer.status, 404); assert.equal(report.checks.discovery.status, 200)
  assert.equal(report.checks.invalidTargets.length, 3)
  assert.ok(report.checks.invalidTargets.every(item => item.status === 400 && item.capabilityReturned === false))
  assert.equal(report.checks.terminalReclaimed.length, 2)
  assert.equal(report.checks.webSocketsRevoked.length, 2)
  assert.deepEqual(report.remoteCleanup, cleanupReceipt)
  assert.equal(JSON.stringify(report).includes(privateValue), false)
  assert.ok(f.events.indexOf('pr:cleanup') < f.events.indexOf('alive:http'))
  assert.ok(f.events.indexOf('alive:http') < f.events.indexOf('alive:ws'))
  assert.ok(f.events.indexOf('alive:ws') < f.events.indexOf('machine:end'))
  assert.ok(f.events.indexOf('machine:end') < f.events.indexOf('hmr:revoked'))
  assert.ok(f.commands[0].command.includes('/opt/mikka/worker-source-sha'))
  assert.ok(f.commands.every(row => !row.command.includes('https://github.com') && !row.command.includes('curl ')))
})

test('raw port exposure, wrong-sandbox capabilities and unconfirmed PR cleanup cannot pass', async () => {
  for (const change of [{ rawExposed: true }, { badCapability: true }, { failCleanup: true }]) {
    const f = fixture(change), report = await verifyExistingTaskPreview(f.options, f.deps)
    assert.equal(report.status, 'failed'); assert.equal(f.events.includes('machine:end'), false)
    assert.equal(JSON.stringify(report).includes(privateValue), false)
  }
})

test('expiry during machine end is a deadline failure, never evidence of live-capability revocation', async () => {
  const f = fixture({ expireAtEnd: true }), report = await verifyExistingTaskPreview(f.options, f.deps)
  assert.equal(report.status, 'failed'); assert.equal(report.failure.code, 'preview_acceptance_deadline')
  assert.equal(report.checks.machineEnd, undefined); assert.equal(report.checks.oldPreviewDenied, undefined)
})

test('malicious target refusal requires exact 400/code/detail and rejects even a refused response containing a capability', async () => {
  for (const response of [
    Response.json({ error: 'review_preview_unavailable', code: 'review_preview_unavailable', detail: 'configuration', url: privateValue }, { status: 400 }),
    Response.json({ error: 'review_preview_unavailable', code: 'review_preview_unavailable', detail: 'runtime' }, { status: 400 }),
    Response.json({ error: 'review_preview_unavailable', code: 'review_preview_unavailable', detail: 'configuration' }, { status: 403 }),
  ]) await assert.rejects(verifyPreviewTargetRefusals({ taskId, client: { request: async path => {
    assert.ok(path.startsWith(`/api/tasks/${taskId}/review/preview?`)); return response
  } } }), /preview_acceptance_response/)
})

test('capability accepts only the exact sandbox isolated HTTPS bootstrap path', () => {
  assert.equal(previewCapability({ running: true, url: capabilityUrl }, sandboxId).origin, origin)
  for (const url of [capabilityUrl.replace('https:', 'http:'), capabilityUrl.replace(sandboxId, 'other'),
    capabilityUrl.replace('/__mikka/preview/open', '/'), capabilityUrl + '&other=value', capabilityUrl + '#fragment',
    capabilityUrl.replace('41001-', '65536-'), capabilityUrl.replace('41001-', 'private@41001-')])
    assert.throws(() => previewCapability({ running: true, url }, sandboxId), /preview_acceptance_capability/)
})

test('the bootstrap uses HTTPS iframe navigation headers without sending a main-site cookie', async () => {
  let requestOptions
  const response = await previewBootstrap(capabilityUrl, { requestImpl(url, options, callback) {
    assert.equal(url, capabilityUrl); requestOptions = options
    const outgoing = new EventEmitter()
    outgoing.end = () => {
      const incoming = new EventEmitter(); incoming.statusCode = 200; incoming.headers = { 'set-cookie': ['isolated=synthetic'], 'content-type': 'text/html' }
      callback(incoming); incoming.emit('data', Buffer.from('bootstrap')); incoming.emit('end')
    }
    return outgoing
  } })
  assert.equal(requestOptions.headers['Sec-Fetch-Mode'], 'navigate')
  assert.equal(requestOptions.headers['Sec-Fetch-Dest'], 'iframe')
  assert.equal(requestOptions.headers['Sec-Fetch-Site'], 'cross-site')
  assert.equal(requestOptions.headers.Cookie, undefined); assert.equal(requestOptions.headers.Authorization, undefined)
  assert.equal(await response.text(), 'bootstrap')
})
