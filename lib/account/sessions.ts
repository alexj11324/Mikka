import 'server-only'
import { pool } from '@/lib/db'
import { describeUserAgent } from './user-agent'

/** One signed-in device in 「登录设备」. The session token never leaves the server. */
export interface SignedInDevice {
  id: string
  /** 'Chrome · macOS', 'Mikka · iPhone'; null when the User-Agent says nothing recognisable. */
  label: string | null
  client: string | null
  os: string | null
  app: boolean
  current: boolean
  createdAt: string
  /**
   * When the session was last refreshed. Better Auth refreshes a session at most
   * once a day (lib/auth.ts session.updateAge), so this is accurate to a day.
   */
  lastActiveAt: string
}

interface SessionRow { id: string; userAgent: string | null; createdAt: Date; updatedAt: Date }

/** The person's unexpired sessions, the current one first, then the most recently active. */
export async function listSignedInDevices(userId: string, currentSessionId: string): Promise<SignedInDevice[]> {
  const { rows } = await pool.query<SessionRow>(
    `select id, "userAgent", "createdAt", "updatedAt" from session
     where "userId" = $1 and "expiresAt" > now()
     order by (id = $2) desc, "updatedAt" desc`,
    [userId, currentSessionId],
  )
  return rows.map(row => {
    const device = describeUserAgent(row.userAgent)
    return {
      id: row.id, ...device, current: row.id === currentSessionId,
      createdAt: row.createdAt.toISOString(), lastActiveAt: row.updatedAt.toISOString(),
    }
  })
}

/** The token of one of the person's own sessions, so Better Auth can revoke it; null for anyone else's. */
export async function sessionTokenFor(userId: string, sessionId: string): Promise<string | null> {
  const { rows } = await pool.query<{ token: string }>('select token from session where id = $1 and "userId" = $2 limit 1', [sessionId, userId])
  return rows[0]?.token ?? null
}
