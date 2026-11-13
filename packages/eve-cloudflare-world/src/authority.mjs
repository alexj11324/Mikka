export { BusinessWorldService, WorldService } from './world-service.mjs'
export { EveQueueClaim, WorldQueueService } from './queue-service.mjs'
import { consumeWorldQueue } from './queue-transport.mjs'
export { EveWorldStream } from './streams.mjs'
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers'
import { filterRun } from './records.mjs'
import { listHooks, listRuns } from './catalog.mjs'
import { signalTerminal, subscribeToRun } from './terminal.mjs'
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
  create(runId, event, params) {
    const result = applyWorldEvent(this.ctx.storage, runId, event, Date.now(), params)
    if (result.ok) signalTerminal(this.ctx, result.run)
    return result
  }
  fetch(request) {
    const url = new URL(request.url)
    if (url.pathname !== '/world/run-terminal') return new Response(null, { status: 404 })
    return subscribeToRun(this.ctx, request, this.run(url.searchParams.get('runId'), url.searchParams.get('resolveData')))
  }
  webSocketClose(socket, code, reason) { socket.close(code, reason) }
  webSocketError(socket) { socket.close(1011, 'Terminal subscription closed') }
  runs(options) {
    const page = listRuns(this.ctx.storage, options)
    return options?.resolveData === 'none' ? { ...page, data: page.data.map(run => filterRun(run, 'none')) } : page
  }
  hooks(options) { return listHooks(this.ctx.storage, options) }
  run(runId, resolveData) { return filterRun(readRun(this.ctx.storage, runId), resolveData) }
  step(runId, stepId) { return readStep(this.ctx.storage, runId, stepId) }
  steps(runId, options) { return listSteps(this.ctx.storage, runId, options) }
  hook(hookId) { return readHookById(this.ctx.storage, hookId) }
  hookByToken(token) { return readHookByToken(this.ctx.storage, token) }
  event(runId, slot) { return readEvent(this.ctx.storage, runId, slot) }
  events(runId, pagination, correlationId) { return listEvents(this.ctx.storage, runId, pagination, correlationId) }
}

// Only an explicit service binding to this named entrypoint can read or
// release a stream. The default Worker has no route to either operation.
export class WorldStreamService extends WorkerEntrypoint {
  fetch(request) {
    if (this.env.WORLD_WORKLOAD === 'business') return new Response(null, { status: 404 })
    return serveStreamRequest(request, this.env.EVE_STREAMS)
  }
}

export default { queue: consumeWorldQueue, fetch() { return new Response(null, { status: 404 }) } }
