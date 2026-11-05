import 'server-only'
import { afterJob } from '@/lib/background'

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
      console.error('Could not stop run recordings', error instanceof Error ? error.message : error)
    }
  }
  // Outside a request (a script, a test) there is no `after`; run it detached.
  afterJob('after:stop-recordings', stop, { orRun: true })
}
