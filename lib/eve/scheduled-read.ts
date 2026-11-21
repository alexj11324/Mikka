import 'server-only'
import { pool } from '../db'
import { ScheduleError, taskSchema, type ScheduledRead } from '../schedules/contract'
import { schedules, failScheduledRead as failOccurrence } from '../schedules/runtime'

export type ScheduledReadScope = { ownerId: string; botId: string; workspaceId: string }

/** Resolve authority from the persisted product event, never from model/client payload. */
export async function loadScheduledRead(scope: ScheduledReadScope, sourceEventId: string): Promise<ScheduledRead | null> {
  const { rows: [row] } = await pool.query<{
    source: string | null; id: string | null; lease_token: string | null;
    lease_until: Date | null; status: string | null; task: unknown;
  }>(`SELECT e.payload->>'source' source,o.id,o.lease_token,o.lease_until,o.status,o.definition->'task' task
    FROM coordinator_events e
    JOIN bots b ON b.id=e."botId" AND b."ownerId"=e."userId" AND b."workspaceId"=$4
    LEFT JOIN schedule_occurrences o ON o.event_id=e.id
    LEFT JOIN user_schedules s ON s.id=o.schedule_id
    WHERE e.id=$1 AND e."userId"=$2 AND e."botId"=$3
      AND (o.id IS NULL OR (s.owner_id=$2 AND s.bot_id=$3 AND s.workspace_id=$4))`,
  [sourceEventId, scope.ownerId, scope.botId, scope.workspaceId])
  if (!row) throw new ScheduleError('scheduleReadAuthorityLost', 403)
  if (row.source !== 'schedule_due') return null
  const task = taskSchema.safeParse(row.task)
  if (!row.id || !row.lease_token || row.status !== 'running' || !row.lease_until || row.lease_until <= new Date()
    || !task.success || task.data.kind !== 'agent_read') throw new ScheduleError('scheduleReadAuthorityLost', 403)
  const occurrence: ScheduledRead = { occurrenceId: row.id, leaseToken: row.lease_token, allowedActions: task.data.allowedActions, prompt: task.data.prompt }
  await schedules().assertRead(scope.ownerId, scope.botId, occurrence)
  return occurrence
}

/** Keep original-chat publication and its fenced product receipt outside the Agent loop. */
export async function completeScheduledRead(scope: ScheduledReadScope, occurrence: ScheduledRead, text: string, streamId?: string) {
  await assertOccurrenceScope(scope, occurrence)
  await schedules().completeRead(scope.ownerId, scope.botId, occurrence, text, streamId)
}

/** Cleanup can settle this owner's old lease after membership loss; it grants no tool access. */
export async function failScheduledRead(scope: ScheduledReadScope, occurrence: ScheduledRead, error: unknown) {
  await assertOccurrenceScope(scope, occurrence)
  await failOccurrence({ id: occurrence.occurrenceId, lease_token: occurrence.leaseToken }, error)
}

async function assertOccurrenceScope(scope: ScheduledReadScope, occurrence: ScheduledRead) {
  const { rowCount } = await pool.query(`SELECT 1 FROM schedule_occurrences o JOIN user_schedules s ON s.id=o.schedule_id
    WHERE o.id=$1 AND o.lease_token=$2 AND s.owner_id=$3 AND s.bot_id=$4 AND s.workspace_id=$5`,
  [occurrence.occurrenceId, occurrence.leaseToken, scope.ownerId, scope.botId, scope.workspaceId])
  if (!rowCount) throw new ScheduleError('scheduleReadAuthorityLost', 403)
}
