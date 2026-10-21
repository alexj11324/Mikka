import { getLocale } from 'next-intl/server'

import { redirect } from '@/i18n/navigation'

export default async function DashboardPage() {
  redirect({ href: '/', locale: await getLocale() })
}
