import { AsyncLocalStorage } from 'node:async_hooks'
import type { Pool, PoolClient } from 'pg'

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
const authority = new AsyncLocalStorage<{ caller: DeviceAuthority; pools: WeakMap<Pool, Pool> }>()

export function withDeviceDatabaseAuthority<T>(caller: DeviceAuthority, fn: () => T): T {
  return authority.run({ caller, pools: new WeakMap() }, fn)
}

async function lockAuthority(client: PoolClient, caller: DeviceAuthority) {
  await client.query("SET LOCAL lock_timeout='5s'")
  const result = await client.query('SELECT id FROM device_tokens WHERE id=$1 AND "userId"=$2 AND "revokedAt" IS NULL FOR SHARE', [caller.tokenId, caller.userId])
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
      // A refused BEGIN already releases the connection and rejects later
      // queries above. Callers must not issue a second cleanup ROLLBACK.
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

/** Applies only inside an authenticated daemon scope. No extra admission pool:
 * the connection holding the authority lock performs the protected SQL itself.
 * A connection failure rolls back both, and there is no reconnect/retry here. */
export function deviceScopedPool(base: Pool): Pool {
  const scope = authority.getStore()
  if (!scope) return base
  const existing = scope.pools.get(base)
  if (existing) return existing
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
