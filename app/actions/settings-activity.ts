'use server'

import { headers } from 'next/headers'
import { ActionFailureError, runAction } from '@/lib/action-error'
import type { ActionResult } from '@/lib/action-result'
import { auth } from '@/lib/auth'
import type { ActivityFilter } from '@/lib/settings/activity-cursor'
import { activityFor, type ActivityPage } from '@/lib/settings/activity'
import { deleteSavedLoginFor, savedLoginUsage, savedLogins, type SavedLogin, type SavedLoginUse } from '@/lib/settings/saved-logins'

// Settings > saved logins and activity. Every read and write is scoped to the
// signed-in person; ids from the client are only ever matched with that owner.

async function getUserId(): Promise<string> {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new ActionFailureError('authRequired')
  return session.user.id
}

/** The person's saved logins: site, account and last use. Never a secret. */
export async function listSavedLogins(): Promise<ActionResult<{ logins: SavedLogin[] }>> {
  return runAction(async () => ({ logins: await savedLogins(await getUserId()) }))
}

/** Revokes one saved login; the broker can no longer fill it. */
export async function deleteSavedLogin(id: string): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => deleteSavedLoginFor(await getUserId(), id))
}

/** Recent uses of one saved login: when, which Bot, which thread, result. */
export async function listSavedLoginUsage(id: string): Promise<ActionResult<{ uses: SavedLoginUse[] }>> {
  return runAction(async () => ({ uses: await savedLoginUsage(await getUserId(), id) }))
}

/** One page of the activity timeline, newest first. Pass `nextCursor` back for the next page. */
export async function listActivity(input: { filter?: ActivityFilter; cursor?: string | null; limit?: number } = {}): Promise<ActionResult<ActivityPage>> {
  return runAction(async () => activityFor(await getUserId(), input))
}
