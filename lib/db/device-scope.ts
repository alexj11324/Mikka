import { AsyncLocalStorage } from 'node:async_hooks'
import { Pool as PoolClass, type Pool, type PoolClient } from 'pg'
import { samplePoolTransport } from './transport-sample'
import { manageDatabasePool } from './pool-lifecycle'

export class DeviceAuthorityRevoked extends Error {
  constructor() { super('Device authority revoked') }
}
/** Only a typed revocation cause is authentication failure. Bound traversal and
 * avoid invoking arbitrary cause getters; ordinary SQL/connection errors stay 500. */
export function isDeviceAuthorityRevoked(error: unknown): boolean {
  const seen = new Set<Error>()
  for (let depth = 0; depth < 8 && error instanceof Error; depth++) {
    if (error instanceof DeviceAuthorityRevoked) return true
    if (seen.has(error)) return false
    seen.add(error)
    error = Object.getOwnPropertyDescriptor(error, 'cause')?.value
  }
  return false
}
export type DeviceAuthority = { tokenId: string; userId: string }

/** The fence connection could not be had (its pool is exhausted or the database refused): answer 503, never run unfenced. */
export class DeviceFenceUnavailable extends Error {
  constructor(cause?: unknown) { super('Device authority fence unavailable', { cause }) }
}
/** Revocation and an unavailable fence are both refusals: a route's own catch-all must let them reach withDeviceRoute. */
export function isDeviceAuthorityError(error: unknown): boolean {
  if (isDeviceAuthorityRevoked(error)) return true
  const seen = new Set<Error>()
  for (let depth = 0; depth < 8 && error instanceof Error; depth++) {
    if (error instanceof DeviceFenceUnavailable) return true
    if (seen.has(error)) return false
    seen.add(error)
    error = Object.getOwnPropertyDescriptor(error, 'cause')?.value
  }
  return false
}

/**
 * The unit fence (M1b): while a burst of a request's statements runs, one
 * connection from a small separate pool holds the caller's token row FOR SHARE
 * in an open transaction. Every revocation is an UPDATE of that row, so it
 * waits until the burst ends; a later burst takes the fence again and finds the
 * token revoked. The statements themselves run as before (autocommit, their own
 * transactions) on the ordinary pool, with no fence statements around each one.
 * A burst ends after FENCE_IDLE_MS without a statement in flight, so waits and
 * network IO between statements never hold the fence. The connection's
 * idle-in-transaction timeout (10 s) bounds a hung process; a fence lost that
 * way fails the rest of the request closed.
 */
type UnitFence = { client: PoolClient | null; acquiring: Promise<void> | null; inflight: number; idle: ReturnType<typeof setTimeout> | null; lost: boolean; closed: boolean; source: Pool | null; onError: () => void }
const authority = new AsyncLocalStorage<{ caller: DeviceAuthority; pools: WeakMap<Pool, Pool>; fence?: UnitFence }>()
export const FENCE_IDLE_MS = 1_000
export const FENCE_IDLE_IN_TRANSACTION = '10s'
/** The timeout new fences take. Production never changes it; the hung-unit
 * test in lib/device-unit-fence.db.test.ts shortens it instead of waiting 10 s. */
export const fenceIdleInTransaction = { seconds: 10 }
const FENCE_POOL_MAX = 3
const FENCE_CONNECT_TIMEOUT_MS = 2_000
const fencePools = new WeakMap<Pool, Pool>()

export function withDeviceDatabaseAuthority<T>(caller: DeviceAuthority, fn: () => T): T {
  return authority.run({ caller, pools: new WeakMap() }, fn)
}

/** Deferred jobs keep the caller's credential checks, but cannot borrow a
 * request's finished unit fence. Each statement/transaction releases its own
 * authority lock before the job waits or returns to the serverless scheduler. */
export function withBackgroundDeviceAuthority<T>(fn: () => T): T {
  const caller = authority.getStore()?.caller
  return caller ? withDeviceDatabaseAuthority(caller, fn) : fn()
}

/** One device request under the unit fence (lib/device-route.ts, when the deployment switch is on). */
export async function withDeviceUnitFence<T>(caller: DeviceAuthority, fn: () => Promise<T>): Promise<T> {
  const fence: UnitFence = { client: null, acquiring: null, inflight: 0, idle: null, lost: false, closed: false, source: null, onError: () => { fence.lost = true } }
  try { return await authority.run({ caller, pools: new WeakMap(), fence }, fn) }
  finally { fence.closed = true; await releaseFence(fence) }
}

function fencePool(base: Pool): Pool {
  let fenced = fencePools.get(base)
  if (!fenced) {
    const { connectionString, ssl, host, port, database, user, password } = base.options
    fenced = new PoolClass({ connectionString, ssl, host, port, database, user, password, max: FENCE_POOL_MAX, connectionTimeoutMillis: FENCE_CONNECT_TIMEOUT_MS, idleTimeoutMillis: 20_000 })
    manageDatabasePool(fenced)
    samplePoolTransport(fenced, 'device_fence')
    fencePools.set(base, fenced)
  }
  return fenced
}

