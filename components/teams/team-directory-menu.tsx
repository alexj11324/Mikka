'use client'
import { useTranslations } from 'next-intl'

import { LogIn, LogOut, MoreHorizontal, Settings, SquareUserRound, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

type TeamMenuProps = {
  team: { id: string; name: string; role: string | null }
  pending: boolean
  navigate: (href: string) => void
  teamHref: (id: string, view?: 'general' | 'members') => string
  onMembership: (id: string, joined: boolean) => Promise<void>
}

export function TeamDirectoryMenu({ team, pending, navigate, teamHref, onMembership }: TeamMenuProps) {
  const i18nText = useTranslations();
  return <DropdownMenu>
    <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="icon-sm" aria-label={i18nText("FeatureCopy.c_681e1f0f", { value0: (team.name) })} disabled={pending} className="sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 data-popup-open:opacity-100" />}><MoreHorizontal /></DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="w-48">
      <DropdownMenuGroup>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger><Settings /><span lang="en">Settings</span></DropdownMenuSubTrigger>
          <DropdownMenuSubContent side="left" className="w-56">
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => navigate(teamHref(team.id))}><SquareUserRound /><span lang="en">Overview</span></DropdownMenuItem>
              <DropdownMenuItem onClick={() => navigate(teamHref(team.id, 'general'))}><Settings /><span lang="en">General</span></DropdownMenuItem>
              <DropdownMenuItem onClick={() => navigate(teamHref(team.id, 'members'))}><Users /><span lang="en">Members</span></DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuItem disabled={pending} onClick={() => void onMembership(team.id, !!team.role)}>{team.role ? <LogOut /> : <LogIn />}<span lang="en">{team.role ? 'Leave team…' : 'Join team'}</span></DropdownMenuItem>
      </DropdownMenuGroup>
    </DropdownMenuContent>
  </DropdownMenu>
}
