import 'server-only'
import { AsyncLocalStorage } from 'node:async_hooks'
import { Pool, type PoolClient } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import * as schema from '@/lib/db/workspace-schema'
import { workspaceDatabaseURL } from '@/lib/db/config'
import { sampleClient } from '@/lib/db/egress-sample'
import { samplePoolTransport } from '@/lib/db/transport-sample'
import { manageDatabasePool } from '@/lib/db/pool-lifecycle'
import { COMMIT_EXECUTOR, observePoolCommits } from '@/lib/db/commit-effects'
import { currentTransactionBoundary } from '@/lib/db/transaction-boundary'

// Workspace tables live in the Marketplace database; existing auth and tasks stay in MIKKA_DATABASE_URL.
const globalDb = globalThis as unknown as { workspacePool?: Pool }
const connectionString = workspaceDatabaseURL(process.env)
const pool = process.env.VERCEL_ENV === 'preview'
  ? new Pool({ connectionString, max: 5, connectionTimeoutMillis: 10000, idleTimeoutMillis: 20000 })
  : globalDb.workspacePool ?? new Pool({ connectionString, max: 5, connectionTimeoutMillis: 10000, idleTimeoutMillis: 20000 })
manageDatabasePool(pool)
observePoolCommits(pool)
if (process.env.NODE_ENV !== 'production' && process.env.VERCEL_ENV !== 'preview') globalDb.workspacePool = pool
pool.on('connect', client => sampleClient(client))
samplePoolTransport(pool, 'workspace')
const database = drizzle(pool, { schema })
type Transaction = Parameters<Parameters<typeof database.transaction>[0]>[0]
type HeldWorkspace = { client: PoolClient; transaction: Transaction; lease: { active: boolean }; boundary: object | undefined }
const heldWorkspace = new AsyncLocalStorage<HeldWorkspace>()
/** A job started by an APP commit can run before the outer Workspace writer
 * releases its connection. Start that job with its own Workspace checkout. */
export function withoutWorkspaceClient<T>(work: () => T): T {
  return heldWorkspace.exit(work)
}

const currentWorkspace = () => {
  const held = heldWorkspace.getStore()
  return held?.lease.active && held.boundary === currentTransactionBoundary() ? held : undefined
}

/** Deferred work keeps its database configuration, but owns a fresh transaction. */
export function withoutWorkspaceTransaction<T>(work: () => T): T {
  return heldWorkspace.exit(work)
}

/** Opaque identity of this active top-level Workspace transaction. Nested
 * savepoints and parallel async branches share it; a new transaction does not. */
export function workspaceTransactionKey(): object | null {
  return currentWorkspace()?.lease ?? null
}

/** Reuse the authoritative membership transaction through composed actions.
 * A second checkout while every pool connection holds a membership lock can
 * deadlock concurrent task creation. Nested writes are ordinary savepoints. */
async function transaction<T>(work: (tx: Transaction) => Promise<T>, config?: Parameters<typeof database.transaction>[1]): Promise<T> {
  const current = currentWorkspace()
  if (current) return current.transaction.transaction(tx => heldWorkspace.run({ ...current, transaction: tx }, () => work(tx)))
  const client = await pool.connect()
  const lease = { active: true }
  try {
    return await drizzle(client, { schema }).transaction(tx => heldWorkspace.run({ client, transaction: tx, lease, boundary: currentTransactionBoundary() }, async () => {
      try { return await work(tx) }
      // Commit observers run before Drizzle resolves transaction(). An effect
      // starting another transaction must not issue SAVEPOINT after COMMIT.
      finally { lease.active = false }
    }), config)
  } finally {
    // A scheduled after-commit callback can retain AsyncLocalStorage. It must
    // use a fresh checkout after this connection has been returned to the pool.
    lease.active = false
    client.release()
  }
}

export const workspaceDb = new Proxy(database, {
  get(target, property) {
    if (property === 'transaction') return transaction
    const current = currentWorkspace()?.transaction ?? target
    const value = Reflect.get(current, property, current)
    return typeof value === 'function' ? value.bind(current) : value
  },
})

// Existing pool identity, with raw reads on the same pinned transaction.
export const workspacePool = new Proxy(pool, {
  get(target, property) {
    const current = currentWorkspace()?.client
    if (property === COMMIT_EXECUTOR) return current ?? target
    if (property === 'query' && current) return current.query.bind(current)
    const value = Reflect.get(target, property, target)
    return typeof value === 'function' ? value.bind(target) : value
  },
})

