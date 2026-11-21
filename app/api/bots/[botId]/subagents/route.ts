import { subagentRoute } from '@/lib/cloud-computer/route'
export async function POST(request: Request, { params }: { params: Promise<{botId: string}> }) { return subagentRoute(request, (await params).botId) }
