import { auth } from '@/lib/auth'
import { localComputerDecision } from '@mikka/protocol/computer'
import { pendingLocalReviews, decideLocalReview } from '@/lib/cua/local-review-store'
const headers = { 'Cache-Control': 'private, no-store' }
async function owner(request: Request) {
  if (request.headers.get('sec-fetch-site') === 'cross-site') return null
  if (request.method !== 'GET' && request.headers.get('origin') !== new URL(request.url).origin) return null
  return (await auth.api.getSession({ headers: request.headers }))?.user.id ?? null
}
export async function GET(request: Request) {
  const userId = await owner(request)
  if (!userId) return Response.json({ error: 'Unauthorized' }, { status: 401, headers })
  return Response.json({ requests: await pendingLocalReviews(userId) }, { headers })
}
export async function POST(request: Request) {
  const userId = await owner(request)
  if (!userId) return Response.json({ error: 'Unauthorized' }, { status: 401, headers })
  const raw = await request.text()
  if (raw.length > 2000) return Response.json({ error: 'Too large' }, { status: 413, headers })
  const parsed = localComputerDecision.safeParse((() => { try { return JSON.parse(raw) } catch { return null } })())
  if (!parsed.success) return Response.json({ error: 'Invalid decision' }, { status: 400, headers })
  const { id, digest, approve } = parsed.data
  return await decideLocalReview(userId, id, digest, approve)
    ? Response.json({ status: 'queued' }, { headers })
    : Response.json({ error: 'Review expired, changed or already decided' }, { status: 409, headers })
}
