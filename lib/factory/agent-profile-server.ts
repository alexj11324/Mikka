import 'server-only'
import { auth } from '@/lib/api-auth'
import { pool } from '@/lib/db'
import { AgentProfileStore } from './agent-profile-store'
import { readAgentProfileManagement } from './agent-profile'
import { createAgentProfileHandler } from './agent-profile-http'
import { readOnce } from '@/lib/db/read-once'
export const agentProfileHandler = createAgentProfileHandler({
  authenticate: async request => {
    const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } })
    return session ? { ownerId: session.user.id, ...(session.tokenWorkspaceId ? { workspaceId: session.tokenWorkspaceId } : {}) } : null
  },
  store: new AgentProfileStore(pool),
  // One request's repeated candidate, policy and device reads (one per Profile) run once.
  management: (scope, preview) => readAgentProfileManagement(readOnce(pool), scope, preview),
})
