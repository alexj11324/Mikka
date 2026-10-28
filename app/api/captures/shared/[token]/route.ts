import { sharedCapture } from '@/lib/captures/store'
import { captureFileResponse } from '@/lib/captures/serve'

export const dynamic = 'force-dynamic'

/** `GET /api/captures/shared/:token`: a capture behind a live share link, as artifact links work. */
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const found = await sharedCapture((await params).token)
  if (!found) return new Response('Not found', { status: 404 })
  return captureFileResponse(request, found, { 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex, nofollow' })
}
