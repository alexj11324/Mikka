import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { withBasePath } from '@/lib/base-path'
import { pool } from '@/lib/db'
import { withRequestLog } from '@/lib/request-log'
import { withTaskWorkspace } from '@/lib/task-workspace'
import { installPlatform, redeemSlackCode, SLACK_CALLBACK_PATH, SLACK_STATE_COOKIE } from '@/lib/slack/install-provider'
import { acceptInstall, consumeInstall } from '@/lib/slack/installation-store'

export const runtime = 'nodejs'
async function handle(request: Request) {
  const url = new URL(request.url),
    platform = installPlatform()
  const back = new URL(withBasePath('/?section=plugins&app=slack&installation=failed'), url.origin)
  const redirect = () => {
    const response = NextResponse.redirect(back)
    response.cookies.set(SLACK_STATE_COOKIE, '', {
      httpOnly: true,
      sameSite: 'lax',
      secure: url.protocol === 'https:',
      path: SLACK_CALLBACK_PATH,
      maxAge: 0,
    })
    response.headers.set('Cache-Control', 'no-store')
    response.headers.set('Referrer-Policy', 'no-referrer')
    return response
  }
  const state = url.searchParams.get('state') ?? '',
    code = url.searchParams.get('code')
  if (!platform || !/^[A-Za-z0-9_-]{43}$/.test(state) || (await cookies()).get(SLACK_STATE_COOKIE)?.value !== state)
    return redirect()
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return redirect()
  try {
    const workspace = await consumeInstall(pool, session.user.id, state, 'oauth')
    if (!workspace || !code || code.length > 2048 || url.searchParams.has('error')) return redirect()
    await withTaskWorkspace(session.user, workspace, async () => {
      const grant = await redeemSlackCode(platform, code)
      await acceptInstall(pool, session.user.id, workspace, grant)
    })
    back.searchParams.set('installation', 'connected')
    back.searchParams.set('workspaceId', workspace)
  } catch {
    /* The state is single-use. An installation conflict cannot overwrite a previous grant. */
  }
  return redirect()
}
export const GET = withRequestLog('/api/integrations/slack/callback', handle)
