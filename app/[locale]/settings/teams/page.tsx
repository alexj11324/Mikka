import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getSession } from '@/lib/session'
import { googleEnabled } from '@/lib/auth'
import { loadTeamDirectory } from '@/app/actions/teams'
import { WorkspaceApp } from '@/components/workspace-app'
import { getTranslations } from 'next-intl/server'
import { authorizedCacheWorkspace } from '@/lib/swr/cache-scope'
import { enterprisePrincipal } from '@/lib/enterprise/principal'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Metadata')
  return { title: t('teamsTitle'), description: t('teamsDescription') }
}
export default async function TeamsPage({ searchParams }: { searchParams: Promise<{ workspace?: string; team?: string; create?: string; view?: string }> }) {
  const query = await searchParams
  const session = await getSession()
  if (!session?.user) redirect('/sign-in?next=%2Fsettings%2Fteams')
  const initial = await loadTeamDirectory(query.workspace).catch(() => null)
  const cacheWorkspace = await authorizedCacheWorkspace({ id: session.user.id, [enterprisePrincipal]: { kind: 'session', sessionId: session.session.id } }, query.workspace)
  return <WorkspaceApp user={session.user} cacheWorkspace={cacheWorkspace} initialTeams={initial ?? undefined} googleEnabled={googleEnabled} />
}
