'use client'
import { useTranslations } from 'next-intl'

import { useEffect, useState } from 'react'
import useSWR from 'swr'
import { Check, ChevronDown } from 'lucide-react'
import { toast } from 'sonner'
import { authClient } from '@/lib/auth-client'
import { withBasePath } from '@/lib/base-path'
import { fetchSettingsData } from '@/lib/settings-data'
import type { WorkspaceSwitcher } from '@/lib/workspace-switcher'
import { switchWorkspace } from '@/app/actions/workspace'
import { ShortcutKeys } from '@/components/shortcut-keys'
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
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

function WorkspaceAvatar({ name, large = false }: { name: string; large?: boolean }) {
  return <span aria-hidden="true" className={cn('flex shrink-0 items-center justify-center rounded-full bg-sidebar-primary-soft font-semibold text-sidebar-primary-soft-foreground', large ? 'size-8 text-sm' : 'size-6 text-xs')}>{name.slice(0, 1)}</span>
}

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
  const workspaceName = data?.workspace.name ?? i18nText("Settings.sections.workspace.title")
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
  return <>
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      {compact ? <DropdownMenuTrigger render={<Button variant="ghost" size="icon-lg" aria-label={i18nText("Nav.workspaceMenu")} title={workspaceName} />}>
        <WorkspaceAvatar name={workspaceName} large />
        <span className="sr-only">{workspaceName}</span>
      </DropdownMenuTrigger> : <DropdownMenuTrigger render={<SidebarMenuButton aria-label={i18nText("Nav.workspaceMenu")} className="h-10" />}>
        <WorkspaceAvatar name={workspaceName} />
        <span className="flex-1 truncate font-semibold">{workspaceName}</span>
        <ChevronDown />
      </DropdownMenuTrigger>}
      <DropdownMenuContent align="start" side={compact ? 'right' : undefined} className="w-64 max-w-[calc(100vw-1rem)]">
        <DropdownMenuGroup>
          <DropdownMenuItem className="min-h-9" aria-label={i18nText("Settings.title")} aria-keyshortcuts="Control+, Meta+," onClick={() => settings()}><span className="flex-1">{i18nText("Settings.title")}</span><ShortcutKeys keys={['mod', ',']} aria-hidden="true" /></DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="min-h-9">{i18nText("FeatureCopy.c_646c2b4f")}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-72 max-w-[calc(100vw-1rem)]">
              {data?.accounts.map(account => <DropdownMenuGroup key={account.id}>
                <DropdownMenuLabel className="truncate" title={account.email}>{account.email}</DropdownMenuLabel>
                {account.choices.map(workspace => <DropdownMenuItem key={workspace.id} className="min-h-10" disabled={pending || signingOut} aria-current={account.id === data.accounts[0].id && workspace.id === data.workspace.id ? 'true' : undefined} onClick={() => selectWorkspace(account.id, workspace.id)}>
                  <WorkspaceAvatar name={workspace.name} />
                  <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                  {account.id === data.accounts[0].id && workspace.id === data.workspace.id && <Check aria-hidden="true" />}
                </DropdownMenuItem>)}
                {!account.choices.length && <DropdownMenuItem className="min-h-9" disabled={pending || signingOut} onClick={() => selectWorkspace(account.id)}>{i18nText("FeatureCopy.c_c352c6e7")}</DropdownMenuItem>}
              </DropdownMenuGroup>)}
              {!data && <DropdownMenuGroup>
                <DropdownMenuLabel className="truncate" title={user.email}>{user.email}</DropdownMenuLabel>
                {error ? <DropdownMenuItem className="min-h-9" onClick={() => void mutate()}>{i18nText("FeatureCopy.c_e3d18d12")}</DropdownMenuItem> : <DropdownMenuLabel>{i18nText("FeatureCopy.c_5d885f0b")}</DropdownMenuLabel>}
              </DropdownMenuGroup>}
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel>{i18nText("FeatureCopy.c_c3d92b20")}</DropdownMenuLabel>
                <DropdownMenuItem className="min-h-9" disabled={pending || signingOut} onClick={() => run(async () => { setOpenMobile(false); window.location.assign(withBasePath('/workspaces/new')) })}>{i18nText("FeatureCopy.c_d92d1b8d")}</DropdownMenuItem>
                <DropdownMenuItem className="min-h-9" disabled={pending || signingOut} onClick={addAccount}>{i18nText("FeatureCopy.c_c771c7d8")}</DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem className="min-h-9" onClick={onSignOut} disabled={signingOut || pending}>{signingOut ? i18nText("Nav.signingOut") : i18nText("Nav.signOut")}</DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  </>
}