async function acquireFence(fence: UnitFence, caller: DeviceAuthority, base: Pool) {
  if (fence.lost || fence.closed) throw new DeviceFenceUnavailable()
  if (fence.client) return
  if (!fence.acquiring) fence.acquiring = (async () => {
    let client: PoolClient
    try { client = await fencePool(fence.source ?? base).connect() } catch (error) { throw new DeviceFenceUnavailable(error) }
    client.on('error', fence.onError)
    const drop = (destroy: boolean) => { client.off('error', fence.onError); client.release(destroy) }
    try {
      await client.query(`BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL idle_in_transaction_session_timeout='${fenceIdleInTransaction.seconds}s'`)
      const result = await client.query('SELECT id FROM device_tokens WHERE id=$1 AND "userId"=$2 AND "revokedAt" IS NULL AND ("expiresAt" IS NULL OR "expiresAt">clock_timestamp()) FOR SHARE', [caller.tokenId, caller.userId])
      if (!result.rowCount) {
        await client.query('ROLLBACK').catch(() => undefined)
        drop(false)
        throw new DeviceAuthorityRevoked()
      }
    } catch (error) {
      if (!isDeviceAuthorityRevoked(error)) { drop(true); throw new DeviceFenceUnavailable(error) }
      throw error
    }
    fence.source ??= base
    fence.client = client
  })().finally(() => { fence.acquiring = null })
  await fence.acquiring
}

async function releaseFence(fence: UnitFence) {
  if (fence.idle) { clearTimeout(fence.idle); fence.idle = null }
  if (fence.acquiring) await fence.acquiring.catch(() => undefined)
  const client = fence.client
  fence.client = null
  if (!client) return
  client.off('error', fence.onError)
  try { await client.query('COMMIT'); client.release() } catch { client.release(true) }
}

function settle(fence: UnitFence) {
  fence.inflight--
  if (fence.inflight > 0 || !fence.client) return
  if (fence.idle) clearTimeout(fence.idle)
  fence.idle = setTimeout(() => { fence.idle = null; if (fence.inflight === 0) void releaseFence(fence) }, FENCE_IDLE_MS)
  fence.idle.unref?.()
}

async function fenced<T>(fence: UnitFence, caller: DeviceAuthority, base: Pool, work: () => Promise<T>): Promise<T> {
  if (fence.idle) { clearTimeout(fence.idle); fence.idle = null }
  fence.inflight++
  try { await acquireFence(fence, caller, base) } catch (error) { settle(fence); throw error }
  return work()
}

async function lockAuthority(client: PoolClient, caller: DeviceAuthority) {
  await client.query("SET LOCAL lock_timeout='5s'")
  const result = await client.query('SELECT id FROM device_tokens WHERE id=$1 AND "userId"=$2 AND "revokedAt" IS NULL AND ("expiresAt" IS NULL OR "expiresAt">clock_timestamp()) FOR SHARE', [caller.tokenId, caller.userId])
  if (!result.rowCount) throw new DeviceAuthorityRevoked()
}

/** Existing app code uses promise queries. Callback/query-stream APIs and
 * transaction-control batches fail closed rather than escape this boundary. */
function queryText(args: unknown[]): string {
  if (args.some(value => typeof value === 'function')) throw new Error('Device database queries require promises')
  const first = args[0]
  const text = typeof first === 'string' ? first : (first as { text?: unknown } | null)?.text
  if (typeof text !== 'string') throw new Error('Device database query text required')
  if (/;\s*(?:begin|start\s+transaction|commit|rollback|end|abort|prepare\s+transaction)\b/i.test(text)) throw new Error('Batched transaction controls are not supported')
  const command = text.trim().replace(/;$/, '').trim()
  if (/^(?:end|abort|prepare\s+transaction)\b/i.test(command)) throw new Error('Unsupported transaction control')
  if (/^(?:commit|rollback)\b/i.test(command) && !/^(?:commit|rollback)(?:\s+(?:work|transaction))?$/i.test(command) && !/^rollback\s+to\s+(?:savepoint\s+)?[a-zA-Z0-9_]+$/i.test(command)) throw new Error('Unsupported transaction completion')
  return command
}

