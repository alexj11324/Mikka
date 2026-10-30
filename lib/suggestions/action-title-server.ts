import 'server-only'
import { createGateway, generateText } from 'ai'
import { and, eq, sql } from 'drizzle-orm'
import { COORDINATOR_MODEL } from '@/lib/coordinator/model'
import { db } from '@/lib/db'
import { attentionSettings, suggestions } from '@/lib/db/schema'
import { ACTION_BATCH, actionLocale, actionTitlePrompt, parseActionTitles, type ActionLocale, type ActionTitleInput } from './action-title'

/** The small text model that writes action lines; the Coordinator's flash model. */
const ACTION_TITLE_MODEL = COORDINATOR_MODEL
const ACTION_TITLE_TIMEOUT_MS = 15_000

/** The language the person last used 建议 in (zh-CN until known). */
export async function personLocale(userId: string): Promise<ActionLocale> {
  const [row] = await db.select({ locale: attentionSettings.locale }).from(attentionSettings).where(eq(attentionSettings.userId, userId)).limit(1)
  return actionLocale(row?.locale)
}

/** Remembers the language the person reads 建议 in, so new action lines are written in it. */
export async function rememberLocale(userId: string, locale: ActionLocale): Promise<void> {
  await db.insert(attentionSettings).values({ userId, locale }).onConflictDoUpdate({ target: attentionSettings.userId, set: { locale, updatedAt: new Date() }, setWhere: sql`${attentionSettings.locale} is distinct from ${locale}` })
}

/**
 * Writes action lines (R-45) for one person's newly shown items, in batches of
 * ACTION_BATCH, one model call each. Like the decision model it signs in with
 * DECISION_GATEWAY_API_KEY, whose budget caps the spend; without the key, or
 * when a call fails, the items keep their raw title. Never throws.
 */
export async function writeActionTitles(userId: string, items: readonly ActionTitleInput[]): Promise<void> {
  'use step'
  const { hostedModel } = await import('@/lib/abuse/model')
  const { executionWorkspace } = await import('@/lib/execution-settings')
  const key = process.env.DECISION_GATEWAY_API_KEY
  if (!key || !items.length) return
  try {
    const locale = await personLocale(userId)
    const gateway = createGateway({ apiKey: key })
    for (let start = 0; start < items.length; start += ACTION_BATCH) {
      const batch = items.slice(start, start + ACTION_BATCH)
      const { instructions, prompt } = actionTitlePrompt(batch, locale)
      const { text } = await generateText({ model: await hostedModel(await executionWorkspace(userId,null),ACTION_TITLE_MODEL,gateway(ACTION_TITLE_MODEL)), instructions, prompt, maxRetries: 1, abortSignal: AbortSignal.timeout(ACTION_TITLE_TIMEOUT_MS) })
      for (const [id, actionTitle] of parseActionTitles(text, batch.map(item => item.id), locale)) {
        await db.update(suggestions).set({ actionTitle }).where(and(eq(suggestions.id, id), eq(suggestions.userId, userId)))
      }
    }
  } catch (error) {
    console.error('Action titles failed', error instanceof Error ? error.message : error)
  }
}
