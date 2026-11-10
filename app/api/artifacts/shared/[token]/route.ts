import { sharedArtifact } from '@/lib/artifacts/store'
import { withRequestLog } from '@/lib/request-log'
import { authenticatedArtifactReader } from '@/lib/artifacts/route'

export const dynamic = 'force-dynamic'
const privateHeaders = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' }

/** The public share token is the permission, exactly as on /a/<token>.
 * Only the existing ArtifactShared props leave this endpoint. */
export const GET = withRequestLog('/api/artifacts/shared/[token]', async (request: Request, { params }: { params: Promise<{ token: string }> }) => {
  const { token } = await params
  const reader = await authenticatedArtifactReader(request.headers)
  const found = /^mks_[A-Za-z0-9_-]{1,124}$/.test(token) ? await sharedArtifact(token, reader) : null
  if (!found) return Response.json({ error: 'not_found' }, { status: 404, headers: privateHeaders })
  const artifact = {
    id: found.id, kind: found.kind, title: found.title, latestVersion: found.latestVersion,
    runId: found.runId, issueId: found.issueId,
    versions: found.versions.map(version => ({
      version: version.version, authorName: version.authorName, authorColor: version.authorColor,
      authorShape: version.authorShape, authorHarness: version.authorHarness, createdAt: version.createdAt,
    })),
  }
  return Response.json({ artifact, markdown: found.kind === 'markdown' ? found.content : null }, { headers: privateHeaders })
})
