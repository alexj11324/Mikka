import type { JSONContent } from '@tiptap/core'
import type * as Y from 'yjs'
import type { ThreadRecord } from './task-discussion'

/** A mention chip's id for a Bot in a task's description (`bot:<id>`); a person's chip keeps their user id. */
export const BOT_MENTION_PREFIX = 'bot:'

/** A task document's discussions (the `threads` map the editor writes), as the server reads them. */
export function readDocumentThreads(doc: Y.Doc): ThreadRecord[] {
  const value = doc.getMap('threads').toJSON() as Record<string, ThreadRecord>
  return Object.values(value).filter(thread => typeof thread?.id === 'string' && Array.isArray(thread.messages))
}

/** One comment a save added: its key (thread and position, stable across saves) and who wrote it. */
export type NewComment = { key: string; body: string; authorUserId: string | null }

/**
 * The comments one document save added. A discussion's messages are only ever appended (replies), so a message is
 * new when its thread is new or its position is past the thread's earlier length. Empty bodies are not comments.
 */
export function newComments(before: readonly ThreadRecord[], after: readonly ThreadRecord[]): NewComment[] {
  const known = new Map(before.map(thread => [thread.id, thread.messages.length]))
  return after.flatMap(thread => thread.messages.flatMap((message, index) => index < (known.get(thread.id) ?? 0) || !message.body?.trim() ? []
    : [{ key: `comment:${thread.id}:${index}`, body: message.body.trim(), authorUserId: message.authorUserId ?? null }]))
}

/** The Bot ids the description's mention chips name. */
export function mentionedBotIds(content: JSONContent | null | undefined): Set<string> {
  const ids = new Set<string>()
  const walk = (node: JSONContent | undefined) => {
    if (!node) return
    const id = node.type === 'mention' ? node.attrs?.id : null
    if (typeof id === 'string' && id.startsWith(BOT_MENTION_PREFIX)) ids.add(id.slice(BOT_MENTION_PREFIX.length))
    node.content?.forEach(walk)
  }
  walk(content ?? undefined)
  return ids
}

/** Whether a comment's plain text @-mentions a Bot by its name: `@Name` followed by an end, a space or punctuation. */
export function textMentions(body: string, name: string) {
  const at = `@${name}`.toLowerCase()
  const text = body.toLowerCase()
  for (let index = text.indexOf(at); index >= 0; index = text.indexOf(at, index + 1)) {
    const next = text.charAt(index + at.length)
    if (!next || !/[\p{L}\p{N}_-]/u.test(next)) return true
  }
  return false
}

export type WakeBot = { id: string; name: string; ownerId: string }
export type TaskWake = { bot: WakeBot; kind: 'comment' | 'mention'; key: string; text: string | null }

/**
 * Which Bots a save of a task's document wakes (Capy's issue_activity), and why:
 * - a new comment wakes the Bot the task is assigned to, and each of the writer's Bots its text @-mentions;
 * - a Bot chip added to the description wakes that Bot.
 * `assigned` is the task's Bot delegate, `own` the writer's live Bots in the task's workspace; a mention of any other
 * Bot wakes nothing. One wake per Bot and comment; a mention counts over a plain comment for the same Bot.
 */
export function taskActivityWakes(input: {
  writerId: string
  before: { threads: readonly ThreadRecord[]; content: JSONContent | null }
  after: { threads: readonly ThreadRecord[]; content: JSONContent | null }
  /** Names the description edit, so the same added chip is not woken twice for one version. */
  version: string
  assigned: WakeBot | null
  own: readonly WakeBot[]
}): TaskWake[] {
  const wakes = new Map<string, TaskWake>()
  const add = (wake: TaskWake) => {
    const id = `${wake.bot.id}\0${wake.key}`
    if (!wakes.has(id) || wake.kind === 'mention') wakes.set(id, wake)
  }
  for (const comment of newComments(input.before.threads, input.after.threads)) {
    if (comment.authorUserId !== input.writerId) continue
    if (input.assigned) add({ bot: input.assigned, kind: 'comment', key: comment.key, text: comment.body })
    for (const bot of input.own) if (textMentions(comment.body, bot.name)) add({ bot, kind: 'mention', key: comment.key, text: comment.body })
  }
  const earlier = mentionedBotIds(input.before.content)
  const candidates = new Map([...input.own, ...input.assigned ? [input.assigned] : []].map(bot => [bot.id, bot]))
  for (const id of mentionedBotIds(input.after.content)) {
    const bot = candidates.get(id)
    if (bot && !earlier.has(id)) add({ bot, kind: 'mention', key: `description:${input.version}`, text: null })
  }
  return [...wakes.values()]
}
