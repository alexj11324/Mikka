import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { pool } from '@/lib/db'
import { directory } from '@/lib/group-conversations-route'
import { reviewArtifact } from '@/lib/artifact-review-store'
import { groupReviewCommand } from '@/lib/group-review-commands'
import { ReviewFailure } from '@/lib/group-review-access'

export async function respondReview(request: Request, conversationId: string, resource: 'artifacts' | 'review') {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user?.id) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const origin = request.headers.get('origin')
  if (origin) {
    let valid = false
    try { const url = new URL(origin); valid = ['https:', 'http:'].includes(url.protocol) && url.host === (request.headers.get('host') ?? new URL(request.url).host) } catch { /* fail closed */ }
    if (!valid) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  try {
    const input = await request.json().catch(() => null)
    const result = await (resource === 'artifacts' ? reviewArtifact : groupReviewCommand)(pool, directory, conversationId, session.user.id, input)
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    if (error instanceof ReviewFailure) return NextResponse.json({ error: error.code }, { status: error.status, headers: { 'Cache-Control': 'private, no-store' } })
    throw error
  }
}
