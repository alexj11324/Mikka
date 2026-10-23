import { redirect } from 'next/navigation'
import { getLocale } from 'next-intl/server'

import { IssueWorkspace } from '@/components/workspace/issue-workspace'
import { redirect as localeRedirect } from '@/i18n/navigation'
import { isAcceptanceEnabled } from '@/lib/acceptance'
import { googleEnabled } from '@/lib/auth'
import { getSession } from '@/lib/session'
import { loadWorkspaceHome } from '@/lib/workspace-home'

export default async function Page({ searchParams }: { searchParams: Promise<{ acceptance?: string; issue?: string; section?: string; settings?: string }> }) {
  const [query, session] = await Promise.all([searchParams, getSession()])
  const initialSelected = query.issue && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(query.issue) ? query.issue : null
  const user = session?.user
  if (!user) {
    if (initialSelected) localeRedirect({ href: `/sign-in?next=${encodeURIComponent(`/?issue=${initialSelected}`)}`, locale: await getLocale() })
    if (!isAcceptanceEnabled()) localeRedirect({ href: '/sign-in', locale: await getLocale() })
    if (query.acceptance === '1') localeRedirect({ href: '/acceptance', locale: await getLocale() })
    redirect('/api/acceptance')
  }
  const section = query.section === 'agent' ? 'agent' : 'projects'
  const home = section === 'agent' ? null : await loadWorkspaceHome()
  return <IssueWorkspace key={user.id} initialSelected={initialSelected} initialIssues={home?.issues} initialProjects={home?.projects} initialTeams={home?.teams} user={{ id: user.id, name: user.name, email: user.email, image: user.image }} initialSection={section} initialSettingsSection={query.settings === 'integrations' ? 'integrations' : undefined} googleEnabled={googleEnabled} />
}
