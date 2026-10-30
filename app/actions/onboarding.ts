'use server'

import { headers } from 'next/headers'
import { ActionFailureError } from '@/lib/action-error'
import { auth } from '@/lib/auth'
import { finishOnboarding } from '@/lib/onboarding'

/** The person finished or skipped the first-run guide; it does not come back. */
export async function completeOnboarding() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new ActionFailureError('authRequired')
  await finishOnboarding(session.user.id)
}
