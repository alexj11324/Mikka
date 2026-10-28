import { auth } from '@/lib/auth'
import { createAgentDefinitionHandler } from '@/lib/agent-kit/http'
import { agentKitEnabled,agentKitStore,agentScope,agentKitDefaults } from '@/lib/agent-kit/service'
import { evaluateProposal } from '@/lib/agent-kit/live-eval'

export const dynamic='force-dynamic'
export const maxDuration=300
const handler=createAgentDefinitionHandler({
  enabled:agentKitEnabled,
  authenticate:async request => (await auth.api.getSession({ headers:request.headers,query:{ disableCookieCache:true } }))?.user.id ?? null,
  scope:agentScope,store:agentKitStore,defaults:agentKitDefaults(),
  evaluate:(scope,proposalId,requestId,mode) => evaluateProposal(agentKitStore,scope,proposalId,requestId,mode),
})
export async function GET(request:Request,{ params }:{ params:Promise<{botId:string}> }) { return handler(request,(await params).botId) }
export async function POST(request:Request,{ params }:{ params:Promise<{botId:string}> }) { return handler(request,(await params).botId) }
