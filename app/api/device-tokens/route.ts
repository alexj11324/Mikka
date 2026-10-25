import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { pool } from '@/lib/db'

export const dynamic = 'force-dynamic'

/** Status/readback after an uncertain revoke response. Never return hashes. */
export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } })
  if (!session?.user) return NextResponse.json({ error: 'authRequired' }, { status: 401 })
  const result = await pool.query('SELECT id,name,"createdAt","lastUsedAt","revokedAt","revokedBy" FROM device_tokens WHERE "userId"=$1 ORDER BY "createdAt",id', [session.user.id])
  return NextResponse.json({ credentials: result.rows }, { headers: { 'Cache-Control': 'private, no-store' } })
}
