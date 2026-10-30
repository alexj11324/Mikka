import { z } from 'zod'
import { WORKSPACE_BOT_MODELS, type WorkspaceBotModel } from '@/lib/db/schema'

/**
 * 设置 › Bot (V13 / WS-05~07) pure helpers: the three model families shown in
 * the 模型 menu, and paging plus title rules for a bot's 线程列表 drawer.
 * No DB imports, so client components and unit tests can use it.
 */

export interface BotModelGroup {
  /** Stored value for workspace_settings.defaultModel and bots.model. */
  id: WorkspaceBotModel
  /** 'hosted' runs on Mikka's own model; 'subscription' uses the bot owner's connected Codex / Claude account. */
  source: 'hosted' | 'subscription'
  /** Menu label key under settings.bots.models (Mikka 默认 / Codex / Claude); text lives in messages. */
  labelKey: `Settings.bots.models.${WorkspaceBotModel}`
  /** True for the entry used when nothing is chosen (null). */
  isDefault: boolean
}

/** Mikka 默认 / Codex / Claude, in menu order (Design Lead 10/29: families, no 自定义…). */
export const BOT_MODEL_GROUPS: readonly BotModelGroup[] = WORKSPACE_BOT_MODELS.map(id => ({
  id, source: id === 'mikka' ? 'hosted' : 'subscription', labelKey: `Settings.bots.models.${id}` as const, isDefault: id === 'mikka',
}))

export const BOT_THREAD_PAGE_DEFAULT = 20
export const BOT_THREAD_PAGE_MAX = 50
export const BOT_THREAD_TITLE_MAX = 80

export interface BotThreadPosition { createdAt: string; id: string }

export const botThreadsInput = z.object({
  botId: z.uuid(),
  limit: z.number().int().min(1).max(BOT_THREAD_PAGE_MAX).default(BOT_THREAD_PAGE_DEFAULT),
  cursor: z.string().max(200).nullable().optional(),
}).strict()

const positionSchema = z.object({ createdAt: z.iso.datetime({ offset: true }), id: z.uuid() }).strict()

export function encodeBotThreadCursor(position: BotThreadPosition): string {
  return Buffer.from(JSON.stringify({ createdAt: position.createdAt, id: position.id })).toString('base64url')
}

/** Null when the cursor is not one this server produced. */
export function decodeBotThreadCursor(cursor: string): BotThreadPosition | null {
  if (cursor.length > 200 || !/^[A-Za-z0-9_-]+$/.test(cursor)) return null
  try {
    const parsed = positionSchema.safeParse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')))
    return parsed.success ? parsed.data : null
  } catch { return null }
}

/**
 * The row title. A task's title is shown only when the viewer may see that task;
 * a chat thread's prompt only to the person who started it. Anything else is
 * null and the UI shows a generic 私有线程 label — never a redacted fragment.
 */
export function botThreadTitle(input: { issueTitle: string | null; issueVisible: boolean; prompt: string; startedByViewer: boolean }): string | null {
  const raw = input.issueTitle !== null ? (input.issueVisible ? input.issueTitle : null) : (input.startedByViewer ? input.prompt : null)
  const line = raw?.split('\n').map(part => part.trim()).find(Boolean)
  if (!line) return null
  const chars = Array.from(line)
  return chars.length > BOT_THREAD_TITLE_MAX ? `${chars.slice(0, BOT_THREAD_TITLE_MAX - 1).join('')}…` : line
}
