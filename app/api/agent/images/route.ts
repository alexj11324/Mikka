import { auth } from '@/lib/auth'
import { agentImageQuery, findAgentImage } from '@/lib/agent-images'

export async function GET(request: Request) {
  const headers = { 'Cache-Control': 'private, no-store' }
  if (request.headers.get('sec-fetch-site') === 'cross-site') return Response.json({ error: '不允许跨站调用。' }, { status: 403, headers })
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return Response.json({ error: '请先登录。' }, { status: 401, headers })
  const query = agentImageQuery.safeParse(new URL(request.url).searchParams.get('q'))
  if (!query.success) return Response.json({ error: '图片关键词需要 2–160 字，不能是 URL。' }, { status: 400, headers })
  try {
    return Response.json({ image: await findAgentImage(query.data, request.signal) }, { headers })
  } catch {
    return Response.json({ error: '图片来源暂时不可用，正文不受影响。' }, { status: 502, headers })
  }
}
