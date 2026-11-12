import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { withBasePath } from '@/lib/base-path'
import { pool } from '@/lib/db'
import { withRequestLog } from '@/lib/request-log'
import { withTaskWorkspace } from '@/lib/task-workspace'
import { authorizeSlack, installPlatform, SLACK_CALLBACK_PATH, SLACK_INSTALL_RETURN_PATH, SLACK_STATE_COOKIE } from '@/lib/slack/install-provider'
import { consumeInstall, startInstall } from '@/lib/slack/installation-store'

export const runtime = 'nodejs'
const path = '/api/integrations/slack/connect'
async function handle(request: Request) {
  const url = new URL(request.url),
    intent = url.searchParams.get('intent') ?? ''
  const platform = installPlatform()
  const back = new URL(SLACK_INSTALL_RETURN_PATH, url.origin)
  if (!platform || !/^[A-Za-z0-9_-]{43}$/.test(intent)) return NextResponse.redirect(back)
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) {
    const next = path + '?intent=' + encodeURIComponent(intent)
    return NextResponse.redirect(new URL(withBasePath('/sign-in?next=' + encodeURIComponent(next)), url.origin))
  }
  try {
    const workspace = await consumeInstall(pool, session.user.id, intent, 'handoff')
    if (!workspace) return NextResponse.redirect(back)
    const state = await withTaskWorkspace(session.user, workspace, () =>
      startInstall(pool, session.user.id, workspace, 'oauth'),
    )
    const response = NextResponse.redirect(authorizeSlack(platform, state))
    response.cookies.set(SLACK_STATE_COOKIE, state, {
      httpOnly: true,
      secure: new URL(platform.redirect).protocol === 'https:',
      sameSite: 'lax',
      path: SLACK_CALLBACK_PATH,
      maxAge: 600,
    })
    response.headers.set('Cache-Control', 'no-store')
    response.headers.set('Referrer-Policy', 'no-referrer')
    return response
  } catch {
    return NextResponse.redirect(back)
  }
}
export const GET = withRequestLog(path, handle)
