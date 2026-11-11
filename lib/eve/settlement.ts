import 'server-only'
import { createHash } from 'node:crypto'
import type { TurnOutcome } from 'eve/events'
import { pool } from '../db'
import { taskSchema, type ScheduledRead } from '../schedules/contract'
import { assertSessionScope, type EveScope } from './scope'
import { eveStreamId, projectTurnState } from './projection'
import { completeScheduledRead, failScheduledRead, loadScheduledRead } from './scheduled-read'

export interface EveTurnSettlement {sessionId:string;turnId:string;outcome:TurnOutcome;messages?:unknown[];executionId?:string|null}
type Receipt = {request_digest:string;occurrence:ScheduledRead|null;completed_at:Date|null}
function canonical(value:unknown):unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([,item])=>item !== undefined).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)]))
  return value
}

/** Runs only on the Mikka app host, whose Workflow world owns product timers. */
export async function finishEveTurn(scope:EveScope,input:EveTurnSettlement) {
  await assertSessionScope(scope,input.sessionId)
  const lock = `eve-settlement:${input.sessionId}:${input.turnId}`
  const client = await pool.connect()
  try {
    // A product receipt may span two independently committed product effects.
    // A session advisory lock serializes retries without nesting their SQL
    // transactions or holding a lock on the original conversation's rows.
    await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[lock])
    const requestDigest = createHash('sha256').update(JSON.stringify(canonical({outcome:input.outcome,messages:input.messages ?? null}))).digest('hex')
    let receipt = (await client.query<Receipt>('SELECT * FROM eve_turn_settlements WHERE session_id=$1 AND turn_id=$2',[input.sessionId,input.turnId])).rows[0]
    if (receipt && receipt.request_digest !== requestDigest) throw new Error('operationBindingConflict')
    const execution = (await pool.query<{id:string}>('SELECT id FROM agent_kit_executions WHERE owner_id=$1 AND bot_key=$2 AND execution_key=$3',[scope.ownerId,scope.botId,`${input.sessionId}:${input.turnId}:0`])).rows[0]
    if (input.executionId && input.executionId !== execution?.id) throw new Error('agentExecutionClosed')
    if (receipt?.completed_at) return {status:'accepted'}
    const source = (await pool.query<{source_event_id:string;id:string|null;source:string|null}>(`SELECT t.source_event_id,e.id,e.payload->>'source' source FROM eve_turn_sources t
      LEFT JOIN coordinator_events e ON e.id=t.source_event_id AND e."userId"=$3 AND e."botId"=$4
      WHERE t.session_id=$1 AND t.turn_id=$2`,[input.sessionId,input.turnId,scope.ownerId,scope.botId])).rows[0]
    if (source && !source.id) throw new Error('notFound')
    if (!receipt) {
      let occurrence:ScheduledRead|null = null
      if (input.messages !== undefined && source?.source === 'schedule_due') {
        const row = (await pool.query<{id:string;lease_token:string|null;status:string;task:unknown}>(`SELECT o.id,o.lease_token,o.status,o.definition->'task' task FROM schedule_occurrences o JOIN user_schedules s ON s.id=o.schedule_id
          WHERE o.event_id=$1 AND s.owner_id=$2 AND s.bot_id=$3 AND s.workspace_id=$4`,[source.source_event_id,scope.ownerId,scope.botId,scope.workspaceId])).rows[0]
        const task = taskSchema.safeParse(row?.task)
        if (!row || row.status !== 'running' || !row.lease_token || !task.success || task.data.kind !== 'agent_read') throw new Error('scheduleReadAuthorityLost')
        occurrence = {occurrenceId:row.id,leaseToken:row.lease_token,allowedActions:task.data.allowedActions,prompt:task.data.prompt}
      }
      receipt = (await client.query<Receipt>('INSERT INTO eve_turn_settlements(session_id,turn_id,request_digest,occurrence)VALUES($1,$2,$3,$4)RETURNING *',[input.sessionId,input.turnId,requestDigest,occurrence])).rows[0]
    }
    if (input.messages !== undefined) {
      // A very fast native turn may settle before its accepting HTTP request
      // returns. Publish its owned source first so the failure/result cannot
      // precede the user's message in the product history.
      if(source&&scope.surface==='web')await (await import('./submission')).markEventAccepted(scope,source.source_event_id)
      if (receipt.occurrence && source) await settleSchedule(scope,input,source.source_event_id,receipt.occurrence)
      else {
        await projectTurnState(scope,input.sessionId,input.turnId,false,input.messages,{outcome:input.outcome,sourceEventId:source?.source_event_id})
        await (await import('./outcome-delivery')).deliverEveOutcome(scope,input)
      }
    }
    if (execution) await (await import('../../workflows/coordinator/agent-kit-steps')).finishAgentExecution(scope.ownerId,scope.botId,execution.id,input.outcome === 'failed' ? 'turn_failed' : undefined)
    await client.query('UPDATE eve_turn_settlements SET completed_at=now() WHERE session_id=$1 AND turn_id=$2',[input.sessionId,input.turnId])
    return {status:'accepted'}
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[lock]).finally(()=>client.release())
  }
}

async function settleSchedule(scope:EveScope,input:EveTurnSettlement,eventId:string,occurrence:ScheduledRead) {
  const row = (await pool.query<{status:string;lease_token:string|null;event_id:string|null;stream_id:string|null}>(`SELECT o.status,o.lease_token,o.event_id,m.message->>'mikkaStreamId' stream_id
    FROM schedule_occurrences o JOIN user_schedules s ON s.id=o.schedule_id
    LEFT JOIN coordinator_messages m ON m.id=o.operation_id AND m."userId"=s.owner_id AND m."botId"=s.bot_id
    WHERE o.id=$1 AND s.owner_id=$2 AND s.bot_id=$3 AND s.workspace_id=$4`,[occurrence.occurrenceId,scope.ownerId,scope.botId,scope.workspaceId])).rows[0]
  if (!row) throw new Error('scheduleReadAuthorityLost')
  if (row.status === 'running' && row.lease_token === occurrence.leaseToken && row.event_id === eventId) {
    if (input.outcome === 'completed') {
      const current = await loadScheduledRead(scope,eventId)
      if (!current) throw new Error('scheduleReadAuthorityLost')
      const text = (input.messages ?? []).flatMap(message => {
        if (!message || typeof message !== 'object' || !('role' in message) || message.role !== 'assistant' || !('content' in message)) return []
        if (typeof message.content === 'string') return [message.content]
        return Array.isArray(message.content) ? message.content.flatMap(part => part?.type === 'text' && typeof part.text === 'string' ? [part.text] : []) : []
      }).join('\n')
      await completeScheduledRead(scope,current,text,eveStreamId(input.sessionId,input.turnId))
    } else await failScheduledRead(scope,occurrence,new Error('scheduledReadFailed'))
  } else if (input.outcome === 'completed') {
    // The effect can have committed before the RPC response or receipt update.
    // Only this turn's fenced report proves that its completion already won.
    if (row.status !== 'succeeded' || row.stream_id !== eveStreamId(input.sessionId,input.turnId)) throw new Error('scheduleReadAuthorityLost')
  } else {
    // An old failed turn must never fail a later claim of this occurrence.
    // Re-arm even after a lost RPC response; the product timer checks due rows.
    ;(await import('../due-timer')).armDueTimerSoon('schedules')
  }
}
