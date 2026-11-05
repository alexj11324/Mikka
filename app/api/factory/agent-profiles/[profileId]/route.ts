import { agentProfileHandler } from '@/lib/factory/agent-profile-server'
export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ profileId: string }> }
export async function GET(request: Request, { params }: Context) { return agentProfileHandler(request, (await params).profileId) }
export async function PATCH(request: Request, { params }: Context) { return agentProfileHandler(request, (await params).profileId) }
export async function DELETE(request: Request, { params }: Context) { return agentProfileHandler(request, (await params).profileId) }
