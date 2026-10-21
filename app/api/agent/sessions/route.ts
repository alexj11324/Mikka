import { z } from 'zod'
import { auth } from '@/lib/auth'
import { AgentStoreError, getAgentHistory } from '@/lib/agent-store'

export async function GET(request: Request) {
  const headers = { 'Cache-Control': 'private, no-store' }
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return Response.json({ error: '请先登录。' }, { status: 401, headers })
  const params = new URL(request.url).searchParams
  const id = params.get('sessionId')
  if (id && !z.uuid().safeParse(id).success) return Response.json({ error: '会话标识无效。' }, { status: 400, headers })
  try {
    return Response.json(await getAgentHistory(session.user.id, id ?? undefined, params.get('new') === '1'), { headers })
  } catch (error) {
    return Response.json({ error: error instanceof AgentStoreError ? error.message : '无法读取聊天历史，请稍后重试。' }, {
      status: error instanceof AgentStoreError ? error.status : 503, headers,
    })
  }
}
