import { freshSessionRoute } from '@/lib/fresh-session'
import { NextResponse } from 'next/server'
import { auth } from '@/lib/api-auth'
import { auth as browserAuth } from '@/lib/auth'
import { mintDeviceEnrollment } from '@/lib/device-enrollment'
import { pool } from '@/lib/db'

/** The desktop main process checks its daemon against this session's devices.
 * Account ownership is personal; changing workspace does not change this set. */
export async function GET(request: Request) {
  const session = await browserAuth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } })
  if (!session?.user) return new Response(null, { status: 401 })
  const { rows } = await pool.query<{ id: string }>('SELECT id::text AS id FROM devices WHERE "ownerId"=$1 AND kind=\'local\' AND "removedAt" IS NULL', [session.user.id])
  return NextResponse.json({ ownerId: session.user.id, deviceIds: rows.map(row => row.id) }, { headers: { 'Cache-Control': 'private, no-store' } })
}

async function POSTBody(request: Request) {
  // This is a browser session endpoint, never a device-token endpoint.
  if (request.headers.get('origin') !== new URL(request.url).origin) return new Response(null, { status: 403 })
  const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } })
  if (!session?.user) return new Response(null, { status: 401 })
  return NextResponse.json({ token: await mintDeviceEnrollment(session.user.id) }, { headers: { 'Cache-Control': 'no-store' } })
}

// Credentials, permissions, money and deletion: the session is read from the database, not the cookie cache.
export const POST = freshSessionRoute(POSTBody)
