import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'

const maxEventBytes = 4096
const runbook = 'https://github.com/aspectly-labs/mikka-cloud/blob/main/docs/operations/observability.md'

function slackMessage(body) {
  let event
  try { event = JSON.parse(body) } catch { return null }
  if (event?.version !== 1 || typeof event.id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(event.id)
      || !['firing', 'resolved'].includes(event.state) || typeof event.observedAt !== 'string'
      || !Number.isFinite(Date.parse(event.observedAt))
      || (event.state === 'firing' && !Number.isFinite(event.value))) return null
  const time = new Date(event.observedAt).toISOString()
  const value = event.state === 'firing' ? ` (value: ${event.value})` : ''
  return {
    text: `Mikka Ops: ${event.state.toUpperCase()} — ${event.id}${value}\nObserved: ${time}\nRunbook: ${runbook}`,
    unfurl_links: false,
    unfurl_media: false,
  }
}

async function forward(request, webhook, path) {
  if (request.url !== path) return 404
  if (request.method !== 'POST') return 405
  if (request.headers['content-type'] !== 'application/json') return 415
  if (Number(request.headers['content-length']) > maxEventBytes) return 413
  const chunks = []
  let bytes = 0
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length
    if (bytes > maxEventBytes) return 413
    chunks.push(chunk)
  }
  const message = slackMessage(Buffer.concat(chunks, bytes))
  if (!message) return 400
  const response = await fetch(webhook, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message),
    signal: AbortSignal.timeout(2000), redirect: 'error',
  })
  void response.body?.cancel().catch(() => {})
  // Acknowledge only after Slack accepts the event; the monitor owns retries.
  return response.status === 200 ? 204 : 502
}

export async function configureOpsAlertForwarder(env) {
  const webhook = env.OPS_ALERT_SLACK_WEBHOOK_URL
  if (webhook === undefined) return
  if (!/^https:\/\/hooks\.slack\.com\/services\/[a-zA-Z0-9]+\/[a-zA-Z0-9]+\/[a-zA-Z0-9_-]+$/.test(webhook)) {
    throw Error('opsAlertSlackWebhookInvalid')
  }
  delete env.OPS_ALERT_SLACK_WEBHOOK_URL
  const path = '/ops-alerts/' + randomUUID()
  const server = createServer(async (request, response) => {
    let status
    try { status = await forward(request, webhook, path) } catch { status = 502 }
    response.writeHead(status, { connection: 'close' }).end()
  })
  server.setTimeout(2_500, socket => socket.destroy())
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  server.unref()
  env.OPS_INTERNAL_ALERT_SINK = `http://127.0.0.1:${server.address().port}${path}`
  return server
}
