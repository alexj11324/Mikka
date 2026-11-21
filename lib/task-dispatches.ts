import 'server-only'
import { and, desc, eq, exists, inArray, sql } from 'drizzle-orm'
import { db } from './db'
import { agentRuns, agents, bots, issues } from './db/schema'

/** A Task is dispatched only by the reader's Bot in its actual workspace.
 * A later Run by another Bot never erases the original relationship. */
function authorizedBot(userId: string, workspaceId: string) {
  return and(eq(agentRuns.botId, bots.id), eq(agentRuns.userId, userId), eq(agentRuns.workspaceId, workspaceId),
    eq(bots.ownerId, userId), eq(bots.workspaceId, workspaceId), sql`${agentRuns.source} is distinct from 'mcp'`)
}

export function dispatchedByBot(userId: string, workspaceId: string, botId: string) {
  return exists(db.select({ id: agentRuns.id }).from(agentRuns).innerJoin(bots, authorizedBot(userId, workspaceId))
    .where(and(eq(agentRuns.issueId, issues.id), eq(bots.id, botId))))
}

/** One actual Run per visible (Task, Bot), including historical dispatches
 * beyond the live thread window. No prompt, report or reply is selected. */
export function readTaskDispatches(userId: string, workspaceId: string, visible: string[]) {
  return db.selectDistinctOn([agentRuns.issueId, bots.id], {
    issueId: agentRuns.issueId, botId: bots.id, runId: agentRuns.id, name: bots.name,
    harness: sql<string | null>`coalesce(${agentRuns.agentDefinition}->>'harness', ${agents.harness})`,
  }).from(agentRuns).innerJoin(bots, authorizedBot(userId, workspaceId))
    .leftJoin(agents, and(eq(agents.id, agentRuns.agentId), eq(agents.userId, userId)))
    .where(inArray(agentRuns.issueId, visible))
    .orderBy(agentRuns.issueId, bots.id, desc(agentRuns.createdAt), desc(agentRuns.id))
}
