import { NextResponse } from 'next/server'
import { auth, apiWorkspaceAllowed } from '@/lib/api-auth'
import { SearchInputError } from '@/lib/issue-search'
import { parseInput, UnsupportedSourceError } from '@/lib/federated-search/input'
import { readSearchPage, SearchAccessError } from '@/lib/federated-search/store'
import { unsupportedSources } from '@/lib/federated-search/types'

export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie, Authorization' }
/** Site-only read adapter. Consumers fetch one independent page per source. */
export async function GET(request: Request) {
  try {
    const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true, disableRefresh: true } })
    if (!session?.user) return NextResponse.json({ error: 'authRequired' }, { status: 401, headers })
    const input = parseInput(new URL(request.url).searchParams, session.user.id)
    if (input.workspaceId && !apiWorkspaceAllowed(session, input.workspaceId)) return NextResponse.json({ error: 'searchAccessDenied' }, { status: 403, headers })
    const read = await readSearchPage(session.user.id, input)
    const current = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true, disableRefresh: true } })
    if (!current?.user || current.user.id !== session.user.id || current.session.id !== session.session.id) return NextResponse.json({ error: 'authRequired' }, { status: 401, headers })
    return NextResponse.json(await read.revalidate(), { headers })
  } catch (error) {
    if (error instanceof SearchInputError) return NextResponse.json({ error: error.code }, { status: 400, headers })
    if (error instanceof UnsupportedSourceError) return NextResponse.json({ error: 'searchSourceUnsupported', sources: unsupportedSources }, { status: 422, headers })
    if (error instanceof SearchAccessError) return NextResponse.json({ error: 'searchAccessDenied' }, { status: 403, headers })
    // Never log queries, result metadata or database errors containing bound values.
    console.error('Site search failed')
    return NextResponse.json({ error: 'searchFailed' }, { status: 500, headers })
  }
}
