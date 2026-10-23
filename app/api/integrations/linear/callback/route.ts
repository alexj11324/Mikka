import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { requireUser } from '@/lib/issue-access'
import { exchangeLinearCode, LINEAR_OAUTH_CALLBACK_PATH, LINEAR_OAUTH_STATE_COOKIE } from '@/lib/linear-sync/oauth'
import { withBasePath } from '@/lib/base-path'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  const url = new URL(request.url)
  const failure = new URL(withBasePath('/?linear=error'), url.origin)
  const cookieStore = await cookies()
  const redirect = (destination: URL) => {
    const response = NextResponse.redirect(destination)
    response.cookies.set(LINEAR_OAUTH_STATE_COOKIE, '', { httpOnly: true, sameSite: 'lax', secure: true, path: LINEAR_OAUTH_CALLBACK_PATH, maxAge: 0 })
    return response
  }
  if (url.searchParams.has('error')) return redirect(failure)
  const state = url.searchParams.get('state')
  const code = url.searchParams.get('code')
  if (!state || !code || state.length > 256 || code.length > 2048 || cookieStore.get(LINEAR_OAUTH_STATE_COOKIE)?.value !== state) return redirect(failure)
  try {
    const user = await requireUser()
    await exchangeLinearCode(state, code, user.id)
    return redirect(new URL(withBasePath('/?linear=connected'), url.origin))
  } catch {
    return redirect(failure)
  }
}
