import { timingSafeEqual } from 'node:crypto'
import { boundedJson } from '../bounded-json.mjs'

const host = 'workers-ai.internal'
const model = '@cf/deepseek-ai/deepseek-v4.1-flash-1017'
// The account binding accepts a single chat-completions operation. Provider-specific
// URLs, billing/gateway options or extra completions cannot be supplied by a caller.
const inputFields = new Set(['model', 'messages', 'max_tokens', 'temperature', 'top_p',
  'frequency_penalty', 'presence_penalty', 'seed', 'stop', 'response_format', 'stream',
  'stream_options', 'tools', 'tool_choice', 'parallel_tool_calls', 'reasoning_effort', 'n'])
const unavailable = status => new Response(null, { status, headers: { 'cache-control': 'no-store' } })

/** Only the shared host receives this credential. Never put a provider token in the container. */
export function configureWorkersAi(container, ctx, account) {
  if (!/^[a-f0-9]{32}$/.test(account ?? '')) throw new Error('Invalid Workers AI account')
  let capability = ctx.storage.kv.get('workers-ai.capability')
  if (!capability) {
    capability = crypto.randomUUID() + crypto.randomUUID()
    ctx.storage.kv.put('workers-ai.capability', capability)
  }
  delete container.envVars.CLOUDFLARE_WORKERS_AI_TOKEN
  Object.assign(container.envVars, {
    CLOUDFLARE_WORKERS_AI_ACCOUNT_ID: account,
    MIKKA_WORKERS_AI_CAPABILITY: capability,
    MIKKA_HOSTED_MODEL_FALLBACK: 'cloudflare-workers-ai',
    NODE_EXTRA_CA_CERTS: '/etc/cloudflare/certs/cloudflare-containers-ca.crt',
  })
}

export function bindWorkersAi(ctx, envVars) {
  return ctx.container.interceptOutboundHttps(host,
    ctx.exports.WorkersAiOutbound({ props: { capability: envVars.MIKKA_WORKERS_AI_CAPABILITY } }))
}

export async function workersAiRequest(request, ai, capability) {
  if (request.url !== 'https://' + host + '/v1/chat/completions' || request.method !== 'POST') return unavailable(404)
  if (!capability) return unavailable(403)
  const expected = Buffer.from('Bearer ' + capability)
  const supplied = Buffer.from(request.headers.get('authorization') ?? '')
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return unavailable(403)
  if (!ai?.run) return unavailable(503)
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return unavailable(415)
  let body
  try { body = await boundedJson(request, 16 * 1024 * 1024) }
  catch (error) { return unavailable(error instanceof RangeError ? 413 : 400) }
  if (body?.model !== model || !Object.keys(body).every(key => inputFields.has(key))
      || (body.stream !== undefined && typeof body.stream !== 'boolean')
      || !Array.isArray(body.messages) || !body.messages.length
      || !Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > 4096
      || (body.n !== undefined && body.n !== 1)) return unavailable(400)
  const { model: target, ...input } = body
  try {
    const result = await ai.run(target, input, { returnRawResponse: true, signal: request.signal })
    if (!(result instanceof Response)) return unavailable(502)
    if (!result.ok) {
      await result.body?.cancel()
      return unavailable(result.status === 429 ? 429 : 502)
    }
    const type = result.headers.get('content-type')?.split(';')[0].trim()
    if (type !== (body.stream === true ? 'text/event-stream' : 'application/json')) {
      await result.body?.cancel()
      return unavailable(502)
    }
    return new Response(result.body, { headers: { 'content-type': type, 'cache-control': 'no-store' } })
  } catch { return unavailable(502) }
}
