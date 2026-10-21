'use client'

import { useRouter } from '@/i18n/navigation'
import { Command, ListTodo, MonitorSmartphone } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { NavUser } from '@/components/nav-user'
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupLabel,
  SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarRail,
} from '@/components/ui/sidebar'
import { WORKSPACE_NAME } from '@/components/workspace/issue-properties'

/** The shell for the Device page: tasks and devices are the destinations. */
export function DevicesSidebar({ user, onSignOut, signingOut }: {
  user: { name: string; email: string }
  onSignOut: () => void
  signingOut: boolean
}) {
  const router = useRouter()
  const t = useTranslations('Nav')
  const commonT = useTranslations('Common')
  return (
    <Sidebar variant="inset" mobileTitle={t('sidebarTitle')} mobileDescription={t('sidebarDescription')} mobileCloseLabel={commonT('close')}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" onClick={() => router.push('/')} aria-label={t('workspaceAll', { name: WORKSPACE_NAME })}>
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                <Command className="size-4" />
              </div>
              <div className="flex flex-1 flex-col gap-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">{WORKSPACE_NAME}</span>
                <span className="truncate text-xs text-muted-foreground">{t('tagline')}</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>{t('workspaceArea')}</SidebarGroupLabel>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton tooltip={t('allIssues')} onClick={() => router.push('/')}>
                <ListTodo />
                <span>{t('allIssues')}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton tooltip={t('devices')} isActive onClick={() => router.push('/devices')}>
                <MonitorSmartphone />
                <span>{t('devices')}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={user} onSignOut={onSignOut} signingOut={signingOut} />
      </SidebarFooter>
      <SidebarRail label={t('toggleSidebar')} />
    </Sidebar>
  )
}
