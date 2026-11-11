import 'server-only'
import { sql } from 'drizzle-orm'
import type { db } from '@/lib/db'
import { ActionFailureError } from '@/lib/action-error'
import { requireTaskWorkspaceLease } from '@/lib/task-workspace'

type Executor = Pick<Parameters<Parameters<typeof db.transaction>[0]>[0], 'execute'>

/** New root Tasks only, immediately after INSERT in the same APP transaction.
 * Raw writes remain private. The active WS lease, never a legacy scope label,
 * authorizes the Team default; existing private copies/parents are untouched. */
export async function registerTaskResourceAccess(tx: Executor, input: {
  id: string; workspaceId: string; ownerId: string; workspaceKind: 'personal' | 'team'
}) {
  const workspace = requireTaskWorkspaceLease(input.ownerId, input.workspaceId)
  if (workspace.kind !== input.workspaceKind) throw new ActionFailureError('workspaceAccessDenied')
  if (workspace.kind === 'personal') return
  const result = await tx.execute(sql`update resource_access_policies p set visibility='shared'
    where p.kind='task' and p.id=${input.id}::uuid and p."workspaceId"=${workspace.id}::uuid
      and p."ownerId"=${input.ownerId} and p.visibility='private' and p.provenance='created'
      and p."parentId" is null and p.revision=1 and p."createdAt"=transaction_timestamp()
      and exists(select 1 from issues i where i.id=p.id and i."workspaceId"=p."workspaceId"
        and i."userId"=p."ownerId" and i."ownershipState"='bound') returning p.id`)
  if (!result.rowCount) throw new ActionFailureError('workspaceAccessDenied')
}
