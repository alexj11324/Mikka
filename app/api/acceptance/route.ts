import { randomBytes, randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { isAcceptanceEnabled } from '@/lib/acceptance'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  if (!isAcceptanceEnabled()) return new NextResponse(null, { status: 404 })

  const destination = new URL('/?acceptance=1', request.url)
  try {
    const session = await auth.api.getSession({ headers: request.headers })
    if (session?.user) return NextResponse.redirect(new URL('/', request.url))

    const result = await auth.api.signUpEmail({
      headers: request.headers,
      asResponse: true,
      body: {
        name: 'Acceptance Guest',
        email: `acceptance-${randomUUID()}@preview.orvilo.invalid`,
        password: randomBytes(32).toString('base64url'),
      },
    })
    const cookies = result.headers.getSetCookie()
    if (!result.ok || cookies.length === 0) throw new Error('Acceptance session unavailable')

    const response = NextResponse.redirect(destination)
    response.headers.set('Cache-Control', 'no-store')
    for (const cookie of cookies) response.headers.append('Set-Cookie', cookie)
    return response
  } catch {
    console.error('Unable to start the development acceptance session')
    return NextResponse.redirect(new URL('/acceptance', request.url))
  }
}
