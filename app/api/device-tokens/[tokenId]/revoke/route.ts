import { NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { pool } from '@/lib/db'
import { revokeDeviceCredential } from '@/lib/device-revocation'

export const dynamic = 'force-dynamic'

/** Only the owner's normal application session can revoke a credential. */
export async function POST(request: Request, { params }: { params: Promise<{ tokenId: string }> }) {
  if (request.headers.get('origin') !== new URL(request.url).origin) return NextResponse.json({ error: 'originRejected' }, { status: 403 })
  const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } })
  if (!session?.user) return NextResponse.json({ error: 'authRequired' }, { status: 401 })
  const { tokenId } = await params
  if (!z.uuid().safeParse(tokenId).success) return NextResponse.json({ error: 'unknownCredential' }, { status: 404 })
  const receipt = await revokeDeviceCredential(pool, session.user.id, tokenId)
  return receipt ? NextResponse.json(receipt, { headers: { 'Cache-Control': 'private, no-store' } })
    : NextResponse.json({ error: 'unknownCredential' }, { status: 404 })
}
