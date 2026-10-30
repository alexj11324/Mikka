import { loginAttemptRoute } from '@/lib/credentials/route'
export async function GET(request: Request, context: { params: Promise<{ runId: string; attemptId: string }> }) {
  const { runId, attemptId } = await context.params
  return loginAttemptRoute(request, { runId }, attemptId)
}
