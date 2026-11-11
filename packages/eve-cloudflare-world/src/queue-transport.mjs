import { isValidDeploymentId } from '../../../lib/deployment-id.mjs'
import { bodyDigest, deliveryHeaders } from './queue-auth.mjs'
import { WORKFLOW_FLOW_ROUTE } from '@workflow/world/queue.js'

const maxDelaySeconds = 24 * 60 * 60
const inlineLimit = 120 * 1024
const encoder = new TextEncoder()

export function validRelease(value) {
  return isValidDeploymentId(value) && value === value.toLowerCase()
}

function releaseBinding(env, id) {
  if (!validRelease(id) || !Object.hasOwn(env.EVE_RELEASES ?? {}, id)) return
  const name = env.EVE_RELEASES[id]
  if (typeof name === 'string' && Object.hasOwn(env, name) && typeof env[name]?.fetch === 'function') return env[name]
}

function delayUntil(dueAt) {
  return Math.min(maxDelaySeconds, Math.max(0, Math.ceil((dueAt - Date.now()) / 1000)))
}

async function persistEnvelope(env, envelope) {
  if (encoder.encode(JSON.stringify(envelope)).length <= inlineLimit) return envelope
  const digest = await bodyDigest(envelope.body)
  const key = 'eve-queue/' + digest
  await env.EVE_QUEUE_PAYLOADS.put(key, envelope.body, { sha256: digest })
  return { revision: envelope.revision, dueAt: envelope.dueAt, key }
}

export async function publish(env, envelope) {
  await env.EVE_QUEUE.send(envelope, { contentType: 'json', delaySeconds: delayUntil(envelope.dueAt) })
}

function objectKey(key) { return typeof key === 'string' && /^eve-queue\/[0-9a-f]{64}$/.test(key) }

export async function publishQueueRequest(request, env) {
  const url = new URL(request.url)
  if (request.method !== 'POST' || url.pathname !== '/world/queue/publish') return new Response(null, { status: 404 })
  const revision = url.searchParams.get('release')
  const delay = Number(url.searchParams.get('delay') ?? '0')
  if (!validRelease(revision) || !Number.isSafeInteger(delay) || delay < 0) return new Response(null, { status: 400 })
  const dueAt = Date.now() + delay * 1000
  if (!Number.isSafeInteger(dueAt)) return new Response(null, { status: 400 })
  // Keep the pinned revision even when its binding is temporarily absent during
  // rollout. The queue and DLQ preserve that delivery until it can be restored.
  const body = await request.text()
  let meta
  try { meta = JSON.parse(body) } catch { return new Response(null, { status: 400 }) }
  if (typeof meta?.messageId !== 'string' || typeof meta.queueName !== 'string' ||
      (meta.idempotencyKey !== undefined && typeof meta.idempotencyKey !== 'string')) return new Response(null, { status: 400 })
  const envelope = await persistEnvelope(env, { revision, dueAt, body })
  if (meta.idempotencyKey) {
    const claim = env.EVE_CLAIMS.getByName('claim:' + meta.queueName + ':' + meta.idempotencyKey)
    const messageId = await claim.publishKeyed(meta.messageId, envelope, url.searchParams.get('continuation') === 'true')
    return Response.json({ messageId }, { status: 202 })
  }
  await publish(env, envelope)
  return Response.json({ messageId: meta.messageId }, { status: 202 })
}

async function deliver(message, env) {
  const entry = message.body
  if (!entry || !validRelease(entry.revision) || !Number.isSafeInteger(entry.dueAt)) throw new Error('Invalid World queue entry')
  if ((typeof entry.body === 'string') === objectKey(entry.key)) throw new Error('Invalid World queue body reference')
  if (entry.dueAt > Date.now()) {
    if (entry.key) {
      // The R2 lifecycle outlasts both native queue retention windows. Renew
      // an unusually long timer's identical bytes on each delayed native hop.
      const bytes = await env.EVE_QUEUE_PAYLOADS.get(entry.key)
      if (!bytes) throw new Error('World queue bytes unavailable')
      await env.EVE_QUEUE_PAYLOADS.put(entry.key, bytes.body, { sha256: entry.key.slice('eve-queue/'.length) })
    }
    await publish(env, entry)
    return
  }
  const target = releaseBinding(env, entry.revision)
  if (!target) throw new Error('Eve deployment binding unavailable')
  const body = entry.key ? await env.EVE_QUEUE_PAYLOADS.get(entry.key) : undefined
  if (entry.key && !body) throw new Error('World queue bytes unavailable')
  const business = env.WORLD_WORKLOAD === 'business'
  const material = env.WORLD_QUEUE_ED25519_PRIVATE_KEY ? 'ed25519-pkcs8:' + env.WORLD_QUEUE_ED25519_PRIVATE_KEY : undefined
  if (business && !material) throw new Error('Business workflow signer unavailable')
  const response = await target.fetch(new Request(new URL(WORKFLOW_FLOW_ROUTE, business ? 'https://business-workflow.internal' : 'https://eve.internal'), {
    method: 'POST', redirect: 'manual',
    headers: await deliveryHeaders(material ?? env.EVE_QUEUE_SIGNING_KEY, entry.revision, message.attempts - 1,
      entry.key ? entry.key.slice('eve-queue/'.length) : await bodyDigest(entry.body)),
    body: body?.body ?? entry.body, duplex: 'half',
  }))
  try {
    if (!response.ok || response.headers.get('x-mikka-eve-release') !== entry.revision) {
      throw new Error('Pinned Eve deployment did not acknowledge delivery')
    }
  } finally { await response.body?.cancel() }
}

/** A failed message retains its original envelope for Cloudflare's bounded
 * retry and configured DLQ. No request URL or current deployment is a fallback. */
export async function consumeWorldQueue(batch, env) {
  await Promise.all(batch.messages.map(async message => {
    try {
      await deliver(message, env)
      message.ack()
    } catch {
      message.retry({ delaySeconds: Math.min(60, 2 ** Math.min(6, message.attempts - 1)) })
    }
  }))
}
