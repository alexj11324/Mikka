import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { deploymentSwitch } from '@/lib/deployment-switches'

type Scope = 'default' | 'request' | 'device_fence'
type Stream = { bytesRead?: number; once: (event: string, callback: () => void) => unknown; removeListener: (event: string, callback: () => void) => unknown }
type Entry = { stream: Stream | undefined; last: number | null; scope: Scope; close: () => void }
type Options = { on: () => boolean; now: () => number; sink: (line: string) => void; schedule: (callback: () => void) => () => void }
const enabled = () => { try { return deploymentSwitch('dbEgressSample') } catch { return false } }
const count = (stream: Stream | undefined): number | null => {
  try { const value = stream?.bytesRead; return Number.isSafeInteger(value) && value! >= 0 ? value! : null } catch { return null }
}

/** Connection-level counters, never per-query deltas: queued/busy queries cannot double count.
 * Node TLSSocket.bytesRead is decrypted PG protocol bytes, NOT TLS/network or Neon billed bytes.
 * Startup/pre-gate bytes are deliberately excluded. No data listener, SQL, values or parameters. */
export class PgReceiveCollector {
  private pools = new WeakSet<Pool>()
  private clients = new Map<object, Entry>()
  private cancel: (() => void) | undefined
  private start = 0
  private bytes = 0
  private unknown = 0
  private touched = new Set<Entry>()
  private readonly runtime = randomUUID()
  constructor(private options: Options = { on: enabled, now: Date.now, sink: line => console.log(line), schedule: callback => {
    const timer = setInterval(callback, 60_000); timer.unref(); return () => clearInterval(timer)
  } }) {}

  watch(pool: Pool, scope: Scope) {
    if (this.pools.has(pool)) return
    this.pools.add(pool)
    pool.on('connect', client => {
      // This observer never changes query, transaction, socket flow or authority behavior.
      const stream = (client as unknown as { connection?: { stream?: Stream } }).connection?.stream
      const entry: Entry = { stream, scope, last: count(stream), close: () => this.remove(client) }
      this.clients.set(client, entry)
      stream?.once('close', entry.close)
      this.gate()
    })
    pool.on('acquire', () => this.gate())
    pool.on('remove', client => this.remove(client))
  }

  private gate() {
    if (!this.options.on()) {
      this.cancel?.(); this.cancel = undefined
      this.reset()
      return false
    }
    if (!this.cancel && this.clients.size) {
      // Gate decisions load asynchronously. Begin at this acquisition, never backfill off time.
      for (const entry of this.clients.values()) entry.last = count(entry.stream)
      this.reset(); this.start = this.options.now()
      this.cancel = this.options.schedule(() => { if (this.gate()) this.flush() })
    }
    return Boolean(this.cancel)
  }

  private read(entry: Entry) {
    const current = count(entry.stream)
    this.touched.add(entry)
    if (current === null || entry.last === null || current < entry.last) this.unknown++
    else this.bytes += current - entry.last
    entry.last = current
  }

  private remove(client: object) {
    const entry = this.clients.get(client)
    if (!entry) return
    if (this.cancel) this.read(entry)
    entry.stream?.removeListener('close', entry.close)
    this.clients.delete(client)
    if (!this.clients.size && this.cancel) {
      this.flush(); this.cancel(); this.cancel = undefined
    }
  }

  private reset() { this.bytes = 0; this.unknown = 0; this.touched.clear() }

  private flush() {
    for (const entry of this.clients.values()) this.read(entry)
    const end = this.options.now()
    const scopes = [...new Set([...this.touched].map(entry => entry.scope))].sort()
    try {
      this.options.sink(JSON.stringify({ level: 'info', msg: 'db_transport_sample', timestamp: new Date(end).toISOString(), runtime: this.runtime,
        windowStart: new Date(this.start).toISOString(), windowEnd: new Date(end).toISOString(), elapsedMs: end - this.start,
        measurement: 'postgres_protocol_plaintext_received', pgProtocolReceiveBytes: this.unknown ? null : this.bytes, knownPgProtocolReceiveBytes: this.bytes, connections: this.touched.size, scopes,
        unknownReadings: this.unknown, coverage: this.unknown ? 'incomplete' : 'observed_connections', startupExcluded: true,
        excludes: ['TLS', 'TCP', 'startup_before_registration', 'other_runtimes', 'Go_workers', 'supplier_metering'] }))
    } catch { /* diagnostics must never affect the database */ }
    this.reset(); this.start = end
  }
}

const key = Symbol.for('mikka.pgReceiveCollector')
const collectors = globalThis as Record<symbol, unknown>
const collector = (collectors[key] ??= new PgReceiveCollector()) as PgReceiveCollector
export const samplePoolTransport = (pool: Pool, scope: Scope) => collector.watch(pool, scope)
