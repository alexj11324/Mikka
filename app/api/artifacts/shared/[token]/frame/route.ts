import { frameDocument, frameHeaders } from '@mikka/protocol/artifact-frame'
import { sharedArtifactFrame } from '@/lib/artifacts/store'

export const dynamic = 'force-dynamic'

/** `GET /api/artifacts/shared/:token/frame`: a shared HTML artifact for the share page's sandboxed iframe. */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const content = await sharedArtifactFrame((await params).token)
  if (content === null) return new Response('Not found', { status: 404 })
  return new Response(frameDocument(content), { headers: frameHeaders() })
}
