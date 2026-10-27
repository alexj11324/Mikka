import { auth } from '@/lib/auth'
import { pool } from '@/lib/db'
import { workspaceDb } from '@/lib/workspace-db'
import { requireWorkspace } from '@/lib/workspace-access'
import { ComputerStore } from '@/lib/computer/store'
import { createComputerPolicyHandler } from '@/lib/computer/policy-route'

export const runtime = 'nodejs'
export const maxDuration = 120
const handle = createComputerPolicyHandler({
  enabled: () => process.env.MIKKA_CLOUD_COMPUTER_TASKS === '1',
  store: new ComputerStore(pool),
  authorize: async (request, workspaceId, admin) => {
    const session = await auth.api.getSession({ headers: request.headers })
    if (!session?.user) return null
    try {
      const member = await workspaceDb.transaction(tx => requireWorkspace(tx, workspaceId, session.user.id, admin))
      return { canEdit: member.membership.role === 'admin' }
    } catch { return null }
  },
})
type Context = { params: Promise<{ workspaceId: string }> }
export const GET = async (request: Request, { params }: Context) => handle(request, (await params).workspaceId)
export const POST = GET
