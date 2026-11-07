import { z } from 'zod'
import { withRequestLog, noteLogUser } from '@/lib/request-log'
import { ActionFailureError } from '@/lib/action-error'
import { forbiddenOrigin, json, mobileUser, unauthorized, writeAllowed } from '@/lib/mobile-api'
import { runOutsideToken } from '@/lib/tokens/scope'
import { actAs } from '@/lib/acting-user'
import { effectiveRequestWorkspace } from '@/lib/request-workspace'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { enterprisePrincipal } from '@/lib/enterprise/principal'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

/**
 * `POST /api/mobile/threads/:id/continue` with `{ via: 'key' | 'retry' }`: a run
 * paused on its subscription's quota goes on, as the web's quota card does
 * (lib/run-quota.ts): on the person's API key, or with its original credential
 * after the reset. `:id` is the paused run (`paused.runId` of the thread).
 */
async function handlePOST(request: Request, { params }: Params) {
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  if (!writeAllowed(request)) return forbiddenOrigin()
  const id = z.uuid().safeParse((await params).id)
  if (!id.success) return json({ error: 'runNotFound' }, 404)
  const workspaceId = await effectiveRequestWorkspace(user)
  if (!workspaceId) return json({ error: 'runNotFound' }, 404)
  // Resolve once and retain the verified session/PAT proof through the quota
  // transaction. The body and a later cookie change cannot select its tenant.
  const reader = { ...user, [tokenWorkspace]: workspaceId, [enterprisePrincipal]: user[enterprisePrincipal] }
  if (await runOutsideToken(reader, id.data)) return json({ error: 'runNotFound' }, 404)
  const body = z.object({ via: z.enum(['key', 'retry']) }).safeParse(await request.json().catch(() => null))
  if (!body.success) return json({ error: 'invalidRequest' }, 400)
  const quota = await import('@/lib/run-quota')
  try {
    return json(await actAs(reader, () => (body.data.via === 'key' ? quota.resumeQuotaPausedRunOnApiKey : quota.retryQuotaPausedRun)(user.id, id.data)))
  } catch (error) {
    if (error instanceof ActionFailureError) return json({ error: error.code }, ['runNotFound', 'workspaceAccessDenied'].includes(error.code) ? 404 : 409)
    throw error
  }
}

export const POST = withRequestLog('/api/mobile/threads/[id]/continue', handlePOST)
