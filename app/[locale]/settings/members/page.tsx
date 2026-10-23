import type { Metadata } from 'next'
import { getLocale, getTranslations } from 'next-intl/server'
import { googleEnabled } from '@/lib/auth'
import { getSession } from '@/lib/session'
import { loadWorkspaceSettings } from '@/lib/workspace-access'
import { MembersPageView } from '@/components/settings/members-page'
import { redirect } from '@/i18n/navigation'

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale()
  const t = await getTranslations({ locale, namespace: 'Metadata' })
  return { title: t('membersTitle'), description: t('membersDescription') }
}

export default async function MembersPage({ searchParams }: { searchParams: Promise<{ workspace?: string; invite?: string }> }) {
  const [query, locale, session] = await Promise.all([searchParams, getLocale(), getSession()])
  if (!session?.user) return redirect({ href: '/sign-in?next=%2Fsettings%2Fmembers', locale })
  const initialMembers = await loadWorkspaceSettings(query.workspace, session.user).catch(() => undefined)
  return <MembersPageView user={session.user} workspaceId={query.workspace} inviteInitially={query.invite === '1'} googleEnabled={googleEnabled} initialMembers={initialMembers} />
}
