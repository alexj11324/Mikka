import { z } from 'zod'
import { auth } from '@/lib/auth'
import { AccountAuthenticationError, requireFreshAccountSession } from '@/lib/account/fresh-session'
import { cancelAccountDeletion, readAccountDeletionReceipt, requestAccountDeletion } from '@/lib/account/deletion-jobs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const headers = { 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' }
const receipt = z.string().uuid()
const requestBody = z.object({ email: z.string().trim().max(320), requestId: receipt }).strict()

/** A caller keeps its private request UUID before POST so a lost response can be resumed. No ID appears in a URL. */
export async function POST(request: Request) {
  if (request.headers.get('origin') !== new URL(request.url).origin) return Response.json({ error: 'originNotAllowed' }, { status: 403, headers })
  let session
  try { session = await requireFreshAccountSession(request.headers) }
  catch (error) {
    if (error instanceof AccountAuthenticationError) return Response.json({ error: error.code }, { status: error.status, headers })
    return Response.json({ error: 'accountDeletionUnavailable' }, { status: 503, headers })
  }
  const input = requestBody.safeParse(await request.json().catch(() => null))
  if (!input.success || input.data.email.toLowerCase() !== session.user.email.toLowerCase()) return Response.json({ error: 'accountEmailMismatch' }, { status: 400, headers })
  try {
    const job = await requestAccountDeletion(session.user.id, session.user.email, input.data.requestId)
    if (!job.ok) return Response.json({ error: 'accountSoleAdmin', workspaces: job.soleAdminOf }, { status: 409, headers })
    return Response.json(await readAccountDeletionReceipt(job.id), { status: 202, headers })
  } catch { return Response.json({ error: 'accountDeletionUnavailable' }, { status: 503, headers }) }
}
/** Receipt capability remains usable when the account and its sessions have already been deleted. */
export async function GET(request: Request) {
  const input = receipt.safeParse(request.headers.get('x-mikka-deletion-receipt'))
  if (!input.success) return Response.json({ error: 'accountDeletionUnavailable' }, { status: 404, headers })
  try { return Response.json(await readAccountDeletionReceipt(input.data), { headers }) }
  catch { return Response.json({ error: 'accountDeletionUnavailable' }, { status: 404, headers }) }
}
export async function DELETE(request: Request) {
  if (request.headers.get('origin') !== new URL(request.url).origin) return Response.json({ error: 'originNotAllowed' }, { status: 403, headers })
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user || !session.session) return Response.json({ error: 'authRequired' }, { status: 401, headers })
  const input = receipt.safeParse(request.headers.get('x-mikka-deletion-receipt'))
  if (!input.success) return Response.json({ error: 'accountDeletionUnavailable' }, { status: 404, headers })
  try {
    const cancelled = await cancelAccountDeletion(session.user.id, input.data)
    return Response.json({ cancelled }, { status: cancelled ? 200 : 409, headers })
  } catch { return Response.json({ error: 'accountDeletionUnavailable' }, { status: 404, headers }) }
}
