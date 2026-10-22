import 'server-only'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import * as schema from './schema'
import { mikkaDatabaseURL } from './config'

const globalDb = globalThis as unknown as { mikkaPool?: Pool }
export const pool = globalDb.mikkaPool ?? new Pool({ connectionString: mikkaDatabaseURL(process.env), max: 5, connectionTimeoutMillis: 10000, idleTimeoutMillis: 20000 })
if (process.env.NODE_ENV !== 'production') globalDb.mikkaPool = pool
export const db = drizzle(pool, { schema })
