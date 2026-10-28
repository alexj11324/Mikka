import 'server-only'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import * as schema from '@/lib/db/workspace-schema'
import { workspaceDatabaseURL } from '@/lib/db/config'

// Workspace tables live in the Marketplace database; existing auth and tasks stay in MIKKA_DATABASE_URL.
const globalDb = globalThis as unknown as { workspacePool?: Pool }
const connectionString = workspaceDatabaseURL(process.env)
const pool = process.env.VERCEL_ENV === 'preview'
  ? new Pool({ connectionString, max: 5, connectionTimeoutMillis: 10000, idleTimeoutMillis: 20000 })
  : globalDb.workspacePool ?? new Pool({ connectionString, max: 5, connectionTimeoutMillis: 10000, idleTimeoutMillis: 20000 })
if (process.env.NODE_ENV !== 'production' && process.env.VERCEL_ENV !== 'preview') globalDb.workspacePool = pool
export const workspaceDb = drizzle(pool, { schema })
