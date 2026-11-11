import { Pool, type PoolClient } from 'pg'
import { directPoolOptions } from '../../scripts/postgres-connection.mjs'
import { deviceScopedPool } from './device-scope'

/** The physical session owns its advisory locks until disconnect, even if work throws. */
export async function withDirectSession<T>(database: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const sessions = new Pool({ ...directPoolOptions(database.options), max: 1 })
  try {
    const client = await deviceScopedPool(sessions).connect()
    let lost: Error | undefined
    const rememberLoss = (cause: Error) => { lost = cause }
    client.on('error', rememberLoss)
    try {
      const result = await work(client)
      if (lost) throw lost
      return result
    } finally {
      client.release(true)
      client.off('error', rememberLoss)
    }
  } finally {
    await sessions.end()
  }
}
