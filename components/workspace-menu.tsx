'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { Check, ChevronDown } from 'lucide-react'
import { toast } from 'sonner'
import { authClient } from '@/lib/auth-client'
import { fetchSettingsData } from '@/lib/settings-data'
import type { WorkspaceSwitcher } from '@/lib/workspace-switcher'
import { switchWorkspace } from '@/app/actions/workspace'
import { WorkspaceAccessDialog } from '@/components/workspace/workspace-access-dialog'
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

function WorkspaceAvatar({ name }: { name: string }) {
  return <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-md bg-sidebar-primary text-xs font-semibold text-sidebar-primary-foreground">{name.slice(0, 1)}</span>
}

export function WorkspaceMenu({ user, onSettings, onSignOut, signingOut, onBeforeChange }: {
  user: { name: string; email: string; image?: string | null }
  onSettings: (href?: string) => void
  onSignOut: () => void
  signingOut: boolean
  onBeforeChange?: (action: () => Promise<void>) => void
}) {
  const { setOpenMobile } = useSidebar()
  const { data, error, mutate } = useSWR('/api/workspace/switcher', fetchSettingsData<WorkspaceSwitcher>, { shouldRetryOnError: false })
  const [accessOpen, setAccessOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const workspaceName = data?.workspace.name ?? '工作区'
  function settings(href = '/settings') {
    onSettings(href)
    setOpenMobile(false)
  }
  function run(action: () => Promise<void>) {
    if (pending || signingOut) return
    if (onBeforeChange) onBeforeChange(action)
    else void action()
  }
  function selectWorkspace(accountId: string, workspaceId?: string) {
    if (accountId === data?.accounts[0]?.id && workspaceId === data.workspace.id) return
    run(async () => {
      setPending(true)
      try {
        const result = await switchWorkspace({ accountId, workspaceId })
        if (!result.ok) { toast.error(result.error); return }
        window.location.assign('/')
      } catch { toast.error('切换未完成，请重试。') }
      finally { setPending(false) }
    })
  }
  function addAccount() {
    run(async () => {
      setPending(true)
      try {
        const session = await authClient.getSession({ query: { disableCookieCache: true } })
        if (session.error || !session.data?.user) throw new Error('Session unavailable')
        if ((data?.accounts.length ?? 0) >= 5) { toast.error('最多同时登录 5 个账户，请先退出不用的账户。'); return }
        window.location.assign('/sign-in?addAccount=1')
      } catch { toast.error('无法添加账户，请重试。') }
      finally { setPending(false) }
    })
  }
  return <>
    <DropdownMenu>
      <DropdownMenuTrigger render={<SidebarMenuButton aria-label="工作区菜单" className="h-10" />}>
        <WorkspaceAvatar name={workspaceName} />
        <span className="flex-1 truncate font-semibold">{workspaceName}</span>
        <ChevronDown />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64 max-w-[calc(100vw-1rem)]">
        <DropdownMenuGroup>
          <DropdownMenuItem className="min-h-9" onClick={() => settings()}>设置</DropdownMenuItem>
          <DropdownMenuItem className="min-h-9" onClick={() => settings('/settings/members')}>邀请和管理成员</DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="min-h-9">切换工作区</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-72 max-w-[calc(100vw-1rem)]">
              {data?.accounts.map(account => <DropdownMenuGroup key={account.id}>
                <DropdownMenuLabel className="truncate" title={account.email}>{account.email}</DropdownMenuLabel>
                {account.choices.map(workspace => <DropdownMenuItem key={workspace.id} className="min-h-10" disabled={pending || signingOut} aria-current={account.id === data.accounts[0].id && workspace.id === data.workspace.id ? 'true' : undefined} onClick={() => selectWorkspace(account.id, workspace.id)}>
                  <WorkspaceAvatar name={workspace.name} />
                  <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                  {account.id === data.accounts[0].id && workspace.id === data.workspace.id && <Check aria-hidden="true" />}
                </DropdownMenuItem>)}
                {!account.choices.length && <DropdownMenuItem className="min-h-9" disabled={pending || signingOut} onClick={() => selectWorkspace(account.id)}>进入此账户</DropdownMenuItem>}
              </DropdownMenuGroup>)}
              {!data && <DropdownMenuGroup>
                <DropdownMenuLabel className="truncate" title={user.email}>{user.email}</DropdownMenuLabel>
                {error ? <DropdownMenuItem className="min-h-9" onClick={() => void mutate()}>读取失败，点击重试</DropdownMenuItem> : <DropdownMenuLabel>正在读取工作区…</DropdownMenuLabel>}
              </DropdownMenuGroup>}
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel>账户</DropdownMenuLabel>
                <DropdownMenuItem className="min-h-9" disabled={pending || signingOut} onClick={() => run(async () => { setAccessOpen(true) })}>创建或加入工作区</DropdownMenuItem>
                <DropdownMenuItem className="min-h-9" disabled={pending || signingOut} onClick={addAccount}>添加账户</DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem className="min-h-9" onClick={onSignOut} disabled={signingOut || pending}>{signingOut ? '正在退出…' : '退出登录'}</DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
    {accessOpen && <WorkspaceAccessDialog open={accessOpen} onOpenChange={setAccessOpen} />}
  </>
}
