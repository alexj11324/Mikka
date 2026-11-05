import { freshSessionRoute } from '@/lib/fresh-session'
import { auth, apiWorkspaceAllowed } from '@/lib/api-auth'
import { modelAdmission } from '@/lib/model-admission/runtime'
import { createModelAdmissionHandler } from '@/lib/model-admission/http'
import { humanSessionHeaders } from '@/lib/desktop-rpc/handler'

export const dynamic = 'force-dynamic'
const handle = createModelAdmissionHandler({
  store: modelAdmission,
  async principal(request, workspaceId) {
    const sessionHeaders = humanSessionHeaders(request)
    if (!sessionHeaders) return null
    const session = await auth.api.getSession({ headers: sessionHeaders, query: { disableCookieCache: true } })
    return session?.user && apiWorkspaceAllowed(session, workspaceId) ? session.user.id : null
  },
})
type Context = { params: Promise<{ workspaceId: string }> }
export const GET = async (request: Request, { params }: Context) => handle(request, (await params).workspaceId)
const POSTBody = GET

// Credentials, permissions, money and deletion: the session is read from the database, not the cookie cache.
export const POST = freshSessionRoute(POSTBody)
