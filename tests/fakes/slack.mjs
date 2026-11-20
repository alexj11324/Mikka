import { createHmac } from 'node:crypto'
import { assertLoopbackOrigin, bodyJson, json, requestRecord } from './http.mjs'

export const LOCAL_SLACK_TOKEN = 'mikka-local-slack'
export const LOCAL_SLACK_SIGNING_SECRET = 'mikka-local-slack-signing'

/** The real Slack client sends ordinary Web API JSON to this HTTP boundary. */
export function createSlackFake({ now = () => Date.now(), channels = ['C1'], scopes = ['chat:write', 'chat:write.customize'] } = {}) {
  const requests = [], messages = []
  const state = { failure: /** @type {string | null} */ (null), scopes: new Set(scopes), channels: new Set(channels) }
  async function routes(request, response, url) {
    if (!url.pathname.startsWith('/slack/api/')) return false
    const body = await bodyJson(request)
    requests.push(requestRecord(request, url, body))
    if (request.headers.authorization !== `Bearer ${LOCAL_SLACK_TOKEN}`) return json(response, { ok: false, error: 'invalid_auth' })
    if (state.failure === 'ratelimited') return json(response, { ok: false, error: 'ratelimited' }, 429, { 'retry-after': '1' })
    if (state.failure) return json(response, { ok: false, error: state.failure })
    if (url.pathname !== '/slack/api/chat.postMessage' || request.method !== 'POST') return json(response, { ok: false, error: 'unknown_method' }, 404)
    if (!state.channels.has(body.channel)) return json(response, { ok: false, error: 'channel_not_found' })
    if (!state.scopes.has('chat:write') || ((body.username || body.icon_url || body.icon_emoji) && !state.scopes.has('chat:write.customize')))
      return json(response, { ok: false, error: 'missing_scope', needed: body.username || body.icon_url || body.icon_emoji ? 'chat:write.customize' : 'chat:write' })
    if (typeof body.text !== 'string' || !body.text.trim()) return json(response, { ok: false, error: 'no_text' })
    if (body.icon_url && (typeof body.icon_url !== 'string' || !body.icon_url.startsWith('https://'))) return json(response, { ok: false, error: 'invalid_arguments' })
    const message = { ...body, ts: `${Math.floor(now() / 1000)}.${String(messages.length + 1).padStart(6, '0')}` }
    messages.push(message)
    return json(response, { ok: true, channel: body.channel, ts: message.ts, message })
  }

  // Slack events travel in the opposite direction. Sign the exact bytes so the
  // application's actual webhook verifier, including replay checks, runs.
  function eventRequest(origin, event, { timestamp = Math.floor(now() / 1000), invalidSignature = false } = {}) {
    assertLoopbackOrigin(origin)
    const body = JSON.stringify(event)
    const signature = `v0=${createHmac('sha256', LOCAL_SLACK_SIGNING_SECRET).update(`v0:${timestamp}:${body}`).digest('hex')}`
    return new Request(origin, { method: 'POST', body, headers: { 'content-type': 'application/json',
      'x-slack-request-timestamp': String(timestamp), 'x-slack-signature': invalidSignature ? `v0=${'0'.repeat(64)}` : signature } })
  }
  return { routes, state, requests, messages, eventRequest }
}
