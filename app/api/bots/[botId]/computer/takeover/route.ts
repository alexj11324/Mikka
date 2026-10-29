import { computerRoute } from '@/lib/computer/route'
export const maxDuration = 300
export async function POST(request: Request, context: { params: Promise<{ botId: string }> }) {
  return computerRoute(request, (await context.params).botId, 'takeover')
}
