import 'server-only'
import { db } from '@/lib/db'
import { coordinatorEvents } from '@/lib/db/schema'
import type { CoordinatorEventInput } from '@/lib/coordinator-events'
import { assertCredentialSafeChat } from '@/lib/credentials/chat-guard'
import { runChanged } from '@/lib/live/panels'
import { runListChanged } from './live/lists'
import { botChatChanged } from './live/chats'
import { wakeCoordinatorAfterCommit } from './coordinator/wake-after-commit'

type Executor = Pick<typeof db, 'insert' | 'execute'>

/**
 * Returns the stored event ID on insertion. A repeated dedupe key returns no ID. The
 * event names its chat's bot itself (CoordinatorEventInput.botId); nothing is
 * resolved here, so run completion, recovery and publication never depend on
 * the Coordinator lookup.
 */
export async function recordCoordinatorEvent(executor: Executor, event: CoordinatorEventInput) {
  // Read through the same executor: inside a transaction this keeps to its one connection.
  await assertCredentialSafeChat(event.userId, event.payload, executor)
  const inserted = await executor.insert(coordinatorEvents).values({ id: crypto.randomUUID(), ...event }).onConflictDoNothing({ target: coordinatorEvents.dedupeKey }).returning({ id: coordinatorEvents.id })
  if (!inserted.length) return
  if (event.runId) await runChanged(executor, event.runId)
  await botChatChanged(executor, event.userId, event.botId ?? null)
  // A pending row starts its turn after COMMIT, whether or not the caller also wakes (#1212).
  wakeCoordinatorAfterCommit(executor, event.userId)
  if (event.runId && ['run_finished', 'run_retried', 'run_credential_switched', 'run_quota_paused', 'run_question', 'run_blocked'].includes(event.kind)) {
    await runListChanged(executor, event.runId)
  }
  return inserted[0].id
}
