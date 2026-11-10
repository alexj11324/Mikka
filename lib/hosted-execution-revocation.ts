import 'server-only'
import type { Pool, PoolClient } from 'pg'
import { coordinatorStopToken } from './coordinator/stop'
import { wakeWorkflowAfterCommit } from './workflow-wake'
import { GROUP_TURN_STOP_CHANNEL, notifyChannel } from './db/listen'
import { groupChatChanged } from './live/groups'
import { runChanged } from './live/panels'
import { runListChanged } from './live/lists'

type Query = Pick<Pool | PoolClient, 'query'>
export type HostedRevocationScope = {
  workspaceId?: string
  /** Match an execution owner, actor, or personal credential owner; never an Org connection's creator. */
  ownerId?: string
  subscriptionOwnerId?: string
  connectionId?: string
  apiKeyId?: string
  borrowedOnly?: boolean
  credentialKind?: 'subscription' | 'api_key'
  /** Personal API-key share withdrawal leaves the key owner's own calls and Org connections intact. */
  othersOnly?: boolean
}
export type HostedRevocationResult = { holders: string[]; executionIds: string[]; groupTurnIds: string[] }

/** Metadata-only selector. Historical deployments without a hosted execution
 * table cannot have its active executions; all present tables remain fenced. */
export async function hostedExecutionsForRevocation(query: Query, scope: HostedRevocationScope) {
  if (!scope.workspaceId && !scope.ownerId && !scope.subscriptionOwnerId && !scope.connectionId && !scope.apiKeyId && !scope.borrowedOnly) throw Error('hosted_revocation_scope_required')
  const { rows: [tables] } = await query.query<{ coordinators: boolean; groups: boolean }>(`SELECT
    to_regclass('coordinator_sessions') IS NOT NULL AND to_regclass('agent_kit_executions') IS NOT NULL AS coordinators,
    to_regclass('group_turns') IS NOT NULL AS groups`)
  const args = [scope.workspaceId ?? null, scope.ownerId ?? null, scope.subscriptionOwnerId ?? null,
    scope.connectionId ?? null, scope.apiKeyId ?? null, scope.borrowedOnly ?? false, scope.credentialKind ?? null, scope.othersOnly ?? false]
  const sessions = tables?.coordinators ? (await query.query<{ holder: string; executionId: string | null; workspaceId: string | null }>(`WITH active AS (
    SELECT s."leaseHolder" AS holder,e.id AS "executionId",s."userId" AS owner,
      COALESCE(e.snapshot#>>'{runtime,actorId}',s."userId") AS actor,
      COALESCE(e.snapshot#>>'{runtime,modelSelection,workspaceId}',b."workspaceId"::text,c."workspaceId"::text) AS "workspaceId",
      COALESCE(e.snapshot#>>'{runtime,modelSelection,credentialOwnerId}',fk."ownerId",k."ownerId") AS credential_owner,
      CASE WHEN e.id IS NOT NULL THEN COALESCE(to_jsonb(fk)->>'ownership','personal') ELSE COALESCE(to_jsonb(k)->>'ownership','personal') END AS credential_ownership,
      CASE WHEN e.id IS NOT NULL THEN e.snapshot#>'{runtime,modelSelection}' WHEN sb.id IS NOT NULL THEN
        jsonb_build_object('type','subscription','ownerId',sb."ownerId",'connectionId',sb."connectionId")
        WHEN c."apiKeyId" IS NOT NULL THEN jsonb_build_object('type','api_key','ownerId',s."userId",'keyId',c."apiKeyId",'credentialOwnerId',k."ownerId") END AS selection
    FROM coordinator_sessions s LEFT JOIN bots b ON b.id=s."botId"
    LEFT JOIN LATERAL (SELECT id,snapshot FROM agent_kit_executions e
      WHERE e.owner_id=s."userId" AND e.bot_key=COALESCE(s."botId"::text,'coordinator') AND e.status='running'
        AND left(e.execution_key,length(s."leaseHolder")+1)=s."leaseHolder"||':' ORDER BY e.started_at DESC LIMIT 1) e ON true
    LEFT JOIN bot_model_choices c ON c."ownerId"=s."userId" AND c."botKey"=COALESCE(s."botId"::text,'coordinator')
      AND (b."workspaceId" IS NULL OR c."workspaceId"=b."workspaceId")
    LEFT JOIN byos_bindings sb ON sb.id=c."bindingId" LEFT JOIN model_api_keys k ON k.id=c."apiKeyId"
    LEFT JOIN model_api_keys fk ON fk.id::text=e.snapshot#>>'{runtime,modelSelection,keyId}'
    WHERE s."leaseHolder" IS NOT NULL AND s."leaseUntil">clock_timestamp()
  ) SELECT DISTINCT holder,"executionId","workspaceId" FROM active
    WHERE ($1::text IS NULL OR "workspaceId"=$1)
      AND ($2::text IS NULL OR owner=$2 OR actor=$2 OR selection->>'ownerId'=$2 OR credential_owner=$2)
      AND ($3::text IS NULL OR selection->>'type'='subscription' AND selection->>'ownerId'=$3)
      AND ($4::text IS NULL OR selection->>'type'='subscription' AND selection->>'connectionId'=$4)
      AND ($5::text IS NULL OR selection->>'type'='api_key' AND selection->>'keyId'=$5)
      AND (NOT $6::boolean OR selection->>'type'='subscription' AND (selection->>'ownerId'<>owner OR actor<>owner OR selection->>'runOwnerId' IS NOT NULL))
      AND ($7::text IS NULL OR selection->>'type'=$7)
      AND (NOT $8::boolean OR selection->>'type'='api_key' AND credential_ownership='personal' AND credential_owner<>owner)`, args)).rows : []
  const groups = tables?.groups ? (await query.query<{ messageId: string; conversationId: string; activeRunId: string | null; workspaceId: string }>(`SELECT DISTINCT t."messageId",t."conversationId",t."activeRunId",c."workspaceId"::text AS "workspaceId"
    FROM group_turns t JOIN conversations c ON c.id=t."conversationId"
    LEFT JOIN LATERAL jsonb_each(COALESCE(t."modelSelections",'{}'::jsonb)) frozen ON true
    LEFT JOIN model_api_keys fk ON fk.id::text=frozen.value#>>'{modelSelection,keyId}'
    WHERE (t.status IN ('queued','running') OR t.error='group_judgment_pending')
      AND ($1::text IS NULL OR c."workspaceId"::text=$1)
      AND ($2::text IS NULL OR t."userId"=$2 OR frozen.value->>'actorId'=$2 OR frozen.value#>>'{modelSelection,ownerId}'=$2 OR frozen.value#>>'{modelSelection,credentialOwnerId}'=$2 OR fk."ownerId"=$2)
      AND ($3::text IS NULL OR frozen.value#>>'{modelSelection,type}'='subscription' AND frozen.value#>>'{modelSelection,ownerId}'=$3)
      AND ($4::text IS NULL OR frozen.value#>>'{modelSelection,type}'='subscription' AND frozen.value#>>'{modelSelection,connectionId}'=$4)
      AND ($5::text IS NULL OR frozen.value#>>'{modelSelection,type}'='api_key' AND frozen.value#>>'{modelSelection,keyId}'=$5)
      AND (NOT $6::boolean OR frozen.value#>>'{modelSelection,type}'='subscription' AND
        (frozen.value#>>'{modelSelection,ownerId}'<>t."userId" OR frozen.value->>'actorId'<>t."userId" OR frozen.value#>>'{modelSelection,runOwnerId}' IS NOT NULL))
      AND ($7::text IS NULL OR frozen.value#>>'{modelSelection,type}'=$7)
      AND (NOT $8::boolean OR frozen.value#>>'{modelSelection,type}'='api_key' AND COALESCE(to_jsonb(fk)->>'ownership','personal')='personal'
        AND COALESCE(frozen.value#>>'{modelSelection,credentialOwnerId}',fk."ownerId")<>t."userId")`, args)).rows : []
  return { sessions, groups }
}

