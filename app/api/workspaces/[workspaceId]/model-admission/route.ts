import { auth, apiWorkspaceAllowed } from '@/lib/api-auth'
import { modelAdmission } from '@/lib/model-admission/runtime'
import { createModelAdmissionHandler } from '@/lib/model-admission/http'

export const dynamic = 'force-dynamic'
const handle = createModelAdmissionHandler({
  store: modelAdmission,
  async principal(request, workspaceId) {
    if (!request.headers.get('cookie') || request.headers.has('authorization')) return null
    const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } })
    return session?.user && apiWorkspaceAllowed(session, workspaceId) ? session.user.id : null
  },
})
type Context = { params: Promise<{ workspaceId: string }> }
export const GET = async (request: Request, { params }: Context) => handle(request, (await params).workspaceId)
export const POST = GET
