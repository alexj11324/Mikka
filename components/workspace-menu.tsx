'use client'

import { Check, ChevronDown, Moon, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'
import { UserAvatar } from '@/components/user-avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { SidebarMenuButton, useSidebar } from '@/components/ui/sidebar'
import { WORKSPACE_NAME } from '@/components/workspace/issue-properties'

function WorkspaceAvatar() {
  return <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-md bg-sidebar-primary text-xs font-semibold text-sidebar-primary-foreground">{WORKSPACE_NAME.slice(0, 1)}</span>
}

export function WorkspaceMenu({ user, onSettings, onSignOut, signingOut }: {
  user: { name: string; email: string; image?: string | null }
  onSettings: (href?: string) => void
  onSignOut: () => void
  signingOut: boolean
}) {
  const { setOpenMobile } = useSidebar()
  const { resolvedTheme, setTheme } = useTheme()
  function settings(href = '/settings') {
    onSettings(href)
    setOpenMobile(false)
  }
  return <DropdownMenu>
    <DropdownMenuTrigger render={<SidebarMenuButton aria-label="工作区菜单" className="h-10" />}>
      <WorkspaceAvatar />
      <span className="flex-1 truncate font-semibold">{WORKSPACE_NAME}</span>
      <ChevronDown />
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="w-72 max-w-[calc(100vw-1rem)]">
      <DropdownMenuGroup>
        <DropdownMenuItem className="min-h-9" onClick={() => settings()}>设置</DropdownMenuItem>
        <DropdownMenuItem className="min-h-9" onClick={() => settings('/settings/members')}>邀请和管理成员</DropdownMenuItem>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger className="min-h-9">工作区与账户</DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="w-72 max-w-[calc(100vw-1rem)]">
          <DropdownMenuGroup>
            <DropdownMenuLabel className="truncate" title={user.email}>{user.email}</DropdownMenuLabel>
            <DropdownMenuItem className="min-h-10" aria-label={`${WORKSPACE_NAME} 工作区设置，当前工作区`} onClick={() => settings('/settings?section=workspace')}>
              <WorkspaceAvatar />
              <span className="truncate">{WORKSPACE_NAME}</span>
              <Check className="ml-auto" aria-hidden="true" />
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel>账户</DropdownMenuLabel>
            <DropdownMenuItem className="min-h-12" aria-label="个人资料" onClick={() => settings('/settings?section=profile')}>
              <UserAvatar user={user} />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{user.name || user.email}</span>
                <span className="truncate text-muted-foreground">{user.email}</span>
              </div>
            </DropdownMenuItem>
            <DropdownMenuItem className="min-h-9" onClick={() => settings('/settings?section=preferences')}>偏好设置</DropdownMenuItem>
            <DropdownMenuItem className="min-h-9" onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}>
              {resolvedTheme === 'dark' ? <Sun /> : <Moon />}切换明暗主题
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      </DropdownMenuGroup>
      <DropdownMenuGroup>
        <DropdownMenuItem className="min-h-9" onClick={onSignOut} disabled={signingOut}>{signingOut ? '正在退出…' : '退出登录'}</DropdownMenuItem>
      </DropdownMenuGroup>
    </DropdownMenuContent>
  </DropdownMenu>
}
