import { headers } from 'next/headers'
import { getLocale } from 'next-intl/server'

import { redirect } from '@/i18n/navigation'
import { auth } from '@/lib/auth'

export default async function DevicesPage() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) {
    redirect({ href: '/sign-in?next=%2Fdevices', locale: await getLocale() })
  }
  redirect({ href: '/?settings=devices', locale: await getLocale() })
}
