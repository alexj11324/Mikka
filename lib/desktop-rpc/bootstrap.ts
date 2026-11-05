import 'server-only'
import { headers } from 'next/headers'
import { auth, googleEnabled, githubEnabled } from '@/lib/auth'
import { emailSignInEnabled } from '@/lib/email-sign-in'
import { onboardingDone } from '@/lib/onboarding'
import { byoE2BKeyEnabled, getE2BKeyStatus } from '@/lib/secrets/e2b'
import { currentWorkspaceActor } from '@/lib/workspace-admin/current'
import { ActionFailureError } from '@/lib/action-error'
import { safeDesktopSession } from './session'
import type { DesktopBootstrap, DesktopConfig } from './wire'

export async function desktopConfig(): Promise<DesktopConfig> {
  return { googleEnabled, githubEnabled, emailEnabled: await emailSignInEnabled() }
}

export async function desktopSession() {
  const session = await auth.api.getSession({ headers: await headers() })
  return session ? safeDesktopSession(session) : null
}

export async function desktopBootstrap(): Promise<DesktopBootstrap> {
  const session = await desktopSession()
  if (!session) throw new ActionFailureError('authRequired')
  const [config, onboarding] = await Promise.all([desktopConfig(), onboardingDone(session.user.id).then(done => !done).catch(() => false)])
  let computer: 'none' | 'ask' = 'none'
  if (onboarding && byoE2BKeyEnabled()) {
    computer = await currentWorkspaceActor().then(async actor => (await getE2BKeyStatus(actor.userId, actor.workspaceId)).configured ? 'none' as const : 'ask' as const).catch(() => 'none' as const)
  }
  return { ...session, ...config, onboarding, computer }
}

export async function desktopAccounts() {
  const accounts = await auth.api.listUserAccounts({ headers: await headers() })
  return accounts.map(account => ({ id: account.id, providerId: account.providerId }))
}
