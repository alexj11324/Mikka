import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { getLocale, getTranslations } from 'next-intl/server'
import { auth } from '@/lib/auth'
import { InvitationCard } from '@/components/workspace/invitation-card'

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale()
  const t = await getTranslations({ locale, namespace: 'Metadata' })
  return { title: t('inviteTitle'), description: t('inviteDescription'), referrer: 'no-referrer' }
}

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const session = await auth.api.getSession({ headers: await headers() })
  return <main className="flex min-h-dvh items-center justify-center bg-muted/30 p-5"><InvitationCard token={/^[a-f0-9]{64}$/.test(token) ? token : ''} email={session?.user.email ?? null} /></main>
}
