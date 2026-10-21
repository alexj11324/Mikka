import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { getLocale, getTranslations } from 'next-intl/server'

import { AuthForm } from '@/components/auth-form'
import { redirect } from '@/i18n/navigation'
import { auth, githubEnabled } from '@/lib/auth'
import { safeAuthReturn } from '@/lib/auth-return'

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale()
  const t = await getTranslations({ locale, namespace: 'Metadata' })
  return { title: t('signUpTitle'), description: t('signUpDescription') }
}

export default async function SignUpPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const query = await searchParams
  const next = safeAuthReturn(query.next)
  const session = await auth.api.getSession({ headers: await headers() })
  if (session?.user) redirect({ href: next, locale: await getLocale() })
  return <AuthForm next={next} mode="sign-up" githubEnabled={githubEnabled} />
}
