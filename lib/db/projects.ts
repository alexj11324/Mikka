import 'server-only'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
export { projects, projectEvents } from './project-schema'
const globalDb = globalThis as unknown as { projectPool?: Pool }
// Existing issues use MIKKA_DATABASE_URL; new project tables live in the connected Neon resource.
const pool = globalDb.projectPool ?? new Pool({ connectionString: process.env.DATABASE_URL, max: 5, connectionTimeoutMillis: 10000, idleTimeoutMillis: 20000 })
if (process.env.NODE_ENV !== 'production') globalDb.projectPool = pool
export const projectDb = drizzle(pool)
