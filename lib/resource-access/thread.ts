import 'server-only'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db, pool } from '@/lib/db'
import { agentRuns } from '@/lib/db/schema'
import { ActionFailureError } from '@/lib/action-error'
import type { IssueReader } from '@/lib/issue-visibility'
import { activeTaskWorkspaces, taskReaderScope } from '@/lib/task-workspace'
import { readRunChain, readRunChainCheckpoint } from '@/lib/run-chain'
import type { ResourceAction } from './contract'
import { resourceAccessPredicate } from './predicate'
import { readResourceCapabilities, requireResourceAccess } from './store'

/** This predicate is request-local: a token's Workspace and Enterprise
 * authority are checked before the shared SQL ACL sees any content row. */
export async function threadReadAccess(reader: IssueReader, action: ResourceAction = 'canReadContent') {
  const { userId } = taskReaderScope(reader)
  const workspaceIds = (await activeTaskWorkspaces(reader)).map(workspace => workspace.id)
  return and(workspaceIds.length ? inArray(agentRuns.workspaceId, workspaceIds) : sql`false`,
    resourceAccessPredicate(userId, agentRuns.workspaceId, 'thread', agentRuns.id, action))
}

/** Only identity fields are read before authorization. Content permission
 * never implies the right to use the owner's machine, model or credentials. */
export async function authorizedThread(reader: IssueReader, runId: string, action: ResourceAction = 'canReadContent') {
  if (!z.uuid().safeParse(runId).success) throw new ActionFailureError('runNotFound')
  const [run] = await db.select({ id: agentRuns.id, ownerId: agentRuns.userId,
    issueId: agentRuns.issueId, workspaceId: agentRuns.workspaceId }).from(agentRuns).where(eq(agentRuns.id, runId)).limit(1)
  if (!run?.workspaceId) throw new ActionFailureError('runNotFound')
  const reference = { kind: 'thread' as const, id: run.id, workspaceId: run.workspaceId }
  await requireResourceAccess(reader, reference, action)
  return { ...run, workspaceId: run.workspaceId, reference, viewerId: taskReaderScope(reader).userId }
}

export async function authorizedThreadCapabilities(reader: IssueReader, runId: string) {
  const access = await authorizedThread(reader, runId)
  return { ...access, capabilities: await readResourceCapabilities(reader, access.reference) }
}

/** Keep the actual owner in the structural chain fence and independently
 * apply the viewer's ACL to every attempt. Hidden historical attempts never
 * contribute chunks, checkpoints, attempt counts or a live target. */
export async function readAuthorizedRunChain(reader: IssueReader, runId: string) {
  const access = await authorizedThread(reader, runId)
  return readRunChain(pool, access.ownerId, runId, access.viewerId)
}

export async function readAuthorizedRunCheckpoint(reader: IssueReader, runId: string) {
  const access = await authorizedThread(reader, runId)
  return readRunChainCheckpoint(pool, access.ownerId, runId, access.viewerId)
}
