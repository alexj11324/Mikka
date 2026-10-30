import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { getLocale } from 'next-intl/server'

import { IssueWorkspace } from '@/components/workspace/issue-workspace'
import { redirect as localeRedirect } from '@/i18n/navigation'
import { isAcceptanceEnabled } from '@/lib/acceptance'
import { safeAuthReturn } from '@/lib/auth-return'
import { auth, googleEnabled } from '@/lib/auth'
import { onboardingDone } from '@/lib/onboarding'

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
  return <IssueWorkspace key={user.id} onboarding={onboarding} initialSelected={initialSelected} user={{ id: user.id, name: user.name, email: user.email, image: user.image }} initialSection={query.section === 'agent' || query.section === 'projects' || query.section === 'plugins' || query.section === 'suggestions' || query.section === 'artifacts' ? query.section : 'coordinator'} initialSettingsSection={query.settings === 'account' || (query.settings === 'integrations' && query.google) ? 'account' : query.settings === 'integrations' ? 'integrations' : undefined} googleEnabled={googleEnabled} />
}
