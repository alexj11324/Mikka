import { z } from 'zod'
import { auth } from '@/lib/api-auth'
import { readCapture } from '@/lib/captures/store'
import { captureFileResponse } from '@/lib/captures/serve'

export const dynamic = 'force-dynamic'

/** `GET /api/captures/:captureId`: one of the person's screenshots or recordings. */
export async function GET(request: Request, { params }: { params: Promise<{ captureId: string }> }) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return new Response('Sign in to view this.', { status: 401 })
  const { captureId } = await params
  const found = z.uuid().safeParse(captureId).success ? await readCapture(session.user.id, captureId) : null
  if (!found) return new Response('Not found', { status: 404 })
  return captureFileResponse(request, found, { 'cache-control': 'private, no-store' })
}
