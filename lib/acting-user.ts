import 'server-only'
import { cache } from 'react'
import { AsyncLocalStorage } from 'node:async_hooks'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { users } from '@/lib/db/schema'
import { getSession } from '@/lib/session'

// Who a server action acts for. Normally the signed-in session; an MCP tool,
// which has a verified OAuth token instead of a session cookie, runs the same
// actions inside `actAs` so they keep their own validation and access checks.

const actingUser = new AsyncLocalStorage<string>()

/** Runs `fn` with the actions acting for this user instead of the session's. */
export function actAs<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  return actingUser.run(userId, fn)
}

// React cache is scoped to one server render, so the lookup is shared only within a request.
const userById = cache(async (userId: string) => {
  const [user] = await db.select({ id: users.id, name: users.name, email: users.email, image: users.image }).from(users).where(eq(users.id, userId)).limit(1)
  return user ?? null
})

/** The user the current action acts for, or null when nobody is signed in. */
export async function currentUser(): Promise<{ id: string; name: string; email: string; image?: string | null } | null> {
  const userId = actingUser.getStore()
  if (userId) return userById(userId)
  return (await getSession())?.user ?? null
}
