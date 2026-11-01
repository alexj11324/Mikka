import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { getLocale } from 'next-intl/server'

import type { OnboardingComputer } from '@/components/onboarding/onboarding'
import { IssueWorkspace } from '@/components/workspace/issue-workspace'
import { sectionFromQuery } from '@/components/workspace/workspace-navigation'
import { redirect as localeRedirect } from '@/i18n/navigation'
import { isAcceptanceEnabled } from '@/lib/acceptance'
import { safeAuthReturn } from '@/lib/auth-return'
import { auth, googleEnabled } from '@/lib/auth'
import { onboardingDone } from '@/lib/onboarding'
import { byoE2BKeyEnabled, getE2BKeyStatus } from '@/lib/secrets/e2b'
import { currentWorkspaceActor } from '@/lib/workspace-admin/current'

/** Whether the guide asks about the cloud computer: only while the person has no E2B key of their own (keys are personal). */
async function onboardingComputer(): Promise<OnboardingComputer> {
  if (!byoE2BKeyEnabled()) return 'none'
  const actor = await currentWorkspaceActor()
  if ((await getE2BKeyStatus(actor.userId, actor.workspaceId)).configured) return 'none'
  return 'ask'
}

export default async function Page({ searchParams }: { searchParams: Promise<{ acceptance?: string; issue?: string; section?: string; app?: string; settings?: string; google?: string }> }) {
  const query = await searchParams
  const initialSelected = query.issue && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(query.issue) ? query.issue : null
  const session = await auth.api.getSession({ headers: await headers() })
  const user = session?.user
  if (!user) {
    if (initialSelected) localeRedirect({ href: `/sign-in?next=${encodeURIComponent(`/?issue=${initialSelected}`)}`, locale: await getLocale() })
    if (query.section === 'plugins') localeRedirect({ href: `/sign-in?next=${encodeURIComponent(safeAuthReturn(`/?${new URLSearchParams({ section: 'plugins', ...(query.app ? { app: query.app } : {}) })}`))}`, locale: await getLocale() })
    if (!isAcceptanceEnabled()) localeRedirect({ href: '/sign-in', locale: await getLocale() })
    if (query.acceptance === '1') localeRedirect({ href: '/acceptance', locale: await getLocale() })
    redirect('/api/acceptance')
  }
  // A failed read must not lock anyone into the guide.
  const onboarding = !await onboardingDone(user.id).catch(() => true)
  const computer = onboarding ? await onboardingComputer().catch((): OnboardingComputer => 'none') : 'none'
  return <IssueWorkspace key={user.id} onboarding={onboarding ? { computer } : undefined} initialSelected={initialSelected} user={{ id: user.id, name: user.name, email: user.email, image: user.image }} initialSection={sectionFromQuery(query.section)} initialSettingsSection={query.settings === 'account' || (query.settings === 'integrations' && query.google) ? 'account' : query.settings === 'integrations' ? 'integrations' : undefined} googleEnabled={googleEnabled} />
}
