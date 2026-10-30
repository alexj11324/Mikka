import { loginAttemptRoute } from '@/lib/credentials/route'
export async function GET(request: Request, context: { params: Promise<{ botId: string; id: string; attemptId: string }> }) {
  const { botId, id, attemptId } = await context.params
  return loginAttemptRoute(request, { botId, subagentId: id }, attemptId)
}
