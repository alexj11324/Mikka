import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { getLocale, getTranslations } from 'next-intl/server'
import { auth } from '@/lib/auth'
import { loadWorkspaceSettings } from '@/lib/workspace-access'
import { MembersSettings } from '@/components/workspace/members-settings'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Link, redirect } from '@/i18n/navigation'

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale()
  const t = await getTranslations({ locale, namespace: 'Metadata' })
  return { title: t('membersTitle'), description: t('membersDescription') }
}

export default async function MembersPage({ searchParams }: { searchParams: Promise<{ workspace?: string; invite?: string }> }) {
  const query = await searchParams
  const locale = await getLocale()
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect({ href: '/sign-in?next=%2Fsettings%2Fmembers', locale })
  const initial = await loadWorkspaceSettings(query.workspace).catch(() => null)
  if (!initial) {
    const t = await getTranslations({ locale, namespace: 'Members' })
    return <main className="mx-auto flex max-w-lg flex-col gap-6 p-8"><Alert variant="destructive"><AlertTitle>{t('noAccessTitle')}</AlertTitle><AlertDescription>{t('noAccessDescription')}</AlertDescription></Alert><Link href="/settings/members" className="underline underline-offset-4">{t('backToAccessible')}</Link></main>
  }
  return <MembersSettings initial={initial} inviteInitially={query.invite === '1'} />
}
