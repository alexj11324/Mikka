import { freshSessionRoute } from '@/lib/fresh-session'
import { cloudComputerTasksEnabled } from '@/lib/cloud-computer-flag'
import { auth, apiWorkspaceAllowed } from '@/lib/api-auth'
import { pool } from '@/lib/db'
import { workspaceDb } from '@/lib/workspace-db'
import { requireWorkspace, WorkspaceError } from '@/lib/workspace-access'
import { ComputerStore } from '@/lib/computer/store'
import { createComputerPolicyHandler } from '@/lib/computer/policy-route'

export const maxDuration = 120
const handle = createComputerPolicyHandler({
  enabled: () => cloudComputerTasksEnabled(),
  store: new ComputerStore(pool),
  withMember: async (request, workspaceId, admin, operation) => {
    const session = await auth.api.getSession({ headers: request.headers })
    if (!session?.user || !apiWorkspaceAllowed(session, workspaceId)) return null
    try {
      return await workspaceDb.transaction(async tx => {
        const { membership } = await requireWorkspace(tx, workspaceId, session.user.id, admin)
        // Keep the workspace role authoritative through the application database commit.
        return operation(membership.role === 'admin')
      })
    } catch (error) {
      if (error instanceof WorkspaceError) return null
      throw error
    }
  },
})
type Context = { params: Promise<{ workspaceId: string }> }
export const GET = async (request: Request, { params }: Context) => handle(request, (await params).workspaceId)
const POSTBody = GET

// Credentials, permissions, money and deletion: the session is read from the database, not the cookie cache.
export const POST = freshSessionRoute(POSTBody)
