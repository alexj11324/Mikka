import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { withRequestLog } from '@/lib/request-log'
import { officialWebOriginAllowed } from '@/lib/web-connection/policy'
import { webAuthHeaders, webBearer } from '@/lib/web-connection/auth-server'

export const dynamic = 'force-dynamic'
async function handlePOST(request: Request) {
  if (!officialWebOriginAllowed(request.headers.get('origin'))) return NextResponse.json({ error: 'web_auth_forbidden' }, { status: 403, headers: webAuthHeaders })
  const token = webBearer(request)
  if (!token) return NextResponse.json({ error: 'web_auth_session_expired' }, { status: 401, headers: webAuthHeaders })
  const { internalAdapter } = await auth.$context
  const session = await internalAdapter.findSession(token)
  if (!session || session.session.expiresAt.getTime() <= Date.now()) return NextResponse.json({ error: 'web_auth_session_expired' }, { status: 401, headers: webAuthHeaders })
  await internalAdapter.deleteSession(token)
  return new NextResponse(null, { status: 204, headers: webAuthHeaders })
}
export const POST = withRequestLog('/api/web/revoke', handlePOST)
