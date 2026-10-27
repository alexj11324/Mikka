import { subagentRoute } from '@/lib/computer/subagent-route'
export const runtime = 'nodejs'
export async function POST(request: Request, context: { params: Promise<{ botId: string; id: string }> }) {
  const { botId, id } = await context.params
  return subagentRoute(request, botId, id, 'viewer')
}
