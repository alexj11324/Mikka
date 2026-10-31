'use client'
import { useTranslations } from 'next-intl'

import { useEffect, useState } from 'react'
import useSWR from 'swr'
import { Check, ChevronDown, LogOut, Plus, Settings, UserPlus, type LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import { authClient } from '@/lib/auth-client'
import { withBasePath } from '@/lib/base-path'
import { fetchSettingsData } from '@/lib/settings-data'
import type { WorkspaceSwitcher } from '@/lib/workspace-switcher'
import { switchWorkspace } from '@/app/actions/workspace'
import { useShortcutLabel } from '@/components/shortcut-keys'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { SidebarMenuButton, useSidebar } from '@/components/ui/sidebar'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

function WorkspaceAvatar({ name, large = false }: { name: string; large?: boolean }) {
  return <span aria-hidden="true" className={cn('flex shrink-0 items-center justify-center rounded-full bg-sidebar-primary-soft font-semibold text-sidebar-primary-soft-foreground', large ? 'size-8 text-sm' : 'size-6 text-xs')}>{name.slice(0, 1)}</span>
}

/** A workspace's mark inside the menu: the same soft initial as the trigger, at item size. */
function ItemAvatar({ name }: { name: string }) {
  return <Avatar size="sm" aria-hidden="true" className="size-5"><AvatarFallback className="bg-sidebar-primary-soft text-xs font-semibold text-sidebar-primary-soft-foreground">{name.slice(0, 1)}</AvatarFallback></Avatar>
}

/** An action row's icon, in a 20px box like the workspace avatars so every row's text starts on one column. */
function ItemIcon({ icon: Icon }: { icon: LucideIcon }) {
  return <span aria-hidden="true" className="flex size-5 items-center justify-center text-muted-foreground"><Icon /></span>
}

/**
 * The account menu behind the avatar, in the style of Linear's and Notion's:
 * one flat list (no submenu) of the signed-in accounts' workspaces, then
 * 设置, then 添加账户 and 退出登录. Switching workspaces lives only here.
 */
export function WorkspaceMenu({ user, onSettings, onSignOut, signingOut, onBeforeChange, compact = false }: {
  user: { name: string; email: string; image?: string | null }
  /** Avatar only, for the icon rail. */
  compact?: boolean
  onSettings: (href?: string) => void
  onSignOut: () => void
  signingOut: boolean
  onBeforeChange?: (action: () => Promise<void>) => void
}) {
  const i18nText = useTranslations();
  const { setOpenMobile } = useSidebar()
  const { data, error, mutate } = useSWR('/api/workspace/switcher', fetchSettingsData<WorkspaceSwitcher>, { shouldRetryOnError: false })
  const [menuOpen, setMenuOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const settingsShortcut = useShortcutLabel(['mod', ','])
  const workspaceName = data?.workspace.name ?? i18nText("Settings.groups.workspace")
  const busy = pending || signingOut
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (event.isComposing || event.keyCode === 229 || event.repeat || pending || signingOut || event.altKey || event.shiftKey) return
      if (!(event.ctrlKey || event.metaKey) || event.code !== 'Comma') return
      if (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="alertdialog"]')) return
      event.preventDefault()
      setMenuOpen(false)
      onSettings('/settings')
      setOpenMobile(false)
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [onSettings, pending, setOpenMobile, signingOut])
  function settings(href = '/settings') {
    onSettings(href)
    setOpenMobile(false)
  }
  function run(action: () => Promise<void>) {
    if (busy) return
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
      } catch { toast.error(i18nText("FeatureCopy.c_b8e346ef")) }
      finally { setPending(false) }
    })
  }
  function addAccount() {
    run(async () => {
      setPending(true)
      try {
        const session = await authClient.getSession({ query: { disableCookieCache: true } })
        if (session.error || !session.data?.user) throw new Error('Session unavailable')
        if ((data?.accounts.length ?? 0) >= 5) { toast.error(i18nText("FeatureCopy.c_a2a50802")); return }
        window.location.assign(withBasePath('/sign-in?addAccount=1'))
      } catch { toast.error(i18nText("FeatureCopy.c_c9988ff5")) }
      finally { setPending(false) }
    })
  }
  return <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
    {compact ? <DropdownMenuTrigger render={<Button variant="ghost" size="icon-lg" aria-label={i18nText("Nav.workspaceMenu")} title={workspaceName} />}>
      <WorkspaceAvatar name={workspaceName} large />
      <span className="sr-only">{workspaceName}</span>
    </DropdownMenuTrigger> : <DropdownMenuTrigger render={<SidebarMenuButton aria-label={i18nText("Nav.workspaceMenu")} className="h-10" />}>
      <WorkspaceAvatar name={workspaceName} />
      <span className="flex-1 truncate font-semibold">{workspaceName}</span>
      <ChevronDown />
    </DropdownMenuTrigger>}
    {/* The rail's avatar sits at the window's bottom-left: the menu opens above it, never over it. */}
    <DropdownMenuContent aria-label={i18nText("Nav.workspaceMenu")} align="start" side={compact ? 'top' : 'bottom'} sideOffset={compact ? 8 : 4} className="w-60 max-w-[calc(100vw-1rem)]">
      {/* About five workspaces show; more scroll inside the menu. */}
      <div className="max-h-44 overflow-y-auto">
        {data?.accounts.map(account => <DropdownMenuGroup key={account.id}>
          <DropdownMenuLabel className="truncate font-normal" title={account.email}>{account.email}</DropdownMenuLabel>
          {account.choices.map(workspace => {
            const current = account.id === data.accounts[0].id && workspace.id === data.workspace.id
            return <DropdownMenuItem key={workspace.id} disabled={busy} aria-current={current ? 'true' : undefined} onClick={() => selectWorkspace(account.id, workspace.id)}>
              <ItemAvatar name={workspace.name} />
              <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
              {current && <Check aria-hidden="true" />}
            </DropdownMenuItem>
          })}
          {!account.choices.length && <DropdownMenuItem disabled={busy} onClick={() => selectWorkspace(account.id)}>{i18nText("FeatureCopy.c_c352c6e7")}</DropdownMenuItem>}
        </DropdownMenuGroup>)}
        {!data && <DropdownMenuGroup>
          <DropdownMenuLabel className="truncate font-normal" title={user.email}>{user.email}</DropdownMenuLabel>
          {error ? <DropdownMenuItem onClick={() => void mutate()}>{i18nText("FeatureCopy.c_e3d18d12")}</DropdownMenuItem> : <DropdownMenuLabel className="font-normal">{i18nText("FeatureCopy.c_5d885f0b")}</DropdownMenuLabel>}
        </DropdownMenuGroup>}
      </div>
      <DropdownMenuGroup>
        <DropdownMenuItem disabled={busy} onClick={() => run(async () => { setOpenMobile(false); window.location.assign(withBasePath('/workspaces/new')) })}>
          <ItemIcon icon={Plus} />{i18nText("FeatureCopy.c_d92d1b8d")}
        </DropdownMenuItem>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuItem aria-keyshortcuts="Control+, Meta+," onClick={() => settings()}>
          <ItemIcon icon={Settings} />{i18nText("Settings.title")}<DropdownMenuShortcut aria-hidden="true" className="tracking-normal">{settingsShortcut}</DropdownMenuShortcut>
        </DropdownMenuItem>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuItem disabled={busy} onClick={addAccount}><ItemIcon icon={UserPlus} />{i18nText("FeatureCopy.c_c771c7d8")}</DropdownMenuItem>
        <DropdownMenuItem onClick={onSignOut} disabled={busy}><ItemIcon icon={LogOut} />{signingOut ? i18nText("Nav.signingOut") : i18nText("Nav.signOut")}</DropdownMenuItem>
      </DropdownMenuGroup>
    </DropdownMenuContent>
  </DropdownMenu>
}
