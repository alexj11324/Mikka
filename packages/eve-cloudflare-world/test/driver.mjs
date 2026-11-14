import { DurableObject } from 'cloudflare:workers'
import { decode, encode } from 'cbor-x'
import { applyWorldEvent, initializeWorldStorage, listEvents, readHookById, readHookByToken, readRun } from '../src/admission.mjs'

// This test-only worker moves the protocol's clock to exercise the 24h bound.
// Both independent clients write real SQLite transactions through workerd RPC.
export class ClockedAuthority extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    initializeWorldStorage(ctx.storage)
  }
  create(now, runId, event) { return applyWorldEvent(this.ctx.storage, runId, event, now) }
  measureHook(now, runId, event, options) {
    const storage = this.ctx.storage
    const parentRows = []
    const sql = {exec(statement, ...bindings) {
      const cursor = storage.sql.exec(statement, ...bindings)
      if (!/^SELECT .* FROM world_runs WHERE run_id=/i.test(statement)) return cursor
      const rows = cursor.toArray()
      parentRows.push(...rows)
      return {toArray: () => rows}
    }}
    const result = applyWorldEvent({sql,transactionSync: fn => storage.transactionSync(fn)}, runId, event, now, options)
    return {result, parentBytes:encode(parentRows).byteLength, parentRows:parentRows.length}
  }
  run(_now, id) { return readRun(this.ctx.storage, id) }
  hook(now, id) { return readHookById(this.ctx.storage, id, now) }
  hookByToken(now, token) { return readHookByToken(this.ctx.storage, token, now) }
  events(_now, id, pagination) { return listEvents(this.ctx.storage, id, pagination) }
}
export default {
  async fetch(request, env) {
    const [namespace, method, now, args] = decode(new Uint8Array(await request.arrayBuffer()))
    const stub = env.WORLD.getByName(namespace)
    const result = await stub[method](now, ...args)
    return new Response(Uint8Array.from(encode(result)))
  },
}
