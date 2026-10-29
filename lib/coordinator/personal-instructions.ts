import 'server-only'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { userPreferences } from '@/lib/db/schema'
import { instructionsWithPersonal } from './context'

/**
 * The Coordinator's or a Bot's system prompt with the person's 个人指令 added
 * (user_preferences."personalInstructions", saved through lib/preferences.ts).
 * Read every turn, so a saved or cleared instruction applies from the next prompt on.
 */
export async function withPersonalInstructions(userId: string, instructions: string): Promise<string> {
  const [row] = await db.select({ text: userPreferences.personalInstructions }).from(userPreferences).where(eq(userPreferences.userId, userId)).limit(1)
  return instructionsWithPersonal(instructions, row?.text ?? '')
}
