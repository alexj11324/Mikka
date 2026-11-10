import 'server-only'
import { afterJob } from '@/lib/background'

/** Finish this authenticated run's recording before its terminal event is
 * visible to Factory or PR publication. Remote IO stays outside the completion
 * transaction; a failed capture remains failed and cannot satisfy handoff. */
export async function finishOwnedRunRecordings(userId: string, runId: string, scopeDeviceId?: string | null) {
  const { pool } = await import('@/lib/db')
  const { rows } = await pool.query(`SELECT c.id FROM run_captures c
    JOIN agent_runs r ON r.id=c."runId" AND r."userId"=c."userId"
    JOIN devices d ON d.id=r."deviceId" AND d."ownerId"=r."userId"
    WHERE r.id=$1 AND r."userId"=$2 AND c.status='recording'
      AND ($3::uuid IS NULL OR d.id=$3) LIMIT 1`, [runId, userId, scopeDeviceId ?? null])
  if (!rows.length) return
  const { screenCaptures } = await import('./screen')
  await screenCaptures.stopRunRecordings([runId])
}

/**
 * When runs end, however they end, stop the screen recordings they left
 * going and keep what was recorded. Runs after the response; never holds up
 * or fails the run's own ending.
 */
export function stopRecordingsAfter(runIds: readonly string[]) {
  const stop = async () => {
    try {
      const { runRecordings } = await import('./store')
      if (!(await runRecordings(runIds)).length) return
      const { screenCaptures } = await import('./screen')
      await screenCaptures.stopRunRecordings(runIds)
    } catch (error) {
      console.error('Could not stop run recordings', { name: error instanceof Error ? error.name : 'UnknownError' })
    }
  }
  // Outside a request (a script, a test) there is no `after`; run it detached.
  afterJob('after:stop-recordings', stop, { orRun: true })
}
