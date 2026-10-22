import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getSession } from '@/lib/session'
import { googleEnabled } from '@/lib/auth'
import { WorkspaceApp } from '@/components/workspace-app'
import { getTranslations } from 'next-intl/server'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Metadata')
  return { title: t('settingsTitle'), description: t('settingsDescription') }
}

export default async function SettingsPage() {
  const session = await getSession()
  if (!session?.user) redirect('/sign-in?next=%2Fsettings')
  return <WorkspaceApp user={session.user} googleEnabled={googleEnabled} />
}
