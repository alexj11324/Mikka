import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { pool } from '@/lib/db'
import { z } from 'zod'

/** Owner-visible identifiers let the existing device settings revoke a token
 * and recover its recorded device associations without returning credentials.
 * Tombstones remain linked so a later owner read can identify prior cleanup. */
export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } })
  if (!session?.user) return NextResponse.json({ error: 'authRequired' }, { status: 401 })
  const cursors = new URL(request.url).searchParams.getAll('cursor')
  if (cursors.length > 1 || cursors.length === 1 && !z.uuid().safeParse(cursors[0]).success) {
    return NextResponse.json({ error: 'validationGeneric', detail: 'cursor_invalid' }, { status: 400 })
  }
  const cursor = cursors[0] ?? null
  // Keep the original timestamp-desc/id-asc order. Resolve the owner-bound
  // anchor inside PostgreSQL so sub-millisecond timestamps stay exact.
  const result = await pool.query(`WITH anchor AS (
      SELECT "createdAt" AS at,id FROM device_tokens WHERE "userId"=$1 AND id=$2::uuid
    ) SELECT t.id,t.name,t."createdAt",t."lastUsedAt",t."expiresAt",t."revokedAt",t."revokedBy",t."boundDeviceId",
      ARRAY(SELECT d.id FROM (
        SELECT b."deviceId" AS id FROM device_token_devices b WHERE b."tokenId"=t.id AND b."userId"=t."userId"
        UNION SELECT t."boundDeviceId" WHERE t."boundDeviceId" IS NOT NULL
      ) linked JOIN devices d ON d.id=linked.id AND d."ownerId"=t."userId" ORDER BY d.id) AS "deviceIds"
    FROM device_tokens t LEFT JOIN anchor a ON true WHERE t."userId"=$1
      AND ($2::uuid IS NULL OR t."createdAt" < a.at OR (t."createdAt"=a.at AND t.id > a.id))
    ORDER BY t."createdAt" DESC,t.id LIMIT 101`, [session.user.id, cursor])
  if (cursor && !result.rows.length) {
    const anchor = await pool.query('SELECT 1 FROM device_tokens WHERE "userId"=$1 AND id=$2', [session.user.id, cursor])
    if (!anchor.rowCount) return NextResponse.json({ error: 'validationGeneric', detail: 'cursor_unknown' }, { status: 400 })
  }
  const tokens = result.rows.slice(0, 100)
  return NextResponse.json({ tokens, nextCursor: result.rows.length > 100 ? tokens.at(-1)!.id : null },
    { headers: { 'Cache-Control': 'private, no-store' } })
}
