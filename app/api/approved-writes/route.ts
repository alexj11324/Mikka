import { createPersonalWriteRoute, PERSONAL_WRITES_ENABLED } from '@/lib/operations/write-route'

export const runtime = 'nodejs'

/** Separate personal browser endpoint; deliberately not a Bot/AgentKit tool.
 * Disabled requests never initialize auth, the DB pool or provider clients. */
export const POST = createPersonalWriteRoute({
  enabled: () => PERSONAL_WRITES_ENABLED,
  load: async () => (await import('@/lib/operations/write-runtime')).personalWriteRuntime(),
})
