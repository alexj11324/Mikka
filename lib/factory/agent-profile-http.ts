import { z } from 'zod'
import { AgentKitError } from '@/lib/agent-kit/store'
import { boundedJSON } from '@/lib/agent-kit/http'
import { AgentProfileError, agentProfileDefinitionSchema, type AgentProfileScope } from './agent-profile-definition'
import type { AgentProfileStore } from './agent-profile-store'
import { profileMarkInputSchema } from './agent-profile-mark'

// `mark` sits beside the definition: presentation only, never part of its digest.
const createSchema = z.strictObject({ workspaceId: z.uuid().optional(), profile: agentProfileDefinitionSchema, mark: profileMarkInputSchema.optional(), requestId: z.uuid().optional() })
const updateSchema = z.strictObject({ workspaceId: z.uuid().optional(), version: z.number().int().positive(), profile: agentProfileDefinitionSchema, mark: profileMarkInputSchema.optional() })
const archiveSchema = z.strictObject({ workspaceId: z.uuid().optional(), version: z.number().int().positive() })
const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })
export function createAgentProfileHandler(deps: {
  authenticate: (request: Request) => Promise<{ ownerId: string; workspaceId?: string } | null>
  store: Pick<AgentProfileStore, 'get' | 'history' | 'create' | 'update' | 'archive'>
  management: (scope: AgentProfileScope, preview?: { location?: 'local' | 'cloud'; deviceId?: string }) => Promise<unknown>
}) {
  return async (request: Request, profileId?: string): Promise<Response> => {
    const write = request.method !== 'GET'
    if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(request.method) || (profileId ? request.method === 'POST' : ['PATCH', 'DELETE'].includes(request.method))) return response({ error: 'methodNotAllowed' }, 405)
    if (write && request.headers.get('origin') !== new URL(request.url).origin) return response({ error: 'originMismatch' }, 403)
    try {
      const session = await deps.authenticate(request)
      if (!session) return response({ error: 'authRequired' }, 401)
      if (profileId) z.uuid().parse(profileId)
      const raw = write ? await boundedJSON(request) : undefined
      const body = request.method === 'POST' ? createSchema.parse(raw) : request.method === 'PATCH' ? updateSchema.parse(raw) : request.method === 'DELETE' ? archiveSchema.parse(raw) : undefined
      const queryWorkspace = new URL(request.url).searchParams.get('workspaceId')
      const workspaceId = z.uuid().parse(body?.workspaceId ?? queryWorkspace)
      if ((queryWorkspace && queryWorkspace !== workspaceId) || (session.workspaceId && session.workspaceId !== workspaceId)) return response({ error: 'agentProfileScopeNotFound' }, 404)
      const scope = { ownerId: session.ownerId, workspaceId }
      if (request.method === 'GET') {
        if (!profileId) {
          const url = new URL(request.url)
          const preview = { location: z.enum(['local', 'cloud']).optional().parse(url.searchParams.get('location') ?? undefined), deviceId: z.uuid().optional().parse(url.searchParams.get('deviceId') ?? undefined) }
          return response(await deps.management(scope, preview))
        }
        if (new URL(request.url).searchParams.get('history') === '1') return response({ versions: await deps.store.history(scope, profileId) })
        return response({ profile: await deps.store.get(scope, profileId) })
      }
      if (request.method === 'POST') {
        const input = createSchema.parse(body)
        return response({ profile: await deps.store.create(scope, input.profile, input.requestId, input.mark) }, 201)
      }
      if (request.method === 'PATCH') {
        const input = updateSchema.parse(body)
        return response({ profile: await deps.store.update(scope, profileId!, input.version, input.profile, input.mark) })
      }
      const input = archiveSchema.parse(body)
      return response({ profile: await deps.store.archive(scope, profileId!, input.version) })
    } catch (error) {
      if (error instanceof AgentProfileError) return response({ error: error.code }, error.status)
      if (error instanceof AgentKitError) return response({ error: error.code === 'agentDefinitionTooLarge' ? 'agentProfileTooLarge' : 'agentProfileInvalid' }, error.status)
      if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof TypeError) return response({ error: 'agentProfileInvalid' }, 400)
      return response({ error: 'agentProfileUnavailable' }, 500)
    }
  }
}
