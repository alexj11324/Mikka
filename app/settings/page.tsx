import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getSession } from '@/lib/session'
import { WorkspaceApp } from '@/components/workspace-app'

export const metadata: Metadata = { title: '设置 · Orvilo3', description: '管理个人偏好、工作区、团队和成员。' }

export default async function SettingsPage() {
  const session = await getSession()
  if (!session?.user) redirect('/sign-in?next=%2Fsettings')
  return <WorkspaceApp user={session.user} />
}
