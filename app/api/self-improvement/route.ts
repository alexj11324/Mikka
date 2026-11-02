import { getApiSession } from '@/lib/api-auth'
import { actAs } from '@/lib/acting-user'
import { improvementStore, skillAssignments, improvementFactory, skillRegistry, skillEvaluations } from '@/lib/self-improvement/server'
import { handleImprovement } from '@/lib/self-improvement/http'
import { runOutsideToken } from '@/lib/tokens/scope'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function handle(request: Request) {
  const user = (await getApiSession({ headers: request.headers }))?.user
  const respond = () => handleImprovement(improvementStore, request, user?.id ?? null, skillAssignments, improvementFactory, skillRegistry, skillEvaluations,
    runId => user ? runOutsideToken(user, runId) : Promise.resolve(false))
  // Its task checks (issueForUser) keep a workspace token's scope inside actAs; runOutsideToken adds the run's Bot.
  return user ? actAs(user, respond) : respond()
}
export { handle as GET, handle as POST }
