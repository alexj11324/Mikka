import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { isAcceptanceEnabled } from '@/lib/acceptance'
import { AcceptanceEntry } from '@/components/acceptance-entry'

export const metadata: Metadata = {
  title: '进入验收 · Orvilo2',
  description: '开发预览专用的独立验收工作台入口。',
  robots: { index: false, follow: false },
}

export default async function AcceptancePage() {
  if (!isAcceptanceEnabled()) notFound()
  const session = await auth.api.getSession({ headers: await headers() })
  if (session?.user) redirect('/')
  return <AcceptanceEntry />
}
