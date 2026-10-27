import { ARTIFACT_CONTENT_TYPES, artifactFileName } from '@/lib/artifacts/limits'
import { routeArtifact } from '@/lib/artifacts/route'

export const dynamic = 'force-dynamic'

/** `GET /api/artifacts/:id/versions/:n/download`: the file as it was handed over. */
export async function GET(request: Request, { params }: { params: Promise<{ artifactId: string; version: string }> }) {
  const found = await routeArtifact(request, params)
  if (found instanceof Response) return found
  const name = artifactFileName(found.title, found.kind, found.version)
  return new Response(found.content, {
    headers: {
      'content-type': ARTIFACT_CONTENT_TYPES[found.kind],
      'content-disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
      // A downloaded page must not run here if a browser renders it anyway.
      'content-security-policy': "sandbox; default-src 'none'",
    },
  })
}
