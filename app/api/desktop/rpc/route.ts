import { auth } from '@/lib/auth'
import { withRequestLog, noteLogUser } from '@/lib/request-log'
import { ActionFailureError } from '@/lib/action-error'
import { WorkspaceError } from '@/lib/workspace-error'
import { createDesktopRpc } from '@/lib/desktop-rpc/handler'
import { desktopActions } from '@/lib/desktop-rpc/registry'
import { withDesktopSession, withDesktopLocale, desktopRotatedToken } from '@/lib/desktop-rpc/session'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export const POST = withRequestLog('/api/desktop/rpc', createDesktopRpc({
  authenticate: async headers => {
    const session = await auth.api.getSession({ headers, query: { disableCookieCache: true } })
    if (session) noteLogUser(session.user.id)
    return session
  },
  scope: (session, work, request) => withDesktopLocale(request.headers.get('x-mikka-locale') === 'en' ? 'en' : 'zh-CN', () => withDesktopSession(session, async () => {
    const response = await work()
    const token = desktopRotatedToken()
    if (response.ok && token) response.headers.set('x-mikka-session-token', token)
    return response
  })),
  actions: desktopActions,
  error: error => {
    if (error instanceof ActionFailureError) return { status: error.code === 'authRequired' ? 401 : 400, code: error.code }
    if (error instanceof WorkspaceError) return { status: 403, code: 'workspaceAccessDenied' }
    console.error('desktop_rpc_failed', { name: error instanceof Error ? error.name : 'UnknownError' })
    return { status: 500, code: 'desktop_rpc_failed' }
  },
}))
