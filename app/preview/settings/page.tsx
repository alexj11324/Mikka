import type { Metadata } from 'next'
import { SettingsPreview } from '@/components/settings/settings-preview'

export const metadata: Metadata = {
  title: '设置预览 · Orvilo3',
  description: '无需登录的设置界面预览，使用演示资料。',
  robots: { index: false, follow: false },
}

export default function SettingsPreviewPage() {
  return <SettingsPreview />
}
