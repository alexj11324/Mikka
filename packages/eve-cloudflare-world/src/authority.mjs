export { EveQueueClaim, WorldQueueService } from './queue-service.mjs'
import { consumeWorldQueue } from './queue-transport.mjs'
export { EveWorldStream } from './streams.mjs'
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers'
import { listSteps, readStep } from './execution.mjs'
import { serveStreamRequest } from './streams.mjs'
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
  step(runId, stepId) { return readStep(this.ctx.storage, runId, stepId) }
  steps(runId, options) { return listSteps(this.ctx.storage, runId, options) }
  hook(hookId) { return readHookById(this.ctx.storage, hookId) }
  hookByToken(token) { return readHookByToken(this.ctx.storage, token) }
  event(runId, slot) { return readEvent(this.ctx.storage, runId, slot) }
  events(runId, pagination) { return listEvents(this.ctx.storage, runId, pagination) }
}

// Only an explicit service binding to this named entrypoint can read or
// release a stream. The default Worker has no route to either operation.
export class WorldStreamService extends WorkerEntrypoint {
  fetch(request) { return serveStreamRequest(request, this.env.EVE_STREAMS) }
}

export default { queue: consumeWorldQueue, fetch() { return new Response(null, { status: 404 }) } }
