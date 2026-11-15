import 'server-only'
import { afterDatabaseCommit } from '@/lib/db/commit-effects'
import { issueListChanged } from '@/lib/live/lists'
import { ADVANCE_ON_RUN_START, advanceIssueStatus } from '@/lib/task-status-advance'

type Query = { query: (text: string, values: unknown[]) => Promise<{ rows: unknown[] }> }

/** 进行中 for the task of a run that has started (lib/task-status-advance.ts); true when the task moved. */
export async function advanceTaskForStartedRun(database: Query, runId: string): Promise<string | null> {
  const { rows } = await database.query(ADVANCE_ON_RUN_START, [runId])
  const run = rows[0] as { issueId: string; createdAt: Date } | undefined
  if (!run) return null
  return await advanceIssueStatus(database, { issueId: run.issueId, to: 'doing', since: run.createdAt, source: 'run-started' }) ? run.issueId : null
}

/**
 * Called where a run is claimed, inside the claim's transaction. The task moves after that transaction commits, in
 * its own statement that locks only the task: the claim keeps its lock order (run first), and a claim never fails or
 * waits because of the task. An executor without commit tracking is skipped; the next event moves the task.
 */
export function advanceTaskAfterRunStart(executor: object, runId: string) {
  try {
    afterDatabaseCommit(executor, `task-status:run-started:${runId}`, async () => {
      try {
        // The application's own pool, outside the claim's client: one short statement that locks only the task.
        const { pool, withoutDatabaseClient } = await import('@/lib/db/request-scope')
        await withoutDatabaseClient(async () => {
          const moved = await advanceTaskForStartedRun(pool, runId)
          if (moved) await issueListChanged(pool, moved)
        })
      } catch (error) { console.error('task status advance failed', error instanceof Error ? error.name : 'unknown') }
    })
  } catch { /* no commit tracking on this executor */ }
}
