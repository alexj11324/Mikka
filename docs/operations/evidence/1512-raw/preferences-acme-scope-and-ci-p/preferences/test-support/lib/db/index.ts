import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import * as schema from './schema'
export const engine = new PGlite()
export const db = drizzle(engine, { schema })
export const pool = { connect: async () => Object.assign(engine, { release() {} }) }
export const withDatabaseClient = async <T>(_client: unknown, work: () => Promise<T>): Promise<T> => work()
