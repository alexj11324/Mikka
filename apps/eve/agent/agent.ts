import { defineAgent, defineDynamic } from 'eve'

export default defineAgent({
  model: defineDynamic(async ctx => {
    const { modelForSession } = await import('../../../lib/eve/runtime')
    return { model: await modelForSession(ctx), modelContextWindowTokens: 128_000 }
  }),
  limits: { sessionTimeoutMs: false },
  experimental: { workflow: { retention: 'default' } },
})
