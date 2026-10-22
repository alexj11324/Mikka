import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getSession } from '@/lib/session'
import { loadTeamDirectory } from '@/app/actions/teams'
import { WorkspaceApp } from '@/components/workspace-app'
import { getTranslations } from 'next-intl/server'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Metadata')
  return { title: t('teamsTitle'), description: t('teamsDescription') }
}
export default async function TeamsPage({ searchParams }: { searchParams: Promise<{ workspace?: string; team?: string; create?: string; view?: string }> }) {
  const query = await searchParams
  const session = await getSession()
  if (!session?.user) redirect('/sign-in?next=%2Fsettings%2Fteams')
  const initial = await loadTeamDirectory(query.workspace).catch(() => null)
  return <WorkspaceApp user={session.user} initialTeams={initial ?? undefined} />
}
