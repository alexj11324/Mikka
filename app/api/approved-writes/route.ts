import { createPersonalWriteRoute } from '@/lib/operations/write-route'

import { personalWritesEnabled } from '@/lib/operations/write-feature'

export const runtime = 'nodejs'

/** Separate personal browser endpoint; deliberately not a Bot/AgentKit tool.
 * Disabled requests never initialize auth, the DB pool or provider clients. */
export const POST = createPersonalWriteRoute({
  enabled: personalWritesEnabled,
  load: async () => (await import('@/lib/operations/write-runtime')).personalWriteRuntime(),
})
