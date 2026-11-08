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
// Only connections opened in this test process; no SQL, parameters or row values are logged.
const received = () => [...sockets].reduce((sum, socket) => sum + socket.bytesRead, 0)
const sent = () => [...sockets].reduce((sum, socket) => sum + socket.bytesWritten, 0)
let measurementSequence = 0

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
  const trace = process.env.MIKKA_READ_METRICS_TRACE === '1'
  const caller = trace ? new Error().stack?.split('\n').find(line => line.includes('/tests/') && !line.includes('/helpers/read-metrics.'))?.trim() : undefined
  const before = received(), beforeSent = sent()
  const value = await active.run(totals, work)
  const result = { value, bytes: received() - before, bytesWritten: sent() - beforeSent, ...totals, responseBytes: Buffer.byteLength(JSON.stringify(value) ?? '') }
  if (trace) console.log('Read metrics trace:', JSON.stringify({ measurement: ++measurementSequence, caller,
    databaseStatements: result.statements, databaseJsonResultBytes: result.resultBytes,
    databaseSocketBytes: result.bytes, databaseSocketBytesWritten: result.bytesWritten, actionJsonBytes: result.responseBytes }))
  return result
}

export const readMetrics = ({ bytes, bytesWritten, statements, resultBytes, responseBytes }: Awaited<ReturnType<typeof measured>>) => ({
  databaseStatements: statements, databaseJsonResultBytes: resultBytes, databaseSocketBytes: bytes, databaseSocketBytesWritten: bytesWritten, actionJsonBytes: responseBytes,
})
