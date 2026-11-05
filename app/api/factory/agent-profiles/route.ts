import { agentProfileHandler } from '@/lib/factory/agent-profile-server'
export const dynamic = 'force-dynamic'
export const GET = (request: Request) => agentProfileHandler(request)
export const POST = (request: Request) => agentProfileHandler(request)
