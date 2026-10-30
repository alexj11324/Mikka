import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { mintDeviceEnrollment } from '@/lib/device-enrollment'

export async function POST(request: Request) {
  // This is a browser session endpoint, never a device-token endpoint.
  if (request.headers.get('origin') !== new URL(request.url).origin) return new Response(null, { status: 403 })
  const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } })
  if (!session?.user) return new Response(null, { status: 401 })
  return NextResponse.json({ token: await mintDeviceEnrollment(session.user.id) }, { headers: { 'Cache-Control': 'no-store' } })
}
