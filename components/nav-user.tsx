"use client"

import {
  Avatar,
  AvatarFallback,
} from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { ChevronsUpDownIcon, Languages, LogOutIcon, Moon, Sun } from "lucide-react"
import { useTheme } from 'next-themes'
import { useLocale, useTranslations } from 'next-intl'

import { usePathname, useRouter } from '@/i18n/navigation'

export function NavUser({
  user, onSignOut, signingOut,
}: {
  user: { name: string; email: string }
  onSignOut: () => void
  signingOut: boolean
}) {
  const { isMobile } = useSidebar()
  const { resolvedTheme, setTheme } = useTheme()
  const locale = useLocale()
  const pathname = usePathname()
  const router = useRouter()
  const t = useTranslations('Nav')
  function switchLocale() {
    const target = locale === 'en' ? 'zh-CN' : 'en'
    router.replace(`${pathname}${window.location.search}${window.location.hash}`, { locale: target })
  }
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton size="lg" aria-label={t('accountMenu')} className="aria-expanded:bg-muted" />
            }
          >
            <Avatar>
              <AvatarFallback>{(user.name || user.email).slice(0, 2).toUpperCase()}</AvatarFallback>
            </Avatar>
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">{user.name}</span>
              <span className="truncate text-xs">{user.email}</span>
            </div>
            <ChevronsUpDownIcon className="ml-auto" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="min-w-56"
            side={isMobile ? "bottom" : "right"}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel className="p-0 font-normal">
                <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                  <Avatar>
                    <AvatarFallback>{(user.name || user.email).slice(0, 2).toUpperCase()}</AvatarFallback>
                  </Avatar>
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-medium">{user.name}</span>
                    <span className="truncate text-xs">{user.email}</span>
                  </div>
                </div>
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}>
                {resolvedTheme === 'dark' ? <Sun /> : <Moon />}{t('toggleTheme')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={switchLocale} aria-label={t('switchLanguage')}>
                <Languages />{locale === 'en' ? '中文' : 'English'}{/* i18n-ignore: language names stay native */}
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={onSignOut} disabled={signingOut}>
                <LogOutIcon />{signingOut ? t('signingOut') : t('signOut')}
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
