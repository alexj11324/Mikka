import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { InvitationCard } from '@/components/workspace/invitation-card'

export const metadata: Metadata = { title: '接受工作区邀请 · Orvilo3', description: '使用受邀邮箱登录并安全加入 Orvilo3 工作区。', referrer: 'no-referrer' }

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const session = await auth.api.getSession({ headers: await headers() })
  return <main className="flex min-h-dvh items-center justify-center bg-muted/30 p-5"><InvitationCard token={/^[a-f0-9]{64}$/.test(token) ? token : ''} email={session?.user.email ?? null} /></main>
}
