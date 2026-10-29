'use server'

import { headers } from 'next/headers'
import { z } from 'zod'
import { ActionFailureError, runAction } from '@/lib/action-error'
import type { ActionResult } from '@/lib/action-result'
import { auth } from '@/lib/auth'

const displayName = z.string().trim().min(1).max(80)

/** The person's own display name; the settings page shows and edits it. */
export async function updateDisplayName(name: string): Promise<ActionResult<{ name: string }>> {
  return runAction(async () => {
    const parsed = displayName.safeParse(name)
    if (!parsed.success) throw new ActionFailureError('validationNameRequired')
    const session = await auth.api.getSession({ headers: await headers() })
    if (!session?.user) throw new ActionFailureError('authRequired')
    await auth.api.updateUser({ body: { name: parsed.data }, headers: await headers() })
    return { name: parsed.data }
  })
}
