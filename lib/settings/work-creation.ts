import 'server-only'
import { workVisibilitySchema, type WorkCreationView, type WorkVisibility } from '@mikka/protocol/work-visibility'
import { ActionFailureError } from '@/lib/action-error'
import { captureDatabaseQuery } from '@/lib/db/commit-effects'
import { requireTaskWorkspaceLease } from '@/lib/task-workspace'
import { readRuntimeSettings } from './runtime'
import { workCreationView } from './work-creation-policy'

type Executor = Parameters<typeof captureDatabaseQuery>[0]
export interface WorkCreationActor { userId: string; workspaceId: string }

/** Call with the creating transaction, while its canonical WS membership
 * lease is held. Settings writers lock that same Workspace before APP writes,
 * so a policy change cannot pass a half-finished creation or ACL transition. */
export async function readWorkCreationPolicy(executor: Executor, actor: WorkCreationActor): Promise<WorkCreationView> {
  const workspace = requireTaskWorkspaceLease(actor.userId, actor.workspaceId)
  const { newWorkVisibility, allowPrivateNewWork } = await readRuntimeSettings(executor, ['newWorkVisibility', 'allowPrivateNewWork'], actor)
  return workCreationView(workspace.kind, newWorkVisibility, allowPrivateNewWork.value)
}

/** An explicit choice must fit policy; an omitted choice uses the separately
 * reported effective default, never a configured value that would be refused. */
export function workCreationVisibility(policy: WorkCreationView, explicit?: WorkVisibility): WorkVisibility {
  const visibility = explicit === undefined ? policy.effectiveVisibility : workVisibilitySchema.parse(explicit)
  if (visibility === 'private' && !policy.privateAllowed) throw new ActionFailureError('privateWorkNotAllowed')
  if (visibility === 'shared' && policy.reason === 'personal_workspace') throw new ActionFailureError('sharedWorkNotAllowed')
  return visibility
}

/** The existing insert trigger owns ACL registration. Only its fresh ordinary
 * Bot/root-thread row may receive the creation default, in that same commit.
 * Ancestors and explicit grants are never replaced or broadened. */
export async function initializeWorkVisibility(executor: Executor, actor: WorkCreationActor,
  resource: { kind: 'bot' | 'thread'; id: string; visibility?: WorkVisibility }) {
  const visibility = workCreationVisibility(await readWorkCreationPolicy(executor, actor), resource.visibility)
  const { query } = captureDatabaseQuery(executor)
  const { rows: [fresh] } = await query<{ visibility: WorkVisibility }>(`SELECT p.visibility FROM resource_access_policies p
    WHERE p.kind=$1 AND p.id=$2 AND p."ownerId"=$3 AND p."workspaceId"=$4
      AND p.provenance='created' AND p.revision=1 AND p."createdAt"=transaction_timestamp()
      AND p.visibility IN ('private','shared') AND p."parentKind" IS DISTINCT FROM 'thread'
      AND (($1='bot' AND EXISTS (SELECT 1 FROM bots b WHERE b.id=p.id AND b."ownerId"=$3 AND b."workspaceId"=$4
        AND NOT EXISTS (SELECT 1 FROM coordinator_bots c WHERE c."botId"=b.id)))
        OR ($1='thread' AND EXISTS (SELECT 1 FROM agent_runs r WHERE r.id=p.id AND r."userId"=$3 AND r."workspaceId"=$4
          AND r.kind='implement' AND r."retryOf" IS NULL AND r."continuesRunId" IS NULL)))
    FOR UPDATE OF p`, [resource.kind, resource.id, actor.userId, actor.workspaceId])
  if (!fresh) throw new ActionFailureError('workspaceAccessDenied')
  if (fresh.visibility !== visibility) {
    await query("SELECT set_config('mikka.acl_actor',$1,true),set_config('mikka.acl_source','work_created',true)", [actor.userId])
    await query('UPDATE resource_access_policies SET visibility=$3 WHERE kind=$1 AND id=$2', [resource.kind, resource.id, visibility])
  }
  return visibility
}

/** Turning sharing off must not bypass a policy that refused private creation.
 * Already-private content keeps its existing ACL and grants unchanged. */
export async function assertWorkVisibilityChange(executor: Executor, actor: WorkCreationActor,
  kind: string, previous: string, next: string) {
  if ((kind === 'bot' || kind === 'thread') && previous === 'shared' && next === 'private')
    workCreationVisibility(await readWorkCreationPolicy(executor, actor), 'private')
}
