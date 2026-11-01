import 'server-only'
import { db } from '@/lib/db'
import { coordinatorEvents } from '@/lib/db/schema'
import type { CoordinatorEventInput } from '@/lib/coordinator-events'
import { assertCredentialSafeChat } from '@/lib/credentials/chat-guard'

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
  await executor.insert(coordinatorEvents).values({ id: crypto.randomUUID(), ...event }).onConflictDoNothing({ target: coordinatorEvents.dedupeKey })
}

