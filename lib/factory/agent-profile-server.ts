import 'server-only'
import { auth } from '@/lib/api-auth'
import { pool } from '@/lib/db'
import { AgentProfileStore } from './agent-profile-store'
import { readAgentProfileManagement } from './agent-profile'
import { createAgentProfileHandler } from './agent-profile-http'
export const agentProfileHandler = createAgentProfileHandler({
  authenticate: async request => {
    const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } })
    return session ? { ownerId: session.user.id, ...(session.tokenWorkspaceId ? { workspaceId: session.tokenWorkspaceId } : {}) } : null
  },
  store: new AgentProfileStore(pool), management: (scope, preview) => readAgentProfileManagement(pool, scope, preview),
})
