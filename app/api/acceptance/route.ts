import { randomBytes, randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { isAcceptanceEnabled } from '@/lib/acceptance'

export const dynamic = 'force-dynamic'

function redirectWithinPreview(path: '/' | '/?acceptance=1' | '/acceptance') {
  // NextRequest.url can contain the internal 0.0.0.0 origin behind the preview proxy.
  return new NextResponse(null, { status: 307, headers: { Location: path, 'Cache-Control': 'no-store' } })
}

export async function GET(request: NextRequest) {
  if (!isAcceptanceEnabled()) return new NextResponse(null, { status: 404 })

  try {
    const session = await auth.api.getSession({ headers: request.headers })
    if (session?.user) return redirectWithinPreview('/')

    const result = await auth.api.signUpEmail({
      headers: request.headers,
      asResponse: true,
      body: {
        name: '验收访客',
        email: `acceptance-${randomUUID()}@preview.orvilo.invalid`,
        password: randomBytes(32).toString('base64url'),
      },
    })
    const cookies = result.headers.getSetCookie()
    if (!result.ok || cookies.length === 0) throw new Error('Acceptance session unavailable')

    const response = redirectWithinPreview('/?acceptance=1')
    for (const cookie of cookies) response.headers.append('Set-Cookie', cookie)
    return response
  } catch {
    console.error('Unable to start the development acceptance session')
    return redirectWithinPreview('/acceptance')
  }
}
