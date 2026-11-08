import 'server-only'
import { taskReviewAuthority, withTaskReviewAuthority, ReviewAuthorityError } from '../review-authority'
import { beginReviewSession, readReviewSession, revokeReviewSession } from '../review-sessions'
import { resumeReviewMachine } from '../review-machine'
import { issueRunPreview, prepareRunPreview, previewParentOrigin, PreviewRuntimeError } from './runtime'

const HEADERS = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' }
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: HEADERS })

/** Exact #1754 / hosted#39 contract. No discovery poll, automatic server start,
 * arbitrary destination, or task/run fallback is introduced by this route. */
export async function reviewPreviewRoute(request: Request, taskId: string): Promise<Response> {
  let leaseId: string | undefined
  let authority: Awaited<ReturnType<typeof taskReviewAuthority>> | undefined
  try {
    authority = await taskReviewAuthority(request, taskId)
    const parentOrigin = previewParentOrigin(request)
    const query = new URL(request.url).searchParams
    const port = query.has('port') ? Number(query.get('port')) : undefined
    if ([...query.keys()].some(key => key !== 'port') || query.getAll('port').length > 1)
      throw new PreviewRuntimeError('configuration', 400)
    const lease = await withTaskReviewAuthority(request, taskId, async (current, client) => {
      authority = current
      if (request.signal.aborted) throw new PreviewRuntimeError('runtime', 408)
      return beginReviewSession(current, { kind: 'preview' }, client)
    }, { runId: authority.runId, bindingId: authority.bindingId })
    leaseId = lease.id
    await resumeReviewMachine(authority, lease, request.signal)
    const result = await prepareRunPreview(authority, { port, expiresAt: lease.expiresAt })
    if (!result.running) {
      if ((await revokeReviewSession(authority, { kind: 'preview', id: lease.id })).pending)
        throw new PreviewRuntimeError('runtime', 503)
      leaseId = undefined
      return json(result, 404)
    }
    const confirmed = await withTaskReviewAuthority(request, taskId, async (current, client) => {
      authority = current
      if (request.signal.aborted) throw new PreviewRuntimeError('runtime', 408)
      const active = await readReviewSession(current, { kind: 'preview', id: lease.id }, client)
      if (!active || active.id !== lease.id) throw new PreviewRuntimeError('scope_changed', 403)
      return active
    }, { runId: authority.runId, bindingId: authority.bindingId })
    const preview = await issueRunPreview(result, parentOrigin, { id: confirmed.id,
      expiresAt: new Date(Math.min(Date.parse(confirmed.expiresAt), Date.parse(result.expiresAt))).toISOString() })
    // E2B I/O never holds workspace/task/run locks. A revocation committed
    // while issuing the ticket either reaches its tombstone or fails this
    // final authorization check before the one-use URL leaves the server.
    await withTaskReviewAuthority(request, taskId, async (current, client) => {
      authority = current
      if (request.signal.aborted || !await readReviewSession(current, { kind: 'preview', id: lease.id }, client))
        throw new PreviewRuntimeError('scope_changed', 403)
    }, { runId: authority.runId, bindingId: authority.bindingId })
    return json(preview)
  } catch (cause) {
    let failure: unknown = cause
    if (leaseId && authority) {
      try {
        if ((await revokeReviewSession(authority, { kind: 'preview', id: leaseId })).pending)
          throw new PreviewRuntimeError('runtime', 503, { cause })
      } catch (revocationCause) {
        // Keep an unacknowledged lease for the durable revocation worker.
        failure = new PreviewRuntimeError('runtime', 503, { cause: new AggregateError([cause, revocationCause], 'Preview authorization cleanup failed') })
      }
    }
    if (failure instanceof ReviewAuthorityError || failure instanceof PreviewRuntimeError)
      return json({ error: failure.code, code: failure.code, detail: failure.detail }, failure.status)
    const error = new PreviewRuntimeError('runtime', 503, { cause: failure })
    console.warn('review preview unavailable', { taskId, code: error.code, detail: error.detail,
      causeName: failure instanceof Error ? failure.name : typeof failure })
    return json({ error: error.code, code: error.code, detail: error.detail }, error.status)
  }
}
