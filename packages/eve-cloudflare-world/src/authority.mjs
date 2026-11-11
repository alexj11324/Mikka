import { DurableObject } from 'cloudflare:workers'
import { applyWorldEvent, initializeWorldStorage, listEvents, readEvent, readHookById, readHookByToken, readRun } from './admission.mjs'

/** Private RPC storage authority. Its service binding selects the deployment's
 * World namespace independently of all user-supplied tokens and run ids. */
export class EveWorldAuthority extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    initializeWorldStorage(ctx.storage)
  }
  create(runId, event) { return applyWorldEvent(this.ctx.storage, runId, event) }
  run(runId) { return readRun(this.ctx.storage, runId) }
  hook(hookId) { return readHookById(this.ctx.storage, hookId) }
  hookByToken(token) { return readHookByToken(this.ctx.storage, token) }
  event(runId, slot) { return readEvent(this.ctx.storage, runId, slot) }
  events(runId, pagination) { return listEvents(this.ctx.storage, runId, pagination) }
}

export default { fetch() { return new Response(null, { status: 404 }) } }
