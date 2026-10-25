import { frameDocument, frameHeaders } from '@/lib/artifacts/frame'
import { sharedArtifact } from '@/lib/artifacts/store'

export const dynamic = 'force-dynamic'

/** `GET /api/artifacts/shared/:token/frame`: a shared HTML artifact for the share page's sandboxed iframe. */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const found = await sharedArtifact((await params).token)
  if (!found || found.kind !== 'html') return new Response('Not found', { status: 404 })
  return new Response(frameDocument(found.content), { headers: frameHeaders() })
}
