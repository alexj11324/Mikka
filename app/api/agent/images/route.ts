import { defaultAgentCopy as agentCopy } from '@/lib/agent-copy'
import { auth } from '@/lib/auth'
import { agentImageQuery, findAgentImage } from '@/lib/agent-images'

export async function GET(request: Request) {
  const headers = { 'Cache-Control': 'private, no-store' }
  if (request.headers.get('sec-fetch-site') === 'cross-site') return Response.json({ error: agentCopy.crosssiteRequestsAreNotAllowed }, { status: 403, headers })
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return Response.json({ error: agentCopy.pleaseSignInFirst }, { status: 401, headers })
  const query = agentImageQuery.safeParse(new URL(request.url).searchParams.get('q'))
  if (!query.success) return Response.json({ error: agentCopy.imageKeywordsMustBe2160CharactersAnd }, { status: 400, headers })
  try {
    return Response.json({ image: await findAgentImage(query.data, request.signal) }, { headers })
  } catch {
    return Response.json({ error: agentCopy.imageSourcesAreTemporarilyUnavailableTheResponse }, { status: 502, headers })
  }
}
