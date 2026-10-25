import { intentDigest } from '../operations/action-intents'
import type { PoolClient } from 'pg'
import type { ModelSource } from '../resources/runtime'
import { ScheduleError } from './contract'
export const scheduleOutcomeDigest=intentDigest
export type ScheduledModelSource=Extract<ModelSource,{kind:'schedule'}>
/** Uses the caller's canonical quota/app transaction. Workspace membership and
 * policy locks are held by the public resource adapter, not a nested pool. */
export async function fenceScheduledModel(tx:PoolClient,source:ScheduledModelSource,deadline:Date){
  const schedule=(await tx.query('SELECT * FROM user_schedules WHERE id=$1 FOR SHARE',[source.scheduleId])).rows[0]
  const occurrence=(await tx.query('SELECT * FROM schedule_occurrences WHERE id=$1 FOR SHARE',[source.occurrenceId])).rows[0]
  if(!schedule||!occurrence||schedule.owner_id!==source.ownerId||schedule.workspace_id!==source.workspaceId||schedule.version!==source.version||['cancelled','paused'].includes(schedule.status)||occurrence.schedule_id!==schedule.id||occurrence.operation_id!==source.operationId||occurrence.version!==source.version||occurrence.status!=='running'||occurrence.lease_token!==source.leaseToken||!occurrence.lease_until||occurrence.lease_until<=deadline||occurrence.execution_decision!=='execute'||occurrence.generation_checkpoint||occurrence.generation_state!=='sending'||occurrence.generation_context?.leaseDigest!==scheduleOutcomeDigest(source.leaseToken))throw new ScheduleError('scheduleModelLeaseLost',403)
  if(!(await tx.query('SELECT id FROM "user" WHERE id=$1 FOR SHARE',[source.ownerId])).rowCount)throw new ScheduleError('scheduleOwnerUnavailable',403)
  if(schedule.conversation==='bot'&&!(await tx.query('SELECT id FROM agent_sessions WHERE id::text=$1 AND "userId"=$2 FOR SHARE',[schedule.session_id,source.ownerId])).rowCount)throw new ScheduleError('scheduleConversationUnavailable',403)
}
