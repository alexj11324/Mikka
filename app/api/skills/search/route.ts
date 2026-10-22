import { getVercelOidcToken } from '@vercel/oidc'

import { skillsSearchResponseSchema } from '@/lib/skills-search'
import { auth } from '@/lib/auth'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) {
    return Response.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE })
  }

  const query = new URL(request.url).searchParams.get('q')?.trim() ?? ''
  if (query.length === 1 || query.length > 100) {
    return Response.json({ error: 'invalid_query' }, { status: 400, headers: NO_STORE })
  }

  let token: string
  try {
    token = await getVercelOidcToken()
  } catch {
    return Response.json({ error: 'skills_oidc_unavailable' }, { status: 503, headers: NO_STORE })
  }

  const url = new URL(query ? '/api/v1/skills/search' : '/api/v1/skills', 'https://skills.sh')
  if (query) {
    url.searchParams.set('q', query)
    url.searchParams.set('limit', '12')
  } else {
    url.searchParams.set('view', 'trending')
    url.searchParams.set('per_page', '12')
  }

  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      return Response.json(
        { error: 'skills_search_unavailable' },
        { status: response.status === 401 ? 503 : response.status === 429 ? 429 : 502, headers: NO_STORE },
      )
    }

    const result = skillsSearchResponseSchema.safeParse(await response.json())
    if (!result.success) {
      return Response.json({ error: 'invalid_skills_response' }, { status: 502, headers: NO_STORE })
    }

    return Response.json({ data: result.data.data }, { headers: NO_STORE })
  } catch {
    return Response.json({ error: 'skills_search_unavailable' }, { status: 503, headers: NO_STORE })
  }
}
