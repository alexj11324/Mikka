import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { pool } from '@/lib/db'

/** Owner-visible identifiers let the existing device settings revoke a token
 * without ever returning its hash or credential value. */
export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } })
  if (!session?.user) return NextResponse.json({ error: 'authRequired' }, { status: 401 })
  const result = await pool.query(`SELECT id,name,"createdAt","lastUsedAt","expiresAt","revokedAt","revokedBy","boundDeviceId"
    FROM device_tokens WHERE "userId"=$1 ORDER BY "createdAt" DESC,id LIMIT 100`, [session.user.id])
  return NextResponse.json({ tokens: result.rows }, { headers: { 'Cache-Control': 'private, no-store' } })
}
