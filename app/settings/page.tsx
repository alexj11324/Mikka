import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'

export const metadata: Metadata = { title: '设置 · Orvilo3', description: '管理个人偏好、工作区、团队和成员。' }

export default async function SettingsPage() {
  if (!(await auth.api.getSession({ headers: await headers() }))?.user) redirect('/sign-in?next=%2Fsettings')
  return null
}
