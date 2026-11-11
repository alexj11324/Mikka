import { Pool, type PoolConfig } from 'pg'
import { directPoolOptions } from '../../scripts/postgres-connection.mjs'
import { observePoolCommits } from '../db/commit-effects'

/** A group worker holds a session lock across provider I/O. Neon's transaction
 * pooler may lend the same backend to another logical client during that I/O,
 * allowing the second worker to re-enter the first worker's session lock.
 * Use the configured direct connection for this database. */
export function groupTurnSessionOptions(options: PoolConfig): PoolConfig {
  return { ...directPoolOptions(options), max: 1, connectionTimeoutMillis: 5_000, application_name: 'mikka-group-turn' }
}

/** One physical connection belongs to this worker until close. Never return
 * an advisory-locked backend to a reusable pool, including on errors. */
export async function openGroupTurnSession(database: Pool) {
  const sessions = new Pool(groupTurnSessionOptions(database.options))
  observePoolCommits(sessions)
  const client = await sessions.connect().catch(async error => { await sessions.end(); throw error })
  let lost = false, closed: Promise<void> | undefined
  const losses = new Set<() => void>()
  const invalidate = () => { lost = true; for (const callback of losses) callback() }
  client.on('error', invalidate); client.on('end', invalidate)
  sessions.on('error', invalidate)
  const assertHeld = () => { if (lost) throw new Error('group_turn_session_lost') }
  const close = () => closed ??= (async () => {
    try { await client.end() }
    finally {
      client.release(true); await sessions.end()
      client.off('error', invalidate); client.off('end', invalidate)
    }
  })()
  /** Called once the physical session is gone (its locks with it). */
  const onLost = (callback: () => void) => {
    if (lost) queueMicrotask(callback)
    losses.add(callback)
    return () => { losses.delete(callback) }
  }
  return { client, assertHeld, isLost: () => lost, onLost, close }
}
