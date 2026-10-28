import 'server-only'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import * as schema from '@/lib/db/workspace-schema'

// Workspace tables live in the Marketplace database; existing auth and tasks stay in MIKKA_DATABASE_URL.
const globalDb = globalThis as unknown as { workspacePool?: Pool }
const pool = globalDb.workspacePool ?? new Pool({ connectionString: process.env.DATABASE_URL, max: 5, connectionTimeoutMillis: 10000, idleTimeoutMillis: 20000 })
if (process.env.NODE_ENV !== 'production') globalDb.workspacePool = pool
export const workspaceDb = drizzle(pool, { schema })
// Existing identity/pool, exposed only for bounded host read-lock guards.
export const workspacePool = pool
