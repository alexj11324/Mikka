import 'server-only'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { artifacts, agentRuns, bots, issues } from '@/lib/db/schema'
import { ActionFailureError } from '@/lib/action-error'
import { activeTaskWorkspaces, taskReaderScope } from '@/lib/task-workspace'
import { issueVisibilityPredicate } from '@/lib/issue-visibility-policy'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { enterprisePrincipal, type EnterprisePrincipal } from '@/lib/enterprise/principal'

export type ArtifactReader = string | { id: string; [tokenWorkspace]?: string; [enterprisePrincipal]?: EnterprisePrincipal }

/** Workspace membership is necessary in addition to the existing owner ACL.
 * Null legacy bindings are never assigned to a reader's current/personal tenant. */
export async function artifactReadAccess(reader: ArtifactReader) {
  const { userId } = taskReaderScope(reader)
  const workspaceIds = (await activeTaskWorkspaces(reader)).map(workspace => workspace.id)
  // Both reads belong to one list operation. Keep the complete reader at the
  // fresh membership/Enterprise gate; never retain these predicates as a cache.
  return {
    artifactPredicate: and(eq(artifacts.userId, userId), workspaceIds.length
      ? inArray(artifacts.workspaceId, workspaceIds) : sql`false`),
    taskPredicate: issueVisibilityPredicate(userId, { allowedIds: [], workspaceIds }),
  }
}

export async function artifactAccess(reader: ArtifactReader) {
  return (await artifactReadAccess(reader)).artifactPredicate
}

export async function artifactWorkspace(reader: ArtifactReader, artifactId: string) {
  const [row] = await db.select({ workspaceId: artifacts.workspaceId }).from(artifacts)
    .where(and(eq(artifacts.id, artifactId), await artifactAccess(reader))).limit(1)
  return row?.workspaceId ?? null
}

/** Only host/authenticated context is accepted. A submitted artifact body cannot
 * choose its tenant, and a run/task disagreement is rejected before object I/O. */
export async function submissionWorkspace(submitter: {
  userId: string; workspaceId?: string; runId: string | null; issueId: string | null; botId?: string | null
}): Promise<string> {
  const candidates = [submitter.workspaceId, taskReaderScope(submitter.userId).workspaceId].filter((id): id is string => !!id)
  if (submitter.issueId) {
    const [task] = await db.select({ workspaceId: issues.workspaceId, state: issues.ownershipState }).from(issues).where(eq(issues.id, submitter.issueId)).limit(1)
    if (!task?.workspaceId || task.state !== 'bound') throw new ActionFailureError('taskWorkspaceUnresolved')
    candidates.push(task.workspaceId)
  }
  if (submitter.runId) {
    const [run] = await db.select({ userId: agentRuns.userId, issueId: agentRuns.issueId, botId: agentRuns.botId,
      workspaceId: bots.workspaceId, tenant: agentRuns.workspaceId, identity: agentRuns.agentDefinition }).from(agentRuns)
      .leftJoin(bots, eq(bots.id, agentRuns.botId)).where(eq(agentRuns.id, submitter.runId)).limit(1)
    if (!run || run.userId !== submitter.userId || run.issueId !== submitter.issueId ||
      (submitter.botId && submitter.botId !== run.botId)) throw new ActionFailureError('taskWorkspaceMismatch')
    if (run.workspaceId) candidates.push(run.workspaceId)
    if (run.tenant) candidates.push(run.tenant)
    if (run.identity?.executionIdentity?.workspaceId) candidates.push(run.identity.executionIdentity.workspaceId)
  } else if (submitter.botId) {
    const [bot] = await db.select({ workspaceId: bots.workspaceId }).from(bots)
      .where(and(eq(bots.id, submitter.botId), eq(bots.ownerId, submitter.userId))).limit(1)
    if (!bot) throw new ActionFailureError('taskWorkspaceMismatch')
    candidates.push(bot.workspaceId)
  }
  const unique = [...new Set(candidates)]
  if (!unique.length) throw new ActionFailureError('taskWorkspaceUnresolved')
  if (unique.length !== 1) throw new ActionFailureError('taskWorkspaceMismatch')
  return unique[0]
}
