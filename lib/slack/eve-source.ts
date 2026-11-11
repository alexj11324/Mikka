import { createHash, randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { SlackMessage } from 'eve/channels/slack'
import type { SlackScope } from './eve-ambient'

/** Product source-request provenance for Factory tools. This is not a second
 * conversation: the event is already delivered and never wakes the web Bot. */
export async function recordSlackSource(scope: SlackScope, message: SlackMessage): Promise<string> {
  const [{ db }, { coordinatorEvents }, { assertCredentialSafeChat }] = await Promise.all([
    import('../db'), import('../db/schema'), import('../credentials/chat-guard'),
  ])
  const dedupeKey = 'slack-request:' + createHash('sha256').update(JSON.stringify([
    scope.ownerId, scope.workspaceId, scope.botId, message.teamId, message.channelId, message.ts, message.author?.userId,
  ])).digest('hex')
  const payload = { text: message.text.slice(0, 10_000), source: 'slack', slack: { teamId: message.teamId,
    channelId: message.channelId, threadTs: message.threadTs, ts: message.ts, userId: message.author?.userId } }
  await assertCredentialSafeChat(scope.ownerId, payload)
  const [inserted] = await db.insert(coordinatorEvents).values({ id: randomUUID(), userId: scope.ownerId,
    botId: scope.botId, kind: 'user_message', dedupeKey, issueId: null, runId: null, payload,
    deliveredAt: new Date(),
  }).onConflictDoNothing({ target: coordinatorEvents.dedupeKey }).returning({ id: coordinatorEvents.id })
  if (inserted) return inserted.id
  const [prior] = await db.select({ id: coordinatorEvents.id }).from(coordinatorEvents).where(and(
    eq(coordinatorEvents.dedupeKey, dedupeKey), eq(coordinatorEvents.userId, scope.ownerId), eq(coordinatorEvents.botId, scope.botId),
  )).limit(1)
  if (!prior) throw new Error('slackSourceUnavailable')
  return prior.id
}
