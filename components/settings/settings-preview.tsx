'use client'

import { useRouter } from 'next/navigation'
import { SettingsView } from '@/components/settings/settings-view'
import { SidebarProvider } from '@/components/ui/sidebar'

export function SettingsPreview() {
  const router = useRouter()
  return (
    <div className="flex min-h-svh flex-col">
      <div role="status" className="border-b bg-muted px-4 py-2 text-center text-xs text-muted-foreground">
        设置预览 · 当前为演示资料，未登录，不会读取或修改真实账户数据。
      </div>
      <SidebarProvider className="min-h-[calc(100svh-2.125rem)]">
        <SettingsView
          user={{ name: '预览用户', email: 'preview@example.com' }}
          onBack={() => router.push('/sign-in')}
          onSignOut={() => router.push('/sign-in')}
          signingOut={false}
          accountError=""
        />
      </SidebarProvider>
    </div>
  )
}
