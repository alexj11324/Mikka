import { afterJob } from '@/lib/background'
import { afterDatabaseCommit } from '@/lib/db/commit-effects'
import type { ThreadTitleTrigger } from './thread-title'

/**
 * Names a thread once the transaction that created or moved it commits, the way a task's short title is
 * scheduled: after the response, never blocking a run, and anything that goes wrong leaves
 * the thread with its bounded fallback. An executor without commit tracking is skipped.
 */
export function scheduleThreadTitle(executor: object, runId: string, ownerId: string, trigger: ThreadTitleTrigger) {
  try {
    afterDatabaseCommit(executor, `thread-title:${runId}:${trigger}`, () => afterJob('after:thread-title', async () => {
      const { withoutDatabaseClient } = await import('./db/request-scope')
      const { writeThreadTitle } = await import('./thread-title-server')
      await withoutDatabaseClient(() => writeThreadTitle(runId, ownerId, trigger))
    }, { orRun: true, retainContext: true }))
  } catch (error) {
    console.warn('Thread title not scheduled', error instanceof Error ? error.name : 'unknown')
  }
}
