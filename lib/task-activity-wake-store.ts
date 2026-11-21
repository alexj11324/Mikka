import 'server-only'
import { and, eq, isNull } from 'drizzle-orm'
import type { JSONContent } from '@tiptap/core'
import type { db } from './db'
import { bots } from './db/schema'
import { CredentialError } from './credentials/contracts'
import { issueActivityEvent } from './coordinator-events'
import { recordCoordinatorEvent } from './coordinator-event-store'
import { readIssueMetadata } from './issue-metadata'
import type { ThreadRecord } from './task-discussion'
import { mentionedBotIds, newComments, taskActivityWakes, type WakeBot } from './task-activity-wake'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Wake the Bots a save of a task's document concerns (lib/task-activity-wake.ts), in the save's own transaction so a
 * wake commits with the comment or mention that caused it. A save that adds no comment and no Bot chip reads nothing.
 */
export async function recordTaskActivityWakes(tx: Transaction, input: {
  task: { id: string; workspaceId: string | null; title: string; identifier: string | null }
  writer: { id: string; name: string | null }
  before: { threads: readonly ThreadRecord[]; content: JSONContent | null }
  after: { threads: readonly ThreadRecord[]; content: JSONContent | null }
  version: string
}) {
  const { task, writer } = input
  if (!task.workspaceId) return
  const commented = newComments(input.before.threads, input.after.threads).some(comment => comment.authorUserId === writer.id)
  const earlier = mentionedBotIds(input.before.content)
  const chipAdded = [...mentionedBotIds(input.after.content)].some(id => !earlier.has(id))
  if (!commented && !chipAdded) return
  const live = and(eq(bots.workspaceId, task.workspaceId), isNull(bots.archivedAt))
  const delegate = readIssueMetadata(input.after.content ?? input.before.content ?? { type: 'doc' }).delegate
  const [assigned] = delegate?.kind === 'bot'
    ? await tx.select({ id: bots.id, name: bots.name, ownerId: bots.ownerId }).from(bots).where(and(eq(bots.id, delegate.id), live)).limit(1) : []
  const own = await tx.select({ id: bots.id, name: bots.name, ownerId: bots.ownerId }).from(bots).where(and(eq(bots.ownerId, writer.id), live))
  const owned = (bot: { id: string; name: string; ownerId: string | null }): bot is WakeBot => bot.ownerId !== null
  const wakes = taskActivityWakes({ writerId: writer.id, before: input.before, after: input.after, version: input.version,
    assigned: assigned && owned(assigned) ? assigned : null, own: own.filter(owned) })
  for (const wake of wakes) {
    const event = (text: string | null) => issueActivityEvent(task, wake.bot, { kind: wake.kind, key: wake.key, actorId: writer.id, actorName: writer.name?.trim() || 'A teammate', text })
    try {
      await recordCoordinatorEvent(tx, event(wake.text))
    } catch (error) {
      // A comment carrying one of the Bot owner's saved secrets still wakes the Bot, without its text.
      if (!(error instanceof CredentialError) || error.code !== 'credential_secret_detected' || !wake.text) throw error
      await recordCoordinatorEvent(tx, event(null))
    }
  }
}
