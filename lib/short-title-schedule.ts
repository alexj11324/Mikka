import { afterJob } from '@/lib/background'
import { afterDatabaseCommit } from '@/lib/db/commit-effects'

/**
 * Starts a task's short title once the transaction that created it commits (Alex 2026-11-06). Creation never waits for
 * it and never fails because of it: the call runs after the response, and anything that goes wrong leaves the task
 * with its own title. The model call lives in short-title-server.ts, loaded only when the job runs, so task creation
 * stays importable where server-only modules are not.
 */
export function scheduleShortTitle(executor: object, issueId: string, ownerId: string) {
  try {
    afterDatabaseCommit(executor, `short-title:${issueId}`, () => afterJob('after:short-title', async () => {
      // The commit context still names the creating transaction as the ambient database; its client is back in the
      // pool by now. Leave it, keeping the request's database, so the job's reads and its write get their own connection.
      const { withoutDatabaseClient } = await import('./db/request-scope')
      const { writeShortTitle } = await import('./short-title-server')
      await withoutDatabaseClient(() => writeShortTitle(issueId, ownerId))
    }, { orRun: true, retainContext: true }))
  } catch (error) {
    console.warn('Short title not scheduled', error instanceof Error ? error.name : 'unknown')
  }
}
