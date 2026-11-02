import { auth } from '@/lib/api-auth'
import { pool } from '@/lib/db'
import { localComputerDecision } from '@mikka/protocol/computer'
import { decideLocalComputerReview, pendingLocalComputerReviews } from '@/lib/computer/local-reviews'
import { runOutsideToken, runsOutsideToken } from '@/lib/tokens/scope'

export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'private, no-store' }
async function owner(request: Request) {
  if (request.headers.get('sec-fetch-site') === 'cross-site') return null
  if (request.method !== 'GET' && request.headers.get('origin') !== new URL(request.url).origin) return null
  return (await auth.api.getSession({ headers: request.headers }))?.user ?? null
}
export async function GET(request: Request) {
  const user = await owner(request)
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401, headers })
  const requests = await pendingLocalComputerReviews(pool, user.id)
  const outside = await runsOutsideToken(user, requests.map(item => item.runId))
  return Response.json({ requests: requests.filter(item => !outside.has(item.runId)) }, { headers })
}
export async function POST(request: Request) {
  const user = await owner(request)
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401, headers })
  const raw = await request.text()
  if (raw.length > 2000) return Response.json({ error: 'Too large' }, { status: 413, headers })
  const parsed = localComputerDecision.safeParse((() => { try { return JSON.parse(raw) } catch { return null } })())
  if (!parsed.success) return Response.json({ error: 'Invalid decision' }, { status: 400, headers })
  const { id, digest, approve } = parsed.data
  const [review] = (await pool.query<{ runId: string }>('SELECT "runId" FROM local_computer_reviews WHERE id=$1 AND "userId"=$2', [id, user.id])).rows
  if (review && await runOutsideToken(user, review.runId)) return Response.json({ error: 'Review unavailable' }, { status: 409, headers })
  return await decideLocalComputerReview(pool, user.id, id, digest, approve)
    ? Response.json({ status: 'queued' }, { headers })
    : Response.json({ error: 'Review unavailable' }, { status: 409, headers })
}
