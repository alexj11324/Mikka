import 'server-only'
import { cache } from 'react'
import { noteLogUser } from '@/lib/request-log'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { users } from '@/lib/db/schema'
import { actingContext, type ActivityActor } from '@/lib/activity-actor'
import { getSession } from '@/lib/session'
import { tokenWorkspace } from '@/lib/tokens/principal'

// Who a server action acts for. Normally the signed-in session; an MCP tool,
// which has a verified OAuth token instead of a session cookie, runs the same
// actions inside `actAs` so they keep their own validation and access checks.

/**
 * Runs `fn` with the actions acting for this user instead of the session's.
 * `actor` is who issue history records as making the change (an MCP agent).
 * Pass an API route's session user, not its id, so a workspace token keeps its scope.
 */
export function actAs<T>(user: string | { id: string; [tokenWorkspace]?: string }, fn: () => Promise<T>, actor?: ActivityActor): Promise<T> {
  if (typeof user === 'string') return actingContext.run({ userId: user, actor }, fn)
  return actingContext.run({ userId: user.id, actor, tokenWorkspaceId: user[tokenWorkspace] }, fn)
}

// React cache is scoped to one server render, so the lookup is shared only within a request.
const userById = cache(async (userId: string) => {
  const [user] = await db.select({ id: users.id, name: users.name, email: users.email, image: users.image }).from(users).where(eq(users.id, userId)).limit(1)
  return user ?? null
})

/** The user the current action acts for, or null when nobody is signed in. */
export async function currentUser(): Promise<{ id: string; name: string; email: string; image?: string | null } | null> {
  const acting = actingContext.getStore()
  if (acting) {
    noteLogUser(acting.userId)
    const user = await userById(acting.userId)
    if (!user || !acting.tokenWorkspaceId) return user
    // The workspace resolver and task lookups read the token's scope from the user, as on an API session user.
    return Object.defineProperty({ ...user }, tokenWorkspace, { value: acting.tokenWorkspaceId })
  }
  const user = (await getSession())?.user ?? null
  noteLogUser(user?.id)
  return user
}
