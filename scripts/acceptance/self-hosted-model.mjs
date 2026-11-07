import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

/** A local OpenAI-compatible protocol fixture. It never executes tools, forwards
 * requests, or claims to be a live subscription/model acceptance. */
export function createModelFixture() {
  const turns = new Set()
  let calls = 0
  return createServer(async (request, response) => {
    const json = (status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)) }
    if (request.method === 'GET' && request.url === '/health') return json(200, { synthetic: true })
    if (request.method === 'GET' && request.url === '/evidence') return json(200, { synthetic: true, calls, turns: [...turns].sort() })
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions' || request.headers.authorization !== 'Bearer synthetic-selfhost-only') return json(400, { error: 'fixture_request_invalid' })
    let bytes = 0, input
    try {
      const chunks = []
      for await (const chunk of request) {
        bytes += chunk.length
        if (bytes > 16 * 1024 * 1024) return json(413, { error: 'fixture_body_limit' })
        chunks.push(chunk)
      }
      input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch { return json(400, { error: 'fixture_body_invalid' }) }
    if (input.model !== 'selfhost-ci' || !Array.isArray(input.messages)) return json(400, { error: 'fixture_model_invalid' })
    const marker = [...JSON.stringify(input.messages).matchAll(/selfhost_turn_(\d{2})/g)].at(-1)?.[1]
    if (marker) turns.add(marker)
    calls++
    const content = marker ? `SELF_HOSTED_REPLY_${marker}` : 'Synthetic self-hosted protocol response.'
    const common = { id: `chatcmpl-fixture-${calls}`, created: Math.floor(Date.now() / 1000), model: 'selfhost-ci' }
    const usage = { prompt_tokens: 8, completion_tokens: 8, total_tokens: 16 }
    if (!input.stream) return json(200, { ...common, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage })
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
    response.write(`data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })}\n\n`)
    response.end('data: [DONE]\n\n')
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.MIKKA_SELF_HOSTED_ACCEPTANCE !== '1') throw new Error('DISPOSABLE_FIXTURE_REQUIRED')
  const server = createModelFixture().listen(8080, '0.0.0.0')
  process.once('SIGTERM', () => server.close())
  process.once('SIGINT', () => server.close())
}
