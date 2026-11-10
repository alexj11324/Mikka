import 'server-only'
import { auth } from '@/lib/api-auth'
import { pool } from '@/lib/db'
import { taskReaderScope } from '@/lib/task-workspace'
import { AgentProfileStore } from './agent-profile-store'
import { readAgentProfileManagement } from './agent-profile'
import { createAgentProfileHandler } from './agent-profile-http'
import { readOnce } from '@/lib/db/read-once'
import { factoryWorkspaceReader } from './workspace-reader'
import { factoryHumanWorkspaceResponse } from './workspace-http'

const store = new AgentProfileStore(pool)

/** Current workspace admission precedes Profile transactions and bounds every
 * explicit body/query workspace; a different owned tenant is not a bypass. */
export async function agentProfileHandler(request: Request, profileId?: string): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } })
  return factoryHumanWorkspaceResponse(session?.user, async () => {
    const handle = createAgentProfileHandler({
      authenticate: async () => {
        if (!session) return null
        const reader = await factoryWorkspaceReader(session.user.id)
        return { ownerId: session.user.id, workspaceId: taskReaderScope(reader).workspaceId }
      },
      store,
      // One request's repeated candidate, policy and device reads run once.
      management: (scope, preview) => readAgentProfileManagement(readOnce(pool), scope, preview),
    })
    return handle(request, profileId)
  })
}
