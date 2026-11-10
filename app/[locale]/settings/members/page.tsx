import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { getLocale, getTranslations } from 'next-intl/server'
import { auth, googleEnabled } from '@/lib/auth'
import { MembersPageView } from '@/components/settings/members-page'
import { redirect } from '@/i18n/navigation'
import { authorizedCacheWorkspace } from '@/lib/swr/cache-scope'
import { enterprisePrincipal } from '@/lib/enterprise/principal'

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale()
  const t = await getTranslations({ locale, namespace: 'Metadata' })
  return { title: t('membersTitle'), description: t('membersDescription') }
}

export default async function MembersPage({ searchParams }: { searchParams: Promise<{ workspace?: string; invite?: string }> }) {
  const query = await searchParams
  const locale = await getLocale()
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) return redirect({ href: '/sign-in?next=%2Fsettings%2Fmembers', locale })
  const cacheWorkspace = await authorizedCacheWorkspace({ id: session.user.id, [enterprisePrincipal]: { kind: 'session', sessionId: session.session.id } }, query.workspace)
  return <MembersPageView user={session.user} cacheWorkspace={cacheWorkspace} workspaceId={query.workspace} inviteInitially={query.invite === '1'} googleEnabled={googleEnabled} />
}
