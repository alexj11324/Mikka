import { createPersonalWriteRoute } from '@/lib/operations/write-route'

import { personalWritesEnabled } from '@/lib/operations/write-feature'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Public availability only. Never initializes auth, database or provider services. */
export function GET() {
  return Response.json({ enabled: personalWritesEnabled() }, { headers: { 'cache-control': 'no-store' } })
}

/** Separate personal browser endpoint; deliberately not a Bot/AgentKit tool.
 * Disabled requests never initialize auth, the DB pool or provider clients. */
export const POST = createPersonalWriteRoute({
  enabled: personalWritesEnabled,
  load: async () => (await import('@/lib/operations/write-runtime')).personalWriteRuntime(),
})
