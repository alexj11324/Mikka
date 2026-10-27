import 'server-only'
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { bots } from '@/lib/db/schema'

/**
 * The prompt for one chat. The Coordinator is the person's built-in bot; any
 * other bot does the same job with the same tools, under its own name.
 */
export async function botInstructions(userId: string, botId: string | null, base: string): Promise<string> {
  if (!botId) return base
  const [bot] = await db.select({ name: bots.name }).from(bots).where(and(eq(bots.id, botId), eq(bots.ownerId, userId))).limit(1)
  if (!bot) return base
  return `${base.replace('You are the Coordinator in Mikka', `You are ${bot.name}, one of the person's bots in Mikka`)}\n\nYour name is ${bot.name}. The person named you; answer to it and never call yourself the Coordinator. The Coordinator is another of their bots with its own chat.`
}
