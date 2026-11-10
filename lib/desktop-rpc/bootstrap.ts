import 'server-only'
import { headers } from 'next/headers'
import { auth, googleEnabled, githubSignInEnabled } from '@/lib/auth'
import { emailSignInEnabled } from '@/lib/email-sign-in'
import { onboardingDone } from '@/lib/onboarding'
import { byoE2BKeyEnabled, getE2BKeyStatus } from '@/lib/secrets/e2b'
import { currentWorkspaceActor } from '@/lib/workspace-admin/current'
import { readWorkspaceLink } from '@/lib/workspace-admin/links'
import { ActionFailureError } from '@/lib/action-error'
import { authorizedBootstrapScopes } from '@/lib/swr/cache-scope'
import { enterprisePrincipal } from '@/lib/enterprise/principal'
import { safeDesktopSession } from './session'
import { desktopFeatures } from './features'
import { getEdition } from '@/lib/edition'
import type { DesktopBootstrap, DesktopConfig } from './wire'

export async function desktopConfig(userId?: string): Promise<DesktopConfig> {
  const [emailEnabled, features, githubEnabled] = await Promise.all([emailSignInEnabled(), desktopFeatures(userId), githubSignInEnabled()])
  return { edition: getEdition(), googleEnabled, githubEnabled, emailEnabled, features, daemonPackageName: process.env.NEXT_PUBLIC_MIKKA_DAEMON_PACKAGE_NAME ?? '@aspectlylabs/mikka' }
}

export async function desktopSession() {
  const session = await auth.api.getSession({ headers: await headers() })
  return session ? safeDesktopSession(session) : null
}

export async function desktopBootstrap(workspaceId?: string): Promise<DesktopBootstrap> {
  const session = await desktopSession()
  if (!session) throw new ActionFailureError('authRequired')
  const [config, onboarding, scopes] = await Promise.all([desktopConfig(session.user.id), onboardingDone(session.user.id).then(done => !done).catch(() => false),
    authorizedBootstrapScopes({ id: session.user.id, [enterprisePrincipal]: { kind: 'session', sessionId: session.session.id } }, workspaceId),
  ])
  let computer: 'none' | 'ask' = 'none'
  if (onboarding && byoE2BKeyEnabled()) {
    computer = await currentWorkspaceActor().then(async actor => (await getE2BKeyStatus(actor.userId, actor.workspaceId)).configured ? 'none' as const : 'ask' as const).catch(() => 'none' as const)
  }
  return { ...session, ...config, onboarding, computer, cacheWorkspace: scopes.cacheWorkspace, liveHomeWorkspaceId: scopes.liveHomeWorkspaceId }
}

export async function desktopAccounts() {
  const accounts = await auth.api.listUserAccounts({ headers: await headers() })
  return accounts.map(account => ({ id: account.id, providerId: account.providerId }))
}

export async function desktopWorkspaceLink(slug: string) {
  const session = await desktopSession()
  if (!session) throw new ActionFailureError('authRequired')
  return readWorkspaceLink(session.user.id, slug)
}
