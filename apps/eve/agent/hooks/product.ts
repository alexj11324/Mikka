import {evaluationBindingId} from '../../../../lib/eve/evaluation-context'
import { defineHook } from 'eve/hooks'
import { scopeFromAuth, registerSession } from '../../../../lib/eve/scope'
import { projectEveTurn, projectTurnState } from '../../../../lib/eve/projection'
import { productRpc } from '../../../../lib/eve/product-rpc'
import { turnModel, turnPolicy, turnRequest } from '../../../../lib/eve/runtime'

export default defineHook({events:{
  async 'session.started'(_event,ctx) {
    if(evaluationBindingId(ctx.session.auth.current))return
    await registerSession(scopeFromAuth(ctx.session.auth.current),ctx.session.id)
  },
  async 'turn.started'(event,ctx) {
    if(evaluationBindingId(ctx.session.auth.current))return
    const scope = scopeFromAuth(ctx.session.auth.current)
    const {pool} = await import('../../../../lib/db')
    const source = ctx.session.auth.current?.attributes.sourceEventId
    const originalSource = typeof source === 'string' ? source : ctx.session.parent
      ? (await pool.query<{source_event_id:string}>('SELECT source_event_id FROM eve_turn_sources WHERE session_id=$1 AND turn_id=$2',[ctx.session.parent.sessionId,ctx.session.parent.turn.id])).rows[0]?.source_event_id : undefined
    if (originalSource) await pool.query(`INSERT INTO eve_turn_sources(session_id,turn_id,source_event_id) SELECT $1,$2,e.id FROM coordinator_events e WHERE e.id=$3 AND e."userId"=$4 AND e."botId"=$5 ON CONFLICT DO NOTHING`,[ctx.session.id,event.data.turnId,originalSource,scope.ownerId,scope.botId])
    const scheduled = originalSource ? await (await import('../../../../lib/eve/scheduled-read')).loadScheduledRead(scope,originalSource) : null
    turnRequest.update(() => ({ sourceEventId: originalSource, scheduledRead: scheduled }))
    const { asProductPrincipal } = await import('../../../../lib/eve/product-definitions')
    await asProductPrincipal(scope, async () => {
      const [{ botRuntime }, { agentKitEnabled, agentKitStore, agentKitDefaults }] = await Promise.all([
        import('../../../../workflows/coordinator/agent-kit-steps'), import('../../../../lib/agent-kit/service'),
      ])
      const [runtime, policy] = await Promise.all([
        botRuntime(scope.ownerId, scope.botId),
        agentKitEnabled() ? (async () => {
          const { personalPlugins } = await import('../../../../lib/plugins/runtime')
          const [current, plugins] = await Promise.all([
            agentKitStore.active(scope, agentKitDefaults()), personalPlugins.snapshot(scope.ownerId, undefined, scope.workspaceId),
          ])
          const effectiveTools = new Set<string>(current.effectiveTools)
          if (plugins.servers.length) { effectiveTools.add('list_personal_mcp_tools'); effectiveTools.add('call_personal_mcp_tool') }
          if (plugins.toolkits?.includes('googledrive')) effectiveTools.add('list_drive_files')
          return { definition: current.definition, effectiveTools: [...effectiveTools], personalPlugins: plugins }
        })() : null,
      ])
      turnModel.update(() => runtime)
      turnPolicy.update(() => policy)
    })
    if (!scheduled && !ctx.session.parent) await projectTurnState(scope,ctx.session.id,event.data.turnId,true)
  },
  async 'turn.settled'(event,ctx) {
    if(evaluationBindingId(ctx.session.auth.current))return
    const scope = scopeFromAuth(ctx.session.auth.current)
    // Product retry timers and task workflows belong to the Mikka app host.
    // Children retain their read authority but never publish or settle the
    // root occurrence; only root requests carry compatibility messages.
    await productRpc(scope,{
      operation:'finish',sessionId:ctx.session.id,turnId:event.data.turnId,outcome:event.data.outcome,
      ...ctx.session.parent ? {} : {messages:projectEveTurn(ctx.view,ctx.session.id,event.data.turnId,event.data.outcome)},
    })
  },
}})
