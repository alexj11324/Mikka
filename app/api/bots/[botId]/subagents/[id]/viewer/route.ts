import { subagentRoute } from '@/lib/cloud-computer/route'
export const runtime = 'nodejs'
export async function POST(request: Request, { params }: {params: Promise<{botId: string; id: string}>}) { const {botId,id}=await params; return subagentRoute(request,botId,id, 'viewer') }
