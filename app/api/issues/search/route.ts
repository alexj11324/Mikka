import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { ActionFailureError } from '@/lib/action-error'
import { db } from '@/lib/db'
import { requireIssueAccess } from '@/lib/issue-access'
import { readIssueMetadata } from '@/lib/issue-metadata'
import { issueSearchVisibility } from '@/lib/issue-search-visibility'
import { parseSearchParams, searchIssues, SearchInputError } from '@/lib/issue-search'
import { workspaceDb } from '@/lib/workspace-db'
import { loadWorkspaceContext, WorkspaceError } from '@/lib/workspace-access'

/**
 * GET /api/issues/search — relation picker search (MIK-16). See lib/issue-search.ts for the
 * full contract. Query params:
 *   q                    '' = recent; ORV-123 / MIK-123 / 123 = exact number; else title match.
 *                        One non-CJK character is a 400; one CJK character searches.
 *   issueId              the issue being edited; drives existingRelation and canRelate.
 *   relationKind         optional; preferred kind when reporting existingRelation.
 *   excludeId            hidden from results (usually = issueId).
 *   excludeDescendants   also hide excludeId's descendants (recursive, 20-level cap).
 *   excludeAncestors     also hide excludeId's ancestors (recursive, 20-level cap).
 *   workspaceId          defaults to the current workspace.
 *   limit (1–50, default 20), cursor (opaque, from nextCursor).
 * Response: { items, nextCursor, truncated }. truncated = the ancestor/descendant walk hit the
 * 20-level cap, so some deeper relatives may not be excluded; nextCursor = more rows exist.
 */
export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return NextResponse.json({ error: 'authRequired' }, { status: 401 })
  const userId = session.user.id
  try {
    const params = parseSearchParams(new URL(request.url).searchParams)
    const context = await loadWorkspaceContext(params.workspaceId ?? undefined, session.user)
    const currentAccess = params.issueId ? await requireIssueAccess(params.issueId) : null
    if (params.excludeId && params.excludeId !== params.issueId) await requireIssueAccess(params.excludeId)
    const current = currentAccess ? { id: currentAccess.issue.id, ownerId: currentAccess.issue.userId, metadata: readIssueMetadata(currentAccess.issue.content) } : null
    // Same visibility as listIssues: team-linked issues only through teams in this workspace.
    const { publicIds, isVisible } = await issueSearchVisibility(workspaceDb, userId, context.workspace.id)
    const result = await searchIssues(db, { userId, params, publicIds, current, isVisible })
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    if (error instanceof SearchInputError) return NextResponse.json({ error: error.code }, { status: 400 })
    if (error instanceof WorkspaceError) return NextResponse.json({ error: error.code }, { status: 403 })
    if (error instanceof ActionFailureError) return NextResponse.json({ error: error.code }, { status: error.code === 'authRequired' ? 401 : 404 })
    if (error instanceof Error && error.name === 'ZodError') return NextResponse.json({ error: 'searchInvalidParam' }, { status: 400 })
    console.error('Issue search failed', error instanceof Error ? error.name : 'UnknownError')
    return NextResponse.json({ error: 'issueSearchFailed' }, { status: 500 })
  }
}
