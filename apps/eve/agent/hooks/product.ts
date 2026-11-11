import { defineHook } from 'eve/hooks'
import { scopeFromAuth, registerSession } from '../../../../lib/eve/scope'
import { projectEveTurn, projectTurnState } from '../../../../lib/eve/projection'

export default defineHook({events:{
  async 'session.started'(_event,ctx) {
    await registerSession(scopeFromAuth(ctx.session.auth.current),ctx.session.id)
  },
  async 'turn.started'(event,ctx) {
    const scope = scopeFromAuth(ctx.session.auth.current)
    const {pool} = await import('../../../../lib/db')
    const source = ctx.session.auth.current?.attributes.sourceEventId
    const originalSource = typeof source === 'string' ? source : ctx.session.parent
      ? (await pool.query<{source_event_id:string}>('SELECT source_event_id FROM eve_turn_sources WHERE session_id=$1 AND turn_id=$2',[ctx.session.parent.sessionId,ctx.session.parent.turn.id])).rows[0]?.source_event_id : undefined
    if (originalSource) await pool.query(`INSERT INTO eve_turn_sources(session_id,turn_id,source_event_id) SELECT $1,$2,e.id FROM coordinator_events e WHERE e.id=$3 AND e."userId"=$4 AND e."botId"=$5 ON CONFLICT DO NOTHING`,[ctx.session.id,event.data.turnId,originalSource,scope.ownerId,scope.botId])
    const scheduled = typeof source === 'string' ? await (await import('../../../../lib/eve/scheduled-read')).loadScheduledRead(scope,source) : null
    if (!scheduled && !ctx.session.parent) await projectTurnState(scope,ctx.session.id,event.data.turnId,true)
  },
  async 'turn.settled'(event,ctx) {
    const scope = scopeFromAuth(ctx.session.auth.current)
    const messages = projectEveTurn(ctx.view,ctx.session.id,event.data.turnId,event.data.outcome)
    const {pool} = await import('../../../../lib/db')
    const sourceEventId = (await pool.query<{source_event_id:string}>('SELECT source_event_id FROM eve_turn_sources WHERE session_id=$1 AND turn_id=$2',[ctx.session.id,event.data.turnId])).rows[0]?.source_event_id
    // Delegated sessions share the read authority but only the original turn
    // owns the schedule occurrence and publishes the combined result.
    const scheduled = !ctx.session.parent && sourceEventId ? await (await import('../../../../lib/eve/scheduled-read')).loadScheduledRead(scope,sourceEventId) : null
    if (scheduled) {
      const {completeScheduledRead,failScheduledRead} = await import('../../../../lib/eve/scheduled-read')
      const text = messages.flatMap(message => message.role === 'assistant' ? message.content.flatMap(part => part.type === 'text' && 'text' in part ? [part.text] : []) : []).join('\n')
      if (event.data.outcome === 'completed') await completeScheduledRead(scope,scheduled,text,`eve:${ctx.session.id}:${event.data.turnId}`)
      else await failScheduledRead(scope,scheduled,new Error('scheduledReadFailed'))
    } else if (!ctx.session.parent) await projectTurnState(scope,ctx.session.id,event.data.turnId,false,messages)
    const execution = (await pool.query<{id:string}>('SELECT id FROM agent_kit_executions WHERE owner_id=$1 AND bot_key=$2 AND execution_key=$3',[scope.ownerId,scope.botId,`${ctx.session.id}:${event.data.turnId}:0`])).rows[0]
    if (execution) await (await import('../../../../workflows/coordinator/agent-kit-steps')).finishAgentExecution(scope.ownerId,scope.botId,execution.id,event.data.outcome === 'failed' ? 'turn_failed' : undefined)
  },
}})