/** Use inside the credential/lifecycle APP transaction. This stops the existing
 * workflow hook and group LISTEN consumers after COMMIT; rollback wakes nothing.
 * No timer, model call, prompt, or credential material is read or introduced. */
export async function stopHostedExecutions(query: Query, scope: HostedRevocationScope): Promise<HostedRevocationResult> {
  const { sessions, groups } = await hostedExecutionsForRevocation(query, scope)
  const holders = [...new Set(sessions.map(row => row.holder))]
  const executionIds = [...new Set(sessions.flatMap(row => row.executionId ? [row.executionId] : []))]
  if (executionIds.length) await query.query(`UPDATE agent_kit_executions SET status='failed',finished_at=clock_timestamp() WHERE id=ANY($1::uuid[]) AND status='running'`, [executionIds])
  const groupTurnIds = groups.map(row => row.messageId)
  if (groupTurnIds.length) {
    await query.query(`UPDATE group_turns SET status='failed',error='stopped',"agentId"=NULL,"botId"=NULL,
      trace=trace || jsonb_build_object('status','stopped','finishedAt',clock_timestamp()),"updatedAt"=clock_timestamp()
      WHERE "messageId"=ANY($1::uuid[]) AND (status IN ('queued','running') OR error='group_judgment_pending')`, [groupTurnIds])
    await notifyChannel(query, GROUP_TURN_STOP_CHANNEL, groupTurnIds)
    for (const id of new Set(groups.map(row => row.conversationId))) await groupChatChanged(query, id)
    const runIds = groups.flatMap(row => row.activeRunId ? [row.activeRunId] : [])
    if (runIds.length) {
      const stopped = await query.query<{ id: string }>(`UPDATE agent_runs SET status='stopped',"finishedAt"=clock_timestamp(),"leaseExpiresAt"=NULL,"updatedAt"=clock_timestamp()
        WHERE id=ANY($1::uuid[]) AND kind='group_chat' AND status='running' RETURNING id`, [runIds])
      for (const row of stopped.rows) { await runListChanged(query, row.id); await runChanged(query, row.id) }
    }
  }
  for (const holder of holders) wakeWorkflowAfterCommit(query, coordinatorStopToken(holder))
  return { holders, executionIds, groupTurnIds }
}
