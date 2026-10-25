import 'server-only'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import * as schema from '@/lib/db/workspace-schema'

// Workspace tables live in the Marketplace database; existing auth and tasks stay in MIKKA_DATABASE_URL.
const globalDb = globalThis as unknown as { workspacePool?: Pool }
export const workspacePool = globalDb.workspacePool ?? new Pool({ connectionString: process.env.DATABASE_URL, max: 5, connectionTimeoutMillis: 10000, idleTimeoutMillis: 20000 })
if (process.env.NODE_ENV !== 'production') globalDb.workspacePool = workspacePool
export const workspaceDb = drizzle(workspacePool, { schema })
