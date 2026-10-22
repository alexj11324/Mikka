import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { getLocale } from 'next-intl/server'

import { listIssues } from '@/app/actions/issues'
import { IssueWorkspace } from '@/components/workspace/issue-workspace'
import { redirect as localeRedirect } from '@/i18n/navigation'
import { isAcceptanceEnabled } from '@/lib/acceptance'
import { auth } from '@/lib/auth'

export default async function Page({ searchParams }: { searchParams: Promise<{ acceptance?: string; issue?: string; settings?: string }> }) {
  const query = await searchParams
  const initialSelected = query.issue && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(query.issue) ? query.issue : null
  const initialSettingsSection = query.settings === 'devices' ? 'devices' as const : undefined
  const session = await auth.api.getSession({ headers: await headers() })
  const user = session?.user
  if (!user) {
    if (initialSelected) localeRedirect({ href: `/sign-in?next=${encodeURIComponent(`/?issue=${initialSelected}`)}`, locale: await getLocale() })
    if (initialSettingsSection) localeRedirect({ href: `/sign-in?next=${encodeURIComponent('/?settings=devices')}`, locale: await getLocale() })
    if (!isAcceptanceEnabled()) localeRedirect({ href: '/sign-in', locale: await getLocale() })
    if (query.acceptance === '1') localeRedirect({ href: '/acceptance', locale: await getLocale() })
    redirect('/api/acceptance')
  }
  const initialIssues = await listIssues()
  return <IssueWorkspace initialSelected={initialSelected} initialSettingsSection={initialSettingsSection} user={{ id: user.id, name: user.name, email: user.email, image: user.image }} initialIssues={initialIssues} />
}
