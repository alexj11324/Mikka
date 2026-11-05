import 'server-only'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import * as schema from '@/lib/db/workspace-schema'
import { workspaceDatabaseURL } from '@/lib/db/config'
import { sampleClient } from '@/lib/db/egress-sample'
import { samplePoolTransport } from '@/lib/db/transport-sample'
import { manageDatabasePool } from '@/lib/db/pool-lifecycle'
import { observePoolCommits } from '@/lib/db/commit-effects'

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
export const workspaceDb = drizzle(pool, { schema })
// Existing identity/pool, exposed only for bounded host read-lock guards.
export const workspacePool = pool
