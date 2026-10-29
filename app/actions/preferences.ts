'use server'

import { headers } from 'next/headers'
import { ActionFailureError, runAction } from '@/lib/action-error'
import type { ActionResult } from '@/lib/action-result'
import { auth } from '@/lib/auth'
import { preferencesPatch, readPreferences, savePreferences, type Preferences } from '@/lib/preferences'

async function currentUserId(): Promise<string> {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new ActionFailureError('authRequired')
  return session.user.id
}

/** The notification and 记忆 settings the web Settings page shows (D16). */
export async function getPreferences(): Promise<Preferences> {
  return readPreferences(await currentUserId())
}

export async function updatePreferences(patch: unknown): Promise<ActionResult<Preferences>> {
  return runAction(async () => savePreferences(await currentUserId(), preferencesPatch.parse(patch)))
}
