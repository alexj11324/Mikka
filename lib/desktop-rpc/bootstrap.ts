import 'server-only'
import { cookies, headers } from 'next/headers'
import { workspaceSelection } from '@/lib/workspace-selection'
import { withFreshSession } from '@/lib/fresh-session'
import { auth, googleEnabled, githubSignInEnabled } from '@/lib/auth'
import { emailSignInEnabled } from '@/lib/email-sign-in'
import { onboardingDone } from '@/lib/onboarding'
import { byoE2BKeyEnabled, getE2BKeyStatus } from '@/lib/secrets/e2b'
import { currentWorkspaceActor } from '@/lib/workspace-admin/current'
import { readWorkspaceLink } from '@/lib/workspace-admin/links'
import { ActionFailureError } from '@/lib/action-error'
import { authorizedCacheWorkspace } from '@/lib/swr/cache-scope'
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
  // The renderer shows this profile. A signed session may still contain a name edited on another device.
  const session = await withFreshSession(desktopSession)
  if (!session) throw new ActionFailureError('authRequired')
  const [config, onboarding, cacheWorkspace] = await Promise.all([desktopConfig(session.user.id), onboardingDone(session.user.id).then(done => !done).catch(() => false),
    authorizedCacheWorkspace({ id: session.user.id, [enterprisePrincipal]: { kind: 'session', sessionId: session.session.id } }, workspaceId),
  ])
  let computer: 'none' | 'ask' = 'none'
  if (onboarding && byoE2BKeyEnabled()) {
    computer = await currentWorkspaceActor().then(async actor => (await getE2BKeyStatus(actor.userId, actor.workspaceId)).configured ? 'none' as const : 'ask' as const).catch(() => 'none' as const)
  }
  const value = { ...session, ...config, onboarding, computer, cacheWorkspace }
  if (!workspaceId) return value
  // A requested cache namespace alone does not select the workspace used by ordinary task reads.
  const selection = workspaceSelection(await headers())
  const selected = selection.present ? selection.workspaceId : (await cookies()).get('mikka-workspace')?.value
  return { ...value, requestedWorkspaceSelected: selected === workspaceId }
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
