import { frameDocument, frameHeaders } from '@/lib/artifacts/frame'
import { routeArtifact } from '@/lib/artifacts/route'

export const dynamic = 'force-dynamic'

/**
 * `GET /api/artifacts/:id/versions/:n/frame`: an HTML artifact as the page the
 * viewer's sandboxed iframe loads (and 在浏览器打开 opens). Its own CSP
 * sandbox keeps it in an opaque origin either way.
 */
export async function GET(request: Request, { params }: { params: Promise<{ artifactId: string; version: string }> }) {
  const found = await routeArtifact(request, params)
  if (found instanceof Response) return found
  if (found.kind !== 'html') return new Response('Not found', { status: 404 })
  return new Response(frameDocument(found.content), { headers: frameHeaders() })
}
