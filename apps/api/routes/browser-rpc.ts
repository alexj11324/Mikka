import { auth } from '@/lib/auth'
import { appOrigin } from '@/lib/mcp/resource'
import { withRequestLog, noteLogUser } from '@/lib/request-log'
import { ActionFailureError } from '@/lib/action-error'
import { WorkspaceError } from '@/lib/workspace-error'
import { desktopActions } from '@/lib/desktop-rpc/registry'
import { createBrowserRpc } from '@/lib/browser-rpc/handler'
import { browserAuthentication } from '@/lib/browser-rpc/session'

export const maxDuration = 300
const sessions = browserAuthentication(input => auth.api.getSession(input), async () => (await auth.$context).authCookies.sessionData.name)
export const POST = withRequestLog('/api/rpc', createBrowserRpc({
  trustedBaseURL: appOrigin,
  authenticate: async headers => {
    const identity = await sessions.authenticate(headers)
    if (identity) noteLogUser(identity.session.user.id)
    return identity
  },
  scope: (identity, work) => sessions.scope(identity, work),
  actions: desktopActions,
  error: error => {
    if (error instanceof ActionFailureError) return { status: error.code === 'authRequired' ? 401 : 400, code: error.code }
    if (error instanceof WorkspaceError) return { status: 403, code: 'workspaceAccessDenied' }
    console.error('browser_rpc_failed', { name: error instanceof Error ? error.name : 'UnknownError' })
    return { status: 500, code: 'desktop_rpc_failed' }
  },
}))
