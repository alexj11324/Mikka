import { NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { pool } from '@/lib/db'
import { revokeDeviceCredential } from '@/lib/device-revocation'

export const dynamic = 'force-dynamic'

/** Owner session only; daemon bearers cannot revoke credentials. */
export async function POST(request: Request, { params }: { params: Promise<{ tokenId: string }> }) {
  if (request.headers.has('cookie')) {
    try {
      if (new URL(request.headers.get('origin') ?? '').origin !== new URL(request.url).origin)
        return NextResponse.json({ error: 'originRejected' }, { status: 403 })
    } catch { return NextResponse.json({ error: 'originRejected' }, { status: 403 }) }
  }
  const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } })
  if (!session?.user) return NextResponse.json({ error: 'authRequired' }, { status: 401 })
  const { tokenId } = await params
  if (!z.uuid().safeParse(tokenId).success) return NextResponse.json({ error: 'unknownCredential' }, { status: 404 })
  const result = await revokeDeviceCredential(pool, session.user.id, tokenId)
  if (!result) return NextResponse.json({ error: 'unknownCredential' }, { status: 404 })
  return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } })
}
