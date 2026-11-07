import { withDatabaseOperation } from '@/lib/db/egress-sample'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getSession } from '@/lib/session'
import { googleEnabled } from '@/lib/auth'
import { WorkspaceApp } from '@/components/workspace-app'
import { getTranslations } from 'next-intl/server'
import { authorizedCacheWorkspace } from '@/lib/swr/cache-scope'
import { enterprisePrincipal } from '@/lib/enterprise/principal'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Metadata')
  return { title: t('settingsTitle'), description: t('settingsDescription') }
}

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ workspace?: string }> }) {
  return withDatabaseOperation('/pages/settings', async () => {
    const query = await searchParams
    const session = await getSession()
    if (!session?.user) redirect('/sign-in?next=%2Fsettings')
    const cacheWorkspace = await authorizedCacheWorkspace({ id: session.user.id, [enterprisePrincipal]: { kind: 'session', sessionId: session.session.id } }, query.workspace)
    return <WorkspaceApp user={session.user} cacheWorkspace={cacheWorkspace} googleEnabled={googleEnabled} />
  })
}
