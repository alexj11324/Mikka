import { z } from 'zod'
import { pool } from '@/lib/db'
import { forbiddenOrigin, json, unauthorized, writeAllowed } from '@/lib/mobile-api'
import { pushSession, removePushBinding, withPushSession } from '@/lib/mobile-push-session'


const changes = z.object({ label: z.string().trim().min(1).max(80) }).strict()

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await pushSession(request)
  if (!session) return unauthorized()
  if (!writeAllowed(request)) return forbiddenOrigin()
  const { id } = await params
  const body = changes.safeParse(await request.json().catch(() => null))
  if (!z.uuid().safeParse(id).success || !body.success) return json({ error: 'invalidRequest' }, 400)
  return withPushSession(session, async () => {
    const { rows } = await pool.query<{ id: string; label: string }>(
      `UPDATE mobile_push_tokens
          SET label = $4, "updatedAt" = CASE WHEN label IS DISTINCT FROM $4 THEN clock_timestamp() ELSE "updatedAt" END
        WHERE id = $1 AND "userId" = $2 AND "sessionId" = $3
        RETURNING id, label`,
      [id, session.userId, session.sessionId, body.data.label])
    return rows[0] ? json(rows[0]) : json({ error: 'installationUnavailable' }, 404)
  })
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await pushSession(request)
  if (!session) return unauthorized()
  if (!writeAllowed(request)) return forbiddenOrigin()
  const { id } = await params
  if (!z.uuid().safeParse(id).success) return json({ error: 'invalidRequest' }, 400)
  return removePushBinding(session, { id })
}
