import { threadCredentialRoute } from '@/lib/credentials/route'
export async function POST(request: Request, context: { params: Promise<{ runId: string }> }) {
  return threadCredentialRoute(request, (await context.params).runId, 'challenge')
}
