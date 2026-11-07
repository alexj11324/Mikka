import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mock, test } from 'node:test'
import { generateText } from 'ai'

const admissions: unknown[][] = []
let deny = false
mock.module('../model-admission/runtime', { namedExports: { modelAdmission: { selfHosted: async (...args: unknown[]) => {
  admissions.push(args)
  if (deny) throw new Error('modelRouteDenied')
  return null
} } } })
const { selfHostedDefaultModel } = await import('./self-hosted-model')

test('administrator default provider receives the configured model and key directly, with admission before each call', async t => {
  const received: Record<string, unknown>[] = []
  const server = createServer(async (request, response) => {
    assert.equal(request.url, '/v1/chat/completions')
    assert.equal(request.headers.authorization, 'Bearer synthetic-own-key')
    const chunks = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
    received.push(JSON.parse(Buffer.concat(chunks).toString()))
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', created: 1, model: 'local-fixture', choices: [{ index: 0, message: { role: 'assistant', content: 'Configured provider replied.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const config = { MIKKA_EDITION: 'community', MIKKA_DEFAULT_MODEL_BASE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, MIKKA_DEFAULT_MODEL_API_KEY: 'synthetic-own-key', MIKKA_DEFAULT_MODEL_ID: 'local-fixture' }
  const previous = Object.keys(config).map(key => process.env[key])
  Object.assign(process.env, config)
  t.after(() => Object.keys(config).forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index] }))
  const model = selfHostedDefaultModel({ workspaceId: 'w', ownerId: 'u' })
  const reply = await generateText({ model, prompt: 'Synthetic protocol test.', maxRetries: 0 })
  assert.equal(reply.text, 'Configured provider replied.')
  assert.equal(received[0].model, 'local-fixture')
  assert.equal(admissions.length, 1)
  assert.equal(admissions[0][1], 'local-fixture', 'admission pins the actual provider model, not the UI default alias')
  deny = true
  await assert.rejects(generateText({ model, prompt: 'Denied', maxRetries: 0 }), /modelRouteDenied/)
  assert.equal(received.length, 1)
  deny = false
})
