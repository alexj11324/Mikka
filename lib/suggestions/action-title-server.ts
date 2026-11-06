import 'server-only'
import { generateText } from 'ai'
import { zeroCatConfig } from '@/lib/abuse/zerocat'
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
 * ACTION_BATCH, one model call each, on the default model's ZeroCat transport
 * (lib/abuse/zerocat.ts); the hosted usage budget caps the spend. Without the
 * ZeroCat variables, or when a call fails, the items keep their raw title.
 * Never throws.
 */
export async function writeActionTitles(userId: string, items: readonly ActionTitleInput[]): Promise<void> {
  'use step'
  const { hostedModel, admitHostedModel } = await import('@/lib/abuse/model')
  const { executionWorkspace } = await import('@/lib/execution-settings')
  if (!items.length || !zeroCatConfig()) return
  try {
    const locale = await personLocale(userId)
    const workspaceId=await executionWorkspace(userId,null)
    await admitHostedModel({workspaceId,ownerId:userId},ACTION_TITLE_MODEL,{auditAllowed:false})
    const model=await hostedModel(workspaceId,ACTION_TITLE_MODEL,undefined,userId)
    for (let start = 0; start < items.length; start += ACTION_BATCH) {
      const batch = items.slice(start, start + ACTION_BATCH)
      const { instructions, prompt } = actionTitlePrompt(batch, locale)
      const { text } = await generateText({ model, instructions, prompt, maxRetries: 1, abortSignal: AbortSignal.timeout(ACTION_TITLE_TIMEOUT_MS) })
      for (const [id, actionTitle] of parseActionTitles(text, batch.map(item => item.id), locale)) {
        await db.update(suggestions).set({ actionTitle }).where(and(eq(suggestions.id, id), eq(suggestions.userId, userId)))
      }
    }
  } catch (error) {
    console.error('Action titles failed', error instanceof Error ? error.message : error)
  }
}
