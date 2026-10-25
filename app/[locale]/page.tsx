import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { getLocale } from 'next-intl/server'

import { IssueWorkspace } from '@/components/workspace/issue-workspace'
import { redirect as localeRedirect } from '@/i18n/navigation'
import { isAcceptanceEnabled } from '@/lib/acceptance'
import { auth, googleEnabled } from '@/lib/auth'

export default async function Page({ searchParams }: { searchParams: Promise<{ acceptance?: string; issue?: string; section?: string; settings?: string }> }) {
  const query = await searchParams
  const initialSelected = query.issue && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(query.issue) ? query.issue : null
  const session = await auth.api.getSession({ headers: await headers() })
  const user = session?.user
  if (!user) {
    if (initialSelected) localeRedirect({ href: `/sign-in?next=${encodeURIComponent(`/?issue=${initialSelected}`)}`, locale: await getLocale() })
    if (!isAcceptanceEnabled()) localeRedirect({ href: '/sign-in', locale: await getLocale() })
    if (query.acceptance === '1') localeRedirect({ href: '/acceptance', locale: await getLocale() })
    redirect('/api/acceptance')
  }
  return <IssueWorkspace key={user.id} initialSelected={initialSelected} user={{ id: user.id, name: user.name, email: user.email, image: user.image }} initialSection={query.section === 'agent' || query.section === 'projects' ? query.section : 'coordinator'} initialSettingsSection={query.settings === 'integrations' ? 'integrations' : undefined} googleEnabled={googleEnabled} />
}
