import { getSession } from '@/lib/session'
import { improvementStore, skillAssignments, improvementFactory, skillRegistry, skillEvaluations } from '@/lib/self-improvement/server'
import { handleImprovement } from '@/lib/self-improvement/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function handle(request: Request) {
  return handleImprovement(improvementStore, request, (await getSession())?.user.id ?? null, skillAssignments, improvementFactory, skillRegistry, skillEvaluations)
}
export { handle as GET, handle as POST }
