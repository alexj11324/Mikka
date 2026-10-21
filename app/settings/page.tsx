import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getSession } from '@/lib/session'

export const metadata: Metadata = { title: '设置 · Orvilo3', description: '管理个人偏好、工作区、团队和成员。' }

export default async function SettingsPage() {
  if (!(await getSession())?.user) redirect('/sign-in?next=%2Fsettings')
  return null
}
