import 'server-only'
import { db } from '@/lib/db'
import { coordinatorEvents } from '@/lib/db/schema'
import type { CoordinatorEventInput } from '@/lib/coordinator-events'
import { assertCredentialSafeChat } from '@/lib/credentials/chat-guard'
import { ownerListChanged, runListChanged } from './live/lists'

type Executor = Pick<typeof db, 'insert' | 'execute'>

/**
 * Writes the event once; a repeat with the same dedupe key is ignored. The
 * event names its chat's bot itself (CoordinatorEventInput.botId); nothing is
 * resolved here, so run completion, recovery and publication never depend on
 * the Coordinator lookup.
 */
export async function recordCoordinatorEvent(executor: Executor, event: CoordinatorEventInput) {
  // Read through the same executor: inside a transaction this keeps to its one connection.
  await assertCredentialSafeChat(event.userId, event.payload, executor)
  const inserted = await executor.insert(coordinatorEvents).values({ id: crypto.randomUUID(), ...event }).onConflictDoNothing({ target: coordinatorEvents.dedupeKey }).returning({ id: coordinatorEvents.id })
  if (!inserted.length) return
  await ownerListChanged(executor, event.userId, ['bot_chat_list'])
  if (event.runId && ['run_finished', 'run_retried', 'run_credential_switched', 'run_quota_paused', 'run_question', 'run_blocked'].includes(event.kind)) {
    await runListChanged(executor, event.runId)
  }
}

