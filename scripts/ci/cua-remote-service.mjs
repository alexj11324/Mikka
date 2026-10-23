// Isolated requested-service CI. Mikka-owned test; no upstream FSL source/bindings.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { streamText, isStepCount } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { createComputerTools } from '../../lib/cua/tools.ts'
import { executeDesktop } from '../../lib/cua/grpc-web.ts'
import { desktopConfig, desktopFingerprint } from '../../lib/cua/operation.ts'

assert.equal(process.env.CI, 'true')
const config = desktopConfig()
assert.ok(config)
assert.equal(config.url, 'http://127.0.0.1:3211')
assert.equal(config.token, 'mikka-cua-ci-disposable-not-a-secret')
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 15000 })
// Inspect metadata without importing any perception code; fail closed if present.
const packages = docker('exec', 'mikka-cua-ci', '/opt/venv/bin/python3', '-c', 'import importlib.metadata as m; print("\\n".join(d.metadata["Name"] for d in m.distributions()))')
assert.ok(!/^cua-(?:perception|som)$/im.test(packages), 'No perception/OmniParser distribution may be installed')
await assert.rejects(executeDesktop({ ...config, token: 'deliberately-wrong-disposable-token' }, { tool: 'screenshot' }), 'Service must reject wrong-token screenshot')
docker('cp', 'scripts/ci/cua-editor-fixture.py', 'mikka-cua-ci:/tmp/mikka-editor.py')
docker('exec', '--detach', '--user', 'cua', '--env', 'DISPLAY=:1', 'mikka-cua-ci', 'sh', '-c', '/usr/bin/python3 /tmp/mikka-editor.py >/tmp/mikka-editor.log 2>&1')
// A detached launch only acknowledges spawning. Wait for GTK to map/focus its
// window, and surface its own startup error rather than OCRing an empty desktop.
let editorReady = false
for (let attempt = 0; attempt < 40; attempt++) {
  const state = docker('exec', 'mikka-cua-ci', 'sh', '-c', 'if test -f /tmp/mikka-editor.ready; then echo ready; fi; cat /tmp/mikka-editor.log')
  if (state.startsWith('ready')) { editorReady = true; break }
  if (/Traceback|ModuleNotFoundError|cannot open display/i.test(state)) throw new Error(`Editor fixture startup failed: ${state}`)
  await new Promise(resolve => setTimeout(resolve, 250))
}
assert.ok(editorReady, 'GTK editor must map before approved service input')

// This disposable in-memory test owner approves exact saved operations. Production
// authenticated owner/membership/policy/claim races are separate PG17/browser CI.
class Store {
  rows = new Map()
  async insert(row) { this.rows.set(row.id, row) }
  async read(id, userId, sessionId, target) { const row = this.rows.get(id); return row?.userId === userId && row.sessionId === sessionId && row.target === target ? row : null }
  async pending(userId, sessionId) { return [...this.rows.values()].filter(row => row.userId === userId && row.sessionId === sessionId && row.status === 'pending') }
  async approve(id, userId, sessionId, target, now) { const row = await this.read(id, userId, sessionId, target); if (!row || row.status !== 'pending' || row.expiresAt <= now) return null; row.status = 'approved'; return row }
  async consume(id, userId, sessionId, target, now, status) { const row = this.rows.get(id); if (!row || row.userId !== userId || row.sessionId !== sessionId || row.target !== target || row.expiresAt <= now || row.status !== (status === 'executing' ? 'approved' : 'pending')) return null; row.status = status; return row }
  async finish(id, status) { this.rows.get(id).status = status }
  async cancel(id, userId, sessionId) { const row = this.rows.get(id); if (row?.userId === userId && row.sessionId === sessionId && ['pending', 'approved'].includes(row.status)) row.status = 'cancelled' }
}
const store = new Store(), controller = new AbortController()
const sentinel = 'MIKKA CUA INTERNAL CI 148'
let step = 0, readback = false
const findPng = value => {
  if (typeof value === 'string' && value.startsWith('iVBORw0KGgo')) return value
  if (value && typeof value === 'object') for (const child of Object.values(value)) { const result = findPng(child); if (result) return result }
}
const model = new MockLanguageModelV3({ doStream: async options => {
  step++
  if (step === 3) {
    const png = findPng(options.prompt.filter(message => message.role === 'tool'))
    assert.ok(png, 'Actual service PNG must reach next model step')
    const image = Buffer.from(png, 'base64')
    assert.ok(image.length > 1000)
    mkdirSync('test-results/cua-remote-service', { recursive: true })
    writeFileSync('test-results/cua-remote-service/editor-readback.png', image)
    const text = execFileSync('tesseract', ['stdin', 'stdout'], { input: image, timeout: 15000 }).toString()
    assert.ok(text.includes(sentinel), 'Scripted model must read back typed text from returned PNG')
    readback = true
  }
  const final = step === 3
  return { stream: new ReadableStream({ start(stream) {
    stream.enqueue({ type: 'stream-start', warnings: [] })
    if (final) {
      stream.enqueue({ type: 'text-start', id: 'result' }); stream.enqueue({ type: 'text-delta', id: 'result', delta: `Read back ${sentinel}` }); stream.enqueue({ type: 'text-end', id: 'result' })
    } else stream.enqueue({ type: 'tool-call', toolCallId: `step-${step}`, toolName: step === 1 ? 'computer_type' : 'computer_screenshot', input: step === 1 ? JSON.stringify({ text: sentinel }) : '{}' })
    stream.enqueue({ type: 'finish', finishReason: { unified: final ? 'stop' : 'tool-calls' }, usage: { inputTokens: { total: 0 }, outputTokens: { total: 0 } } }); stream.close()
  } }) }
} })
try {
  const result = streamText({ model, tools: createComputerTools(config, store, 'ci-owner', 'ci-session', controller.signal), prompt: 'Type then read back the editor via screenshot. Script only, no provider.', stopWhen: isStepCount(3), abortSignal: controller.signal })
  const consuming = (async () => { for await (const part of result.stream) assert.notEqual(part.type, 'error') })()
  for (const operation of ['type', 'screenshot']) {
    const deadline = Date.now() + 15000
    let row
    while (!(row = (await store.pending('ci-owner', 'ci-session'))[0])) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10)) }
    assert.equal(row.operation.tool, operation)
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(row.status, 'pending')
    assert.ok(await store.approve(row.id, 'ci-owner', 'ci-session', desktopFingerprint(config), new Date()))
  }
  await consuming
  assert.equal(readback, true)
  assert.ok(!JSON.stringify([...store.rows.values()]).includes('data:image'))
  console.log('Real requested service: wrong-token rejected, exact approvals, streamed PNG and OCR readback passed')
} finally { controller.abort() }
