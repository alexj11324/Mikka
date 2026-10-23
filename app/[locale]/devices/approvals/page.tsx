import { headers } from 'next/headers'
import { getLocale } from 'next-intl/server'
import { auth } from '@/lib/auth'
import { redirect } from '@/i18n/navigation'
import { LocalComputerReviews } from '@/components/devices/local-computer-reviews'
export default async function DeviceApprovals() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) { redirect({ href: '/sign-in?next=%2Fdevices%2Fapprovals', locale: await getLocale() }); return null }
  return <main className="mx-auto flex max-w-2xl flex-col gap-4 p-4"><LocalComputerReviews /></main>
}
