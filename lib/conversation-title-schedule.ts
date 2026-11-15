import { afterJob } from '@/lib/background'
import { afterDatabaseCommit } from '@/lib/db/commit-effects'
import type { ConversationTitleTrigger } from './conversation-title'

/**
 * Names a conversation once the transaction that created or moved it commits, the way a task's short title is
 * scheduled (short-title-schedule.ts): after the response, never blocking a run, and anything that goes wrong leaves
 * the conversation with its bounded fallback. An executor without commit tracking is skipped.
 */
export function scheduleConversationTitle(executor: object, runId: string, ownerId: string, trigger: ConversationTitleTrigger) {
  try {
    afterDatabaseCommit(executor, `conversation-title:${runId}:${trigger}`, () => afterJob('after:conversation-title', async () => {
      const { withoutDatabaseClient } = await import('./db/request-scope')
      const { writeConversationTitle } = await import('./conversation-title-server')
      await withoutDatabaseClient(() => writeConversationTitle(runId, ownerId, trigger))
    }, { orRun: true, retainContext: true }))
  } catch (error) {
    console.warn('Conversation title not scheduled', error instanceof Error ? error.name : 'unknown')
  }
}
