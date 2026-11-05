import 'server-only'
import { z } from 'zod'
import { apiWorkspaceAllowed, auth } from '@/lib/api-auth'
import { ProjectMapError, decisionSourceLocatorSchema, type RecordDecisionInput } from './contracts'
import { listProjectDecisions, markMessageAsDecision, recordProjectDecision } from './decisions'
import { resolveProjectScope } from './scope'

const headers = { 'Cache-Control': 'private, no-store' }
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers })
export async function decisionsHttp(request: Request, projectId: string, fromMessage = false): Promise<Response> {
  try {
    const session = await auth.api.getSession({ headers: request.headers })
    if (!session) return reply({ error: 'AUTH_REQUIRED' }, 401)
    if (!z.uuid().safeParse(projectId).success) return reply({ error: 'PROJECT_NOT_FOUND' }, 404)
    const url = new URL(request.url)
    if (request.method === 'GET') {
      const workspaceId = z.uuid().parse(url.searchParams.get('workspaceId'))
      if (!apiWorkspaceAllowed(session, workspaceId)) return reply({ error: 'PROJECT_NOT_FOUND' }, 404)
      const scope = await resolveProjectScope(session.user, projectId, workspaceId)
      return reply({ projectId, workspaceId, decisions: await listProjectDecisions(scope) })
    }
    if (request.method !== 'POST') return reply({ error: 'METHOD_NOT_ALLOWED' }, 405)
    // Browser mutations require same-origin; bearer principals do not use ambient cookie authority.
    if (!session.tokenWorkspaceId && request.headers.get('origin') !== url.origin) return reply({ error: 'ORIGIN_REQUIRED' }, 403)
    if (Number(request.headers.get('content-length') ?? 0) > 65_536) return reply({ error: 'BODY_TOO_LARGE' }, 413)
    const text = await request.text()
    if (Buffer.byteLength(text) > 65_536) return reply({ error: 'BODY_TOO_LARGE' }, 413)
    const body: unknown = JSON.parse(text)
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ProjectMapError('INVALID_DECISION')
    const record = body as Record<string, unknown>
    const workspaceId = z.uuid().parse(record.workspaceId)
    if (!apiWorkspaceAllowed(session, workspaceId)) return reply({ error: 'PROJECT_NOT_FOUND' }, 404)
    if (record.projectId !== undefined && record.projectId !== projectId) throw new ProjectMapError('SCOPE_MISMATCH', 409)
    const actor = { kind: 'human' as const, user: session.user, workspaceId }
    const { source, ...input } = record
    if (!fromMessage && source !== undefined) throw new ProjectMapError('INVALID_DECISION')
    const result = fromMessage
      ? await markMessageAsDecision(actor, projectId, input as RecordDecisionInput, decisionSourceLocatorSchema.parse(source))
      : await recordProjectDecision(actor, { ...record, projectId } as RecordDecisionInput)
    return reply(result, result.duplicate ? 200 : 201)
  } catch (error) {
    if (error instanceof ProjectMapError) return reply({ error: error.code }, error.status)
    if (error instanceof z.ZodError || error instanceof SyntaxError) return reply({ error: 'INVALID_DECISION' }, 400)
    // Never log decision bodies, tool arguments, source conversations or credentials.
    console.error('[project-decisions] request failed')
    return reply({ error: 'DECISION_UNAVAILABLE' }, 503)
  }
}
