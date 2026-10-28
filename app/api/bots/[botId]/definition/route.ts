import { auth } from '@/lib/auth'
import { createAgentDefinitionHandler } from '@/lib/agent-kit/http'
import { agentKitEnabled,agentKitStore,agentScope,agentKitDefaults } from '@/lib/agent-kit/service'
import { evaluateProposal } from '@/lib/agent-kit/live-eval'
import { pool } from '@/lib/db'
import { workspacePool } from '@/lib/workspace-db'
import { acquireWorkspaceMembership } from '@/lib/workspace-membership-guard'
import { createWritePolicySettings } from '@/lib/operations/write-policy-settings'
import { personalWritesEnabled } from '@/lib/operations/write-feature'

export const dynamic='force-dynamic'
export const maxDuration=300
const handler=createAgentDefinitionHandler({
  enabled:agentKitEnabled,
  authenticate:async request => (await auth.api.getSession({ headers:request.headers,query:{ disableCookieCache:true } }))?.user.id ?? null,
  scope:agentScope,store:agentKitStore,defaults:agentKitDefaults(),
  writePolicy: { enabled:personalWritesEnabled, settings:createWritePolicySettings(pool, scope => scope.workspaceId ? (_tx, signal) => acquireWorkspaceMembership(workspacePool, { workspaceId:scope.workspaceId!, userId:scope.ownerId }, signal) : undefined) },
  evaluate:(scope,proposalId,requestId,mode) => evaluateProposal(agentKitStore,scope,proposalId,requestId,mode),
})
export async function GET(request:Request,{ params }:{ params:Promise<{botId:string}> }) { return handler(request,(await params).botId) }
export async function POST(request:Request,{ params }:{ params:Promise<{botId:string}> }) { return handler(request,(await params).botId) }
