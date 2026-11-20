import { frameDocument, frameHeaders } from '@mikka/protocol/artifact-frame'
import { sharedArtifactFrame } from '@/lib/artifacts/store'
import { artifactShareViewer } from '@/lib/artifacts/share-viewer'


/** `GET /api/artifacts/shared/:token/frame`: a shared HTML artifact for the share page's sandboxed iframe. */
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const content = await sharedArtifactFrame((await params).token, () => artifactShareViewer(request))
  const headers = { ...frameHeaders(), 'cache-control': 'private, no-store' }
  if (content === null) return new Response('Not found', { status: 404, headers })
  return new Response(frameDocument(content), { headers })
}
