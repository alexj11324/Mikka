import { z } from 'zod'
import { authenticatedArtifactReader } from '@/lib/artifacts/route'
import { readCapture } from '@/lib/captures/store'
import { captureFileResponse } from '@/lib/captures/serve'
import { captureOutsideToken } from '@/lib/tokens/scope'

export const dynamic = 'force-dynamic'

/** `GET /api/captures/:captureId`: one of the person's screenshots or recordings. */
export async function GET(request: Request, { params }: { params: Promise<{ captureId: string }> }) {
  const reader = await authenticatedArtifactReader(request.headers)
  if (!reader) return new Response('Sign in to view this.', { status: 401 })
  const { captureId } = await params
  const found = z.uuid().safeParse(captureId).success && !await captureOutsideToken(reader, captureId) ? await readCapture(reader, captureId) : null
  if (!found) return new Response('Not found', { status: 404 })
  return captureFileResponse(request, found, { 'cache-control': 'private, no-store' })
}
