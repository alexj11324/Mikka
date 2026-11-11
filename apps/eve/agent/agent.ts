import { defineAgent, defineDynamic } from 'eve'

export default defineAgent({
  // Only the scoped product catalogue and explicit native capabilities. In
  // particular a scheduled read must not inherit shell/web write bypasses.
  defaultTools: false,
  model: defineDynamic(async ctx => {
    const { modelForSession } = await import('../../../lib/eve/runtime')
    return { model: await modelForSession(ctx), modelContextWindowTokens: 128_000 }
  }),
  limits: { sessionTimeoutMs: false },
  experimental: { workflow: { retention: 'default' } },
})
