import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { SettingsPreview } from '@/components/settings/settings-preview'

export const metadata: Metadata = {
  title: '设置预览 · Orvilo3',
  description: '无需登录的设置界面预览，使用演示资料。',
  robots: { index: false, follow: false },
}

export default async function PreviewSettingsPage({ searchParams }: { searchParams: Promise<{ workspace?: string; invite?: string }> }) {
  const query = await searchParams
  if (process.env.NODE_ENV === 'development' && query.workspace === undefined && query.invite === undefined) return <SettingsPreview />
  const params = new URLSearchParams()
  if (typeof query.workspace === 'string') params.set('workspace', query.workspace)
  if (query.invite === '1') params.set('invite', '1')
  const suffix = params.toString()
  redirect(`/settings/members${suffix ? `?${suffix}` : ''}`)
}
