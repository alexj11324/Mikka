import { AsyncLocalStorage } from 'node:async_hooks'
import { Socket } from 'node:net'
import pg from 'pg'

type Totals = { statements: number; resultBytes: number }
const active = new AsyncLocalStorage<Totals>()
const sockets = new Set<Socket>()
const connect = Socket.prototype.connect
Socket.prototype.connect = function (this: Socket, ...args: unknown[]) {
  sockets.add(this)
  return Reflect.apply(connect, this, args)
} as typeof Socket.prototype.connect
const received = () => [...sockets].reduce((sum, socket) => sum + socket.bytesRead, 0)

// Installed before importing app pools: their per-client sampler binds query
// when a connection opens. Count real PostgreSQL statements, never ORM calls.
const query = pg.Client.prototype.query
pg.Client.prototype.query = new Proxy(query, { apply(target, client, args) {
  const totals = active.getStore()
  if (!totals) return Reflect.apply(target, client, args)
  totals.statements++
  const record = (result: pg.QueryResult | pg.QueryResult[]) => {
    // Identical JSON row-byte definition to lib/db/egress-sample.ts; no values
    // or SQL/parameters leave the fixture. Socket bytes are reported separately.
    totals.resultBytes += (Array.isArray(result) ? result : [result]).reduce((sum, item) => sum + (item?.rows?.length ? Buffer.byteLength(JSON.stringify(item.rows)) : 0), 0)
  }
  const callback = args.at(-1)
  if (typeof callback === 'function') return Reflect.apply(target, client, [...args.slice(0, -1), (error: unknown, result: pg.QueryResult) => {
    if (!error) record(result)
    return callback(error, result)
  }])
  const pending = Reflect.apply(target, client, args)
  return pending instanceof Promise ? pending.then(result => { record(result); return result }) : pending
} }) as typeof query

export async function measured<T>(work: () => Promise<T>) {
  const totals: Totals = { statements: 0, resultBytes: 0 }
  const before = received()
  const value = await active.run(totals, work)
  return { value, bytes: received() - before, ...totals, responseBytes: Buffer.byteLength(JSON.stringify(value) ?? '') }
}

export const readMetrics = ({ bytes, statements, resultBytes, responseBytes }: Awaited<ReturnType<typeof measured>>) => ({
  databaseStatements: statements, databaseJsonResultBytes: resultBytes, databaseSocketBytes: bytes, actionJsonBytes: responseBytes,
})
