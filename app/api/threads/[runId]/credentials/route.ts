import { threadCredentialRoute } from '@/lib/credentials/route'
export const maxDuration = 60
export async function POST(request: Request, context: { params: Promise<{ runId: string }> }) {
  return threadCredentialRoute(request, (await context.params).runId, 'submit')
}
