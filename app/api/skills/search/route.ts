import { noteLogUser, withRequestLog } from '@/lib/request-log'
import { getVercelOidcToken } from '@vercel/oidc'

import { SKILLS_MAX_PAGE, SKILLS_PAGE_SIZE, SKILLS_SEARCH_MAX, skillsPage, skillsSearchResponseSchema, skillsUpstreamUrl } from '@/lib/skills-search'
import { auth } from '@/lib/api-auth'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

async function handleGET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  noteLogUser(session?.user?.id)
  if (!session?.user) {
    return Response.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE })
  }

  const params = new URL(request.url).searchParams
  const query = params.get('q')?.trim() ?? ''
  const pageParam = params.get('page') ?? '0'
  const page = /^\d{1,4}$/.test(pageParam) ? Number(pageParam) : -1
  const lastPage = query ? SKILLS_SEARCH_MAX / SKILLS_PAGE_SIZE - 1 : SKILLS_MAX_PAGE
  if (query.length === 1 || query.length > 100 || page < 0 || page > lastPage) {
    return Response.json({ error: 'invalid_query' }, { status: 400, headers: NO_STORE })
  }

  let token: string
  try {
    token = await getVercelOidcToken()
  } catch {
    return Response.json({ error: 'skills_oidc_unavailable' }, { status: 503, headers: NO_STORE })
  }

  const url = skillsUpstreamUrl(query, page)

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

    return Response.json(skillsPage(result.data, query, page), { headers: NO_STORE })
  } catch {
    return Response.json({ error: 'skills_search_unavailable' }, { status: 503, headers: NO_STORE })
  }
}

export const GET = withRequestLog('/api/skills/search', handleGET)
