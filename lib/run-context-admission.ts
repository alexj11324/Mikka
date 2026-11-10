import 'server-only'
import type { PoolClient } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { ActionFailureError } from './action-error'
import { lockResourcesAccess } from './resource-access/store'
import { resourcePersonalResourcesAllowed } from './run-private-resources'

/** Queue owners hold the complete ACL chain through the Run INSERT. A
 * concurrent share cannot approve private context and then expose that new
 * snapshot before it has an ACL of its own. This reuses the canonical locks. */
export async function lockRunContextAdmission(query: PoolClient, input: {
  ownerId: string; workspaceId: string; issueId: string; sourceRunId?: string;
}): Promise<boolean> {
  const { ownerId, workspaceId, issueId, sourceRunId } = input
  await lockResourcesAccess(drizzle(query), ownerId, [
    { reference: { kind: 'task', id: issueId, workspaceId }, action: 'canSteer' },
    ...(sourceRunId ? [{ reference: { kind: 'thread' as const, id: sourceRunId, workspaceId }, action: 'canSteer' as const }] : []),
  ], false, false)
  if (sourceRunId) {
    const { rows: [source] } = await query.query('SELECT 1 FROM agent_runs WHERE id=$1 AND "userId"=$2 AND "workspaceId"=$3 AND "issueId"=$4 FOR SHARE',
      [sourceRunId, ownerId, workspaceId, issueId])
    if (!source) throw new ActionFailureError('runInvalid', { reason: 'sourceRunMismatch' })
  }
  return resourcePersonalResourcesAllowed(query, sourceRunId ? 'thread' : 'task', sourceRunId ?? issueId, ownerId)
}
