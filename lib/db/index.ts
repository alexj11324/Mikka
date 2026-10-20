import 'server-only'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import * as schema from './schema'

const globalDb = globalThis as unknown as { orviloPool?: Pool }
export const pool = globalDb.orviloPool ?? new Pool({ connectionString: process.env.ORVILO_DATABASE_URL, max: 5, connectionTimeoutMillis: 10000, idleTimeoutMillis: 20000 })
if (process.env.NODE_ENV !== 'production') globalDb.orviloPool = pool
export const db = drizzle(pool, { schema })
