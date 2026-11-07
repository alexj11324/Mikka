'use client'
import { useTranslations } from 'next-intl'

import { useState } from 'react'
import { Check, ChevronDown, LogOut, Plus, Settings, UserPlus, type LucideIcon } from 'lucide-react'
import { useWorkspaceSwitcher } from '@/hooks/use-workspace-switcher'
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
import { useServerLabel } from '@/components/desktop/desktop-server'

/** The desktop adds each account's server when its accounts are on more than one (#1557). */
type AccountServer = { url: string; cloud: boolean; name: string | null }
function accountServer(account: object): AccountServer | null {
  const server = (account as { server?: unknown }).server
  return server && typeof server === 'object' && typeof (server as AccountServer).url === 'string' ? server as AccountServer : null
}

function WorkspaceAvatar({ name, large = false }: { name: string; large?: boolean }) {
  return <span aria-hidden="true" className={cn('flex shrink-0 items-center justify-center rounded-full bg-sidebar-primary-soft font-semibold text-sidebar-primary-soft-foreground', large ? 'size-8 text-sm' : 'size-6 text-xs')}>{name.slice(0, 1)}</span>
}

/** A workspace's mark inside the menu: the same soft initial as the trigger, in the 20px box every row's icon uses. */
function ItemAvatar({ name }: { name: string }) {
  // No `size`: `data-[size=sm]:size-6` outranks `size-5`, which put workspace names 4px right of the action rows.
  return <Avatar aria-hidden="true" className="size-5"><AvatarFallback className="bg-sidebar-primary-soft text-xs font-semibold text-sidebar-primary-soft-foreground">{name.slice(0, 1)}</AvatarFallback></Avatar>
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
  const serverLabel = useServerLabel()
  const { setOpenMobile } = useSidebar()
  const [menuOpen, setMenuOpen] = useState(false)
  const settingsShortcut = useShortcutLabel(['mod', ','])
  const { data, error, mutate, busy, knownName, workspaceName, selectWorkspace, addAccount, newWorkspace } = useWorkspaceSwitcher({ user, onSettings, signingOut, onBeforeChange, onShortcut: () => { setMenuOpen(false); setOpenMobile(false) } })
  function settings(href = '/settings') {
    onSettings(href)
    setOpenMobile(false)
  }
  return <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
    {compact ? <DropdownMenuTrigger render={<Button variant="ghost" size="icon-lg" aria-label={i18nText("Nav.workspaceMenu")} title={workspaceName} />}>
      <WorkspaceAvatar name={knownName} large />
      <span className="sr-only">{workspaceName}</span>
    </DropdownMenuTrigger> : <DropdownMenuTrigger render={<SidebarMenuButton aria-label={i18nText("Nav.workspaceMenu")} className="h-10" />}>
      <WorkspaceAvatar name={knownName} />
      <span className="flex-1 truncate font-semibold">{workspaceName}</span>
      <ChevronDown />
    </DropdownMenuTrigger>}
    {/* The rail's avatar sits at the window's bottom-left: the menu opens above it, never over it. */}
    <DropdownMenuContent aria-label={i18nText("Nav.workspaceMenu")} align="start" side={compact ? 'top' : 'bottom'} sideOffset={compact ? 8 : 4} className="w-60 max-w-[calc(100vw-1rem)]">
      {/* About five workspaces show; more scroll inside the menu. */}
      <div className="max-h-44 overflow-y-auto">
        {data?.accounts.map(account => <DropdownMenuGroup key={account.id}>
          {(() => {
            const server = accountServer(account)
            if (!server) return <DropdownMenuLabel className="truncate font-normal" title={account.email}>{account.email}</DropdownMenuLabel>
            const name = serverLabel({ ...server, version: null, accounts: 0, signIn: null })
            return <DropdownMenuLabel className="flex min-w-0 items-center gap-1.5 font-normal" title={`${account.email} · ${name}`}>
              <span className="min-w-0 truncate">{account.email}</span>
              <span className="shrink-0 truncate text-muted-foreground">{name}</span>
            </DropdownMenuLabel>
          })()}
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
        <DropdownMenuItem disabled={busy} onClick={() => newWorkspace(() => setOpenMobile(false))}>
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
