import { subagentCredentialRoute } from '@/lib/credentials/route'
export async function POST(request: Request, context: { params: Promise<{ botId: string; id: string }> }) {
  const { botId, id } = await context.params
  return subagentCredentialRoute(request, botId, id, 'challenge')
}
