import 'server-only'
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { coordinatorSessions } from '@/lib/db/schema'
import { readCoordinatorPromptPreferences } from '@/lib/preferences'

/** Product memory and settings only; eve owns conversation history and compaction. */
export async function loadProductPromptContext(userId: string, botId: string): Promise<{ memory: string; personalInstructions: string; memoryEnabled: boolean }> {
  const [session, preferences] = await Promise.allSettled([
    db.select({ memory: coordinatorSessions.memory }).from(coordinatorSessions).where(and(eq(coordinatorSessions.userId, userId), eq(coordinatorSessions.botId, botId))).limit(1),
    readCoordinatorPromptPreferences(userId),
  ])
  if (session.status === 'rejected') throw session.reason
  if (preferences.status === 'rejected') throw preferences.reason
  return {
    memory: preferences.value.memoryEnabled ? session.value[0]?.memory ?? '' : '',
    personalInstructions: preferences.value.personalInstructions,
    memoryEnabled: preferences.value.memoryEnabled,
  }
}