function fencedClient(client: PoolClient, caller: DeviceAuthority): PoolClient {
  let transaction = false, released = false, broken = false
  const onError = () => { broken = true }
  client.on('error', onError)
  const release = (error?: Error | boolean) => {
    if (released) return
    released = true
    client.release(error || broken || transaction)
    client.off('error', onError)
  }
  const rawQuery = (...args: unknown[]) => Reflect.apply(client.query, client, args) as Promise<unknown>
  const query = async (...args: unknown[]) => {
    if (released || broken) throw new Error('Device database connection unavailable')
    const text = queryText(args)
    if (/^(?:begin|start\s+transaction)\b/i.test(text)) {
      if (transaction || text.includes(';')) throw new Error('Nested or batched BEGIN is not supported')
      try {
        const result = await rawQuery(...args)
        transaction = true
        await lockAuthority(client, caller)
        return result
      } catch (error) {
        await client.query('ROLLBACK').catch(() => { broken = true })
        transaction = false
        // Drizzle issues BEGIN before its try/finally. Refused admission must
        // return the checked-out connection here; caller release is idempotent.
        release()
        throw error
      }
    }
    if (/^(?:commit|rollback)(?:\s+(?:work|transaction))?$/i.test(text)) {
      // Cleanup ROLLBACK after a refused BEGIN is harmless; never promote a
      // released/failed connection into an unguarded new transaction.
      const result = await rawQuery(...args)
      transaction = false
      return result
    }
    if (transaction) return rawQuery(...args)
    if (/^(?:savepoint|release|rollback\s+to)\b/i.test(text)) throw new Error('Savepoints require an active transaction')
    // An implicit pool/client statement gets its own authorization transaction.
    await client.query('BEGIN')
    transaction = true
    try {
      await lockAuthority(client, caller)
      const result = await rawQuery(...args)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => { broken = true })
      throw error
    } finally { transaction = false }
  }
  return new Proxy(client, {
    get(target, property) {
      if (property === 'query') return query
      if (property === 'release') return release
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/**
 * One read-only statement that carries the credential check itself, in one
 * round trip: `select` is evaluated only when the caller's credential is
 * still live, and no row means it was revoked or expired. For a read, a
 * single statement's snapshot is as strong as the fenced transaction (a
 * revocation commits wholly before or after it); it takes no lock and is not
 * for writes. The parameters after `params` are the credential's.
 */
export async function readUnderAuthority<T>(base: Pool, select: string, params: readonly unknown[]): Promise<T> {
  const scope = authority.getStore()
  if (!scope) throw new Error('A device authority read requires an authenticated daemon scope')
  const token = `$${params.length + 1}`, user = `$${params.length + 2}`
  const { rows } = await base.query(`SELECT (${select}) AS value FROM device_tokens WHERE id=${token} AND "userId"=${user} AND "revokedAt" IS NULL AND ("expiresAt" IS NULL OR "expiresAt">clock_timestamp())`,
    [...params, scope.caller.tokenId, scope.caller.userId])
  if (!rows.length) throw new DeviceAuthorityRevoked()
  return rows[0].value as T
}

/** Applies only inside an authenticated daemon scope. No extra admission pool:
 * the connection holding the authority lock performs the protected SQL itself.
 * A connection failure rolls back both, and there is no reconnect/retry here. */
export function deviceScopedPool(base: Pool): Pool {
  const scope = authority.getStore()
  if (!scope) return base
  const existing = scope.pools.get(base)
  if (existing) return existing
  const fence = scope.fence
  if (fence) {
    // Unit fence: statements run as they are, inside a fenced burst; a checked-out client counts as in flight until released.
    const unitConnect = (...args: unknown[]) => {
      if (args.length) throw new Error('Device database connections require promises')
      return fenced(fence, scope.caller, base, async () => {
        let client: PoolClient
        try { client = await base.connect() } catch (error) { settle(fence); throw error }
        let released = false
        const release = (error?: Error | boolean) => { if (released) return; released = true; client.release(error); settle(fence) }
        return new Proxy(client, { get(target, property) {
          if (property === 'release') return release
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        } })
      })
    }
    const unit = new Proxy(base, {
      get(target, property) {
        if (property === 'connect') return unitConnect
        if (property === 'query') return (...args: unknown[]) => {
          if (args.some(value => typeof value === 'function')) throw new Error('Device database queries require promises')
          return fenced(fence, scope.caller, base, async () => {
            try { return await Reflect.apply(target.query, target, args) } finally { settle(fence) }
          })
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    scope.pools.set(base, unit)
    return unit
  }
  const connect = async (...args: unknown[]) => {
    if (args.length) throw new Error('Device database connections require promises')
    return fencedClient(await base.connect(), scope.caller)
  }
  const guarded = new Proxy(base, {
    get(target, property) {
      if (property === 'connect') return connect
      if (property === 'query') return async (...args: unknown[]) => {
        const text = queryText(args)
        if (/^(?:begin|start\s+transaction|commit|rollback|savepoint|release)\b/i.test(text)) throw new Error('Transactions require a checked-out client')
        const client = await connect()
        try { return await Reflect.apply(client.query, client, args) }
        finally { client.release() }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  scope.pools.set(base, guarded)
  return guarded
}
