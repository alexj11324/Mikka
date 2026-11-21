import 'server-only'
import { generateText } from 'ai'
import { defaultModelAvailable } from '@/lib/default-model'
import { and, eq, sql } from 'drizzle-orm'
import { TITLE_MODEL } from '@/lib/coordinator/model'
import { db } from '@/lib/db'
import { attentionSettings, suggestions } from '@/lib/db/schema'
import { ACTION_BATCH, actionLocale, actionTitlePrompt, parseActionTitles, type ActionLocale, type ActionTitleInput } from './action-title'
import { withAiMetadata } from '@/lib/tracing/ai'

/** Action titles share the managed title model. */
const ACTION_TITLE_MODEL = TITLE_MODEL
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
 * ACTION_BATCH, one model call each, through LiteLLM; the hosted usage budget caps the spend.
 * When unavailable, the items keep their raw title.
 * Never throws.
 */
export async function writeActionTitles(userId: string, items: readonly ActionTitleInput[]): Promise<void> {
  'use step'
  const { hostedModel, admitHostedModel } = await import('@/lib/abuse/model')
  const { executionWorkspace } = await import('@/lib/execution-settings')
  if (!items.length) return
  try {
    if (!await defaultModelAvailable(userId)) return
    const locale = await personLocale(userId)
    const workspaceId=await executionWorkspace(userId,null)
    await admitHostedModel({workspaceId,ownerId:userId},ACTION_TITLE_MODEL,{auditAllowed:false})
    const model=await hostedModel(workspaceId,ACTION_TITLE_MODEL,undefined,userId)
    for (let start = 0; start < items.length; start += ACTION_BATCH) {
      const batch = items.slice(start, start + ACTION_BATCH)
      const { instructions, prompt } = actionTitlePrompt(batch, locale)
      const { text } = await withAiMetadata({ operation: 'action_title' }, () => generateText({ model, instructions, prompt, maxRetries: 1, abortSignal: AbortSignal.timeout(ACTION_TITLE_TIMEOUT_MS) }))
      for (const [id, actionTitle] of parseActionTitles(text, batch.map(item => item.id), locale)) {
        await db.update(suggestions).set({ actionTitle }).where(and(eq(suggestions.id, id), eq(suggestions.userId, userId)))
      }
    }
  } catch (error) {
    console.error('Action titles failed', error instanceof Error ? error.message : error)
  }
}
