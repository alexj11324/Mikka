import { WorkerEntrypoint } from 'cloudflare:workers'
import { WorkflowRunDO } from '@fantasticfour/world-cloudflare/worker'
import { publish, publishQueueRequest } from './queue-transport.mjs'

export class EveQueueClaim extends WorkflowRunDO {
  // A source or dead-letter queue can retain a delivery for 14 days each.
  // The one-shot alarm only expires abandoned idempotency metadata.
  #sending = new Map()
  static retentionMs = 29 * 24 * 60 * 60 * 1000

  async publishKeyed(messageId, envelope, continuation) {
    const storage = this.ctx.storage
    const slot = await storage.transaction(async tx => {
      const current = await tx.get('publication')
      const expiresAt = envelope.dueAt + EveQueueClaim.retentionMs
      if (current && current.expiresAt > Date.now()) {
        if (!continuation) return current
        if (current.messageId !== messageId) throw new Error('Superseded World queue continuation')
      }
      const fresh = { messageId, envelope, expiresAt, generation: crypto.randomUUID() }
      await tx.put('publication', fresh)
      await tx.setAlarm(expiresAt)
      return fresh
    })
    if (slot.envelope) {
      // Await native acceptance before returning a receipt. A lost response or
      // concurrent retry uses the exact same stored bytes and logical ID.
      let sending = this.#sending.get(slot.generation)
      if (!sending) {
        sending = this.#publishSlot(slot)
        this.#sending.set(slot.generation, sending)
      }
      try { await sending } finally {
        if (this.#sending.get(slot.generation) === sending) this.#sending.delete(slot.generation)
      }
    }
    return slot.messageId
  }

  async #publishSlot(slot) {
    await publish(this.env, slot.envelope)
    await this.ctx.storage.transaction(async tx => {
      const current = await tx.get('publication')
      if (current?.generation === slot.generation) {
        await tx.put('publication', { messageId: slot.messageId, expiresAt: current.expiresAt })
      }
    })
  }

  async alarm() {
    await this.ctx.storage.transaction(async tx => {
      const current = await tx.get('publication')
      if (current && current.expiresAt <= Date.now()) {
        await tx.delete('publication')
        if ((await tx.get('claim'))?.messageId === current.messageId) await tx.delete('claim')
      }
    })
  }

  async releaseIfOwner(messageId) {
    await this.ctx.storage.transaction(async transaction => {
      if ((await transaction.get('claim'))?.messageId === messageId) await transaction.delete('claim')
      if ((await transaction.get('publication'))?.messageId === messageId) {
        await transaction.delete('publication')
        await transaction.deleteAlarm()
      }
    })
  }
}

export async function serveQueueRequest(request, env) {
  const path = new URL(request.url).pathname
  if (path === '/world/queue/publish') return publishQueueRequest(request, env)
  if (request.method !== 'POST' || !['/world/queue/claim', '/world/queue/release'].includes(path)) {
    return new Response(null, { status: 404 })
  }
  const { key, owner, staleMs } = await request.json()
  if (typeof key !== 'string' || typeof owner !== 'string' || !key || !owner) return new Response(null, { status: 400 })
  const claim = env.EVE_CLAIMS.getByName(key)
  if (path === '/world/queue/release') {
    await claim.releaseIfOwner(owner)
    return new Response(null, { status: 204 })
  }
  if (!Number.isSafeInteger(staleMs) || staleMs < 1) return new Response(null, { status: 400 })
  return Response.json(await claim.claimInflight({ messageId: owner, staleMs }))
}

export class WorldQueueService extends WorkerEntrypoint {
  fetch(request) {
    if (this.env.WORLD_WORKLOAD === 'business') return new Response(null, { status: 404 })
    return serveQueueRequest(request, this.env)
  }
}
