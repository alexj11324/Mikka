import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage } from 'node:http'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { taskSecretAccessSchema } from '@mikka/protocol/task-secrets'
import { startTaskSecretBridge } from '../packages/daemon/src/task-secret-bridge'

const execute = promisify(execFile)

// This proof belongs to the root Node 24 target: these installed SDK versions
// require Node >=22. Daemon's Node 18 matrix retains its HTTP-client proof.
const SDK_CHILD = `
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText } from 'ai';
const endpoints = JSON.parse(process.env.MIKKA_SECRET_ENDPOINTS);
const provider = createOpenAICompatible({ name: 'protected-third-party-fixture',
  baseURL: endpoints.SERVICE_API_KEY + '/v1', apiKey: process.env.SDK_KEY });
// Ordinary installed SDK transport: no custom fetch, header shim or retry.
const result = await generateText({ model: provider.chatModel('synthetic-third-party-model'),
  prompt: 'Exercise the protected third-party JSON fixture.', maxRetries: 0 });
process.stdout.write(JSON.stringify({ env: { ...process.env }, text: result.text,
  finishReason: result.finishReason, inputTokens: result.usage.inputTokens,
  outputTokens: result.usage.outputTokens }));
`

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks)
}

test('the installed SDK calls a protected third-party JSON endpoint in real children before and after grant renewal', { timeout: 20_000 }, async t => {
  const canary = `third-party-sdk-canary-${randomBytes(24).toString('hex')}`
  const initialCapability = `opaque-sdk-initial-${randomBytes(32).toString('base64url')}`
  const renewedCapability = `opaque-sdk-renewed-${randomBytes(32).toString('base64url')}`
  const authorized = new Map([[initialCapability, canary]])
  const egressCalls: Array<{ capability: string; method: string; path: string; headers: Array<[string, string]>; bodyBase64: string }> = []
  const providerCalls: Array<{ authorization: string | undefined; body: Record<string, unknown> }> = []
  const fixtureErrors: unknown[] = []
  const controller = new AbortController()
  const parentEnv = { ...process.env }
  let origin = ''
  const http = createServer((request, response) => {
    void (async () => {
      if (request.url === '/provider/v1/chat/completions') {
        providerCalls.push({ authorization: request.headers.authorization, body: JSON.parse((await readBody(request)).toString('utf8')) })
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ id: 'chatcmpl-protected-fixture', object: 'chat.completion', created: 1,
          model: 'synthetic-third-party-model', choices: [{ index: 0,
            message: { role: 'assistant', content: 'protected-sdk-result' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }))
        return
      }
      if (request.url !== '/invoke') { response.writeHead(404); response.end(); return }
      const message = JSON.parse((await readBody(request)).toString('utf8')) as typeof egressCalls[number]
      egressCalls.push(message)
      const secret = authorized.get(message.capability)
      if (!secret) { response.writeHead(401); response.end(); return }
      // This trusted HTTP egress/upstream pair is synthetic; the real bridge
      // and installed SDK cross the actual TCP boundary without transport mocks.
      const upstream = await fetch(`${origin}/provider${message.path}`, {
        method: message.method,
        headers: { ...Object.fromEntries(message.headers), authorization: `Bearer ${secret}` },
        body: Buffer.from(message.bodyBase64, 'base64').toString('utf8'),
      })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ status: upstream.status, headers: { 'content-type': 'application/json' },
        bodyBase64: Buffer.from(await upstream.arrayBuffer()).toString('base64') }))
    })().catch(error => { fixtureErrors.push(error); response.destroy() })
  })
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(0, '127.0.0.1', () => { http.off('error', reject); resolve() })
  })
  t.after(async () => {
    controller.abort()
    http.closeAllConnections()
    await new Promise<void>(resolve => http.close(() => resolve()))
  })
  const address = http.address()
  assert.ok(address && typeof address !== 'string')
  origin = `http://127.0.0.1:${address.port}`
  let current = taskSecretAccessSchema.parse({ version: 1, endpoint: `${origin}/invoke`, unavailable: [], grants: [{
    name: 'SERVICE_API_KEY', capability: initialCapability, origin: 'https://third-party.invalid',
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  }] })
  assert.equal(JSON.stringify(current).includes(canary), false)
  const bridge = await startTaskSecretBridge({ current: () => current, signal: controller.signal })
  assert.ok(bridge)
  const childEnv = { ...bridge.env, SDK_KEY: 'mikka-protected', NODE_ENV: 'test' as const }
  for (const capability of [initialCapability, renewedCapability]) {
    if (capability === renewedCapability) {
      authorized.delete(initialCapability)
      authorized.set(renewedCapability, canary)
      current = taskSecretAccessSchema.parse({ ...current,
        grants: [{ ...current.grants[0], capability: renewedCapability }] })
    }
    const { stdout, stderr } = await execute(process.execPath, ['--input-type=module', '-e', SDK_CHILD], {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      env: childEnv,
      encoding: 'utf8', timeout: 10_000, maxBuffer: 256 * 1024,
    })
    assert.equal(stderr, '')
    const capture = JSON.parse(stdout) as { env: Record<string, string>; text: string; finishReason: string; inputTokens: number; outputTokens: number }
    assert.deepEqual({ ...capture, env: undefined }, { env: undefined, text: 'protected-sdk-result',
      finishReason: 'stop', inputTokens: 2, outputTokens: 3 })
    assert.deepEqual(capture.env, childEnv)
    for (const hidden of [canary, initialCapability, renewedCapability])
      assert.equal(stdout.includes(hidden), false, 'The SDK child received a hidden credential')
  }
  assert.deepEqual(egressCalls.map(call => call.capability), [initialCapability, renewedCapability])
  for (const call of egressCalls) {
    assert.equal(call.path, '/v1/chat/completions')
    assert.equal(call.method, 'POST')
    assert.equal(call.headers.some(([name]) => ['authorization', 'x-api-key', 'api-key', 'x-goog-api-key'].includes(name)), false)
  }
  assert.equal(providerCalls.length, 2)
  for (const call of providerCalls) {
    assert.equal(call.authorization === `Bearer ${canary}`, true)
    assert.equal(call.body.model, 'synthetic-third-party-model')
    assert.deepEqual(call.body.messages, [{ role: 'user', content: 'Exercise the protected third-party JSON fixture.' }])
    assert.notEqual(call.body.stream, true)
  }
  assert.deepEqual(Object.keys(process.env).sort(), Object.keys(parentEnv).sort())
  for (const name of Object.keys(parentEnv)) assert.equal(process.env[name] === parentEnv[name], true, `Parent environment changed: ${name}`)
  assert.deepEqual(fixtureErrors, [])
})
