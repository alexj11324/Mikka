'use server'

import { headers } from 'next/headers'
import { ActionFailureError, runAction } from '@/lib/action-error'
import type { ActionResult } from '@/lib/action-result'
import { auth } from '@/lib/auth'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import type { ActivityFilter } from '@/lib/settings/activity-cursor'
import { activityFor, type ActivityPage } from '@/lib/settings/activity'
import { deleteSavedLoginFor, replaceLoginPasswordFor, saveLoginFor, savedLoginUsage, savedLogins, type SavedLogin, type SavedLoginInput, type SavedLoginUse } from '@/lib/settings/saved-logins'

// Settings > saved logins and activity. Every read and write is scoped to the
// signed-in person; ids from the client are only ever matched with that owner.

async function getUser() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new ActionFailureError('authRequired')
  return session.user
}

async function getUserId(): Promise<string> {
  return (await getUser()).id
}

/** The person's saved logins: site, account and last use. Never a secret. */
export async function listSavedLogins(): Promise<ActionResult<{ logins: SavedLogin[] }>> {
  return runAction(async () => ({ logins: await savedLogins(await getUserId()) }))
}

/** The signed-in person as the vault's actor; audit rows go to their current workspace. */
async function getActor() {
  const user = await getUser()
  const context = await loadWorkspaceContext(undefined, user)
  return { userId: user.id, workspaceId: context.workspace.id, auditActor: { type: 'user' as const, id: user.id, name: user.name || user.id } }
}

/** Revokes one saved login; the broker can no longer fill it. */
export async function deleteSavedLogin(id: string): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => deleteSavedLoginFor(await getActor(), id))
}

/** Adds (or replaces) a login from settings. Returns the id and canonical site, never the password. */
export async function saveSavedLogin(input: SavedLoginInput): Promise<ActionResult<{ id: string; site: string }>> {
  return runAction(async () => saveLoginFor(await getActor(), input))
}

/** A new password for one of the person's saved logins. */
export async function replaceSavedLoginPassword(id: string, password: string): Promise<ActionResult<{ id: string; site: string }>> {
  return runAction(async () => replaceLoginPasswordFor(await getActor(), id, password))
}

/** Recent uses of one saved login: when, which Bot, which thread, result. */
export async function listSavedLoginUsage(id: string): Promise<ActionResult<{ uses: SavedLoginUse[] }>> {
  return runAction(async () => ({ uses: await savedLoginUsage(await getUserId(), id) }))
}

/** One page of the activity timeline, newest first. Pass `nextCursor` back for the next page. */
export async function listActivity(input: { filter?: ActivityFilter; cursor?: string | null; limit?: number } = {}): Promise<ActionResult<ActivityPage>> {
  return runAction(async () => activityFor(await getUserId(), input))
}
