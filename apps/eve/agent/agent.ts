import { defineAgent, defineDynamic } from 'eve'

export default defineAgent({
  async approval(ctx) {
    const {evaluationBindingId}=await import('../../../lib/eve/evaluation-context')
    const id=evaluationBindingId(ctx.session.auth.current)
    if(!id)return undefined
    const [{pool},{loadEvaluationBinding},{scopeFromAuth}]=await Promise.all([import('../../../lib/db'),import('../../../lib/eve/evaluation-store'),import('../../../lib/eve/scope')])
    const binding=await loadEvaluationBinding(pool,scopeFromAuth(ctx.session.auth.current),id)
    return binding?.session_id===ctx.session.id&&binding.plan.tools.some(tool=>tool.name===ctx.toolName)?'not-applicable':'denied'
  },
  // Only the scoped product catalogue and explicit native capabilities. In
  // particular a scheduled read must not inherit shell/web write bypasses.
  defaultTools: false,
  model: defineDynamic(async ctx => {
    const { modelForSession } = await import('../../../lib/eve/runtime')
    return { model: await modelForSession(ctx), modelContextWindowTokens: 128_000 }
  }),
  limits: { sessionTimeoutMs: false },
  experimental: { workflow: {
    retention: 'default',
    ...(process.env.WORKFLOW_TARGET_WORLD ? { world: process.env.WORKFLOW_TARGET_WORLD } : {}),
  } },
})
