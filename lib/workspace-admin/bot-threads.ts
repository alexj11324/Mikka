import { createHash } from 'node:crypto'
import { z } from 'zod'
import { workspaceLink } from '@/components/workspace/workspace-navigation'
export const BOT_THREAD_PAGE_DEFAULT = 20
export const BOT_THREAD_PAGE_MAX = 50
export const BOT_THREAD_TITLE_MAX = 80

/** Keyset position: the thread's last activity and its threadId. */
export interface BotThreadPosition { at: string; threadId: string }

/**
 * Public thread id: `t_` + 32 hex of sha256(`<botId>:<threadKey>`), where the
 * internal key is `issue:<issueId>` (a task's thread) or `chat:<userId>` (one
 * person's chat). Opaque for every row, so a task the viewer cannot see never
 * leaks its id through the row key or the cursor. Same formula in SQL
 * (listBotThreadsFor) and here (tests); stable across pages.
 */
export const BOT_THREAD_ID = /^t_[0-9a-f]{32}$/
export const botThreadPublicId = (botId: string, threadKey: string) => `t_${createHash('sha256').update(`${botId}:${threadKey}`).digest('hex').slice(0, 32)}`

export const botThreadsInput = z.object({
  botId: z.uuid(),
  limit: z.number().int().min(1).max(BOT_THREAD_PAGE_MAX).default(BOT_THREAD_PAGE_DEFAULT),
  cursor: z.string().max(400).nullable().optional(),
}).strict()

const positionSchema = z.object({ at: z.iso.datetime({ offset: true }), threadId: z.string().regex(BOT_THREAD_ID) }).strict()

export function encodeBotThreadCursor(position: BotThreadPosition): string {
  return Buffer.from(JSON.stringify({ at: position.at, threadId: position.threadId })).toString('base64url')
}

/** Null when the cursor is not one this server produced. */
export function decodeBotThreadCursor(cursor: string): BotThreadPosition | null {
  if (cursor.length > 400 || !/^[A-Za-z0-9_-]+$/.test(cursor)) return null
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
export function botThreadTitle(input: { issueTitle: string | null; issueVisible: boolean; prompt: string | null; startedByViewer: boolean }): string | null {
  const raw = input.issueTitle !== null ? (input.issueVisible ? input.issueTitle : null) : (input.startedByViewer ? input.prompt : null)
  const line = raw?.split('\n').map(part => part.trim()).find(Boolean)
  if (!line) return null
  const chars = Array.from(line)
  return chars.length > BOT_THREAD_TITLE_MAX ? `${chars.slice(0, BOT_THREAD_TITLE_MAX - 1).join('')}…` : line
}

/** Where a row opens: the task, or the viewer's own chat with the bot. Null when the viewer may not open it. */
export function botThreadHref(thread: { issueId: string | null; ownerId: string; botId: string }, viewer: { id: string; issueVisible: boolean }): string | null {
  if (thread.issueId) return viewer.issueVisible ? workspaceLink({ issue: thread.issueId }) : null
  return thread.ownerId === viewer.id ? workspaceLink({ bot: thread.botId }) : null
}
