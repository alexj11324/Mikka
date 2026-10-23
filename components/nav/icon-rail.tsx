'use client'

import { useTranslations } from 'next-intl'
import { Columns3, MessageSquare, Puzzle, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Sidebar } from '@/components/ui/sidebar'
import { WorkspaceMenu } from '@/components/workspace-menu'

export type RailDestination = 'conversations' | 'board' | 'plugins'

export const RAIL_ITEMS: { id: RailDestination; icon: LucideIcon; label: 'Nav.conversations' | 'Nav.board' | 'Nav.plugins' }[] = [
  { id: 'conversations', icon: MessageSquare, label: 'Nav.conversations' },
  { id: 'board', icon: Columns3, label: 'Nav.board' },
  { id: 'plugins', icon: Puzzle, label: 'Nav.plugins' },
]

type RailProps = {
  active: RailDestination | null
  onNavigate: (destination: RailDestination) => void
  user: { name: string; email: string; image?: string | null }
  onSettings: (href?: string) => void
  onSignOut: () => void
  signingOut: boolean
  onBeforeChange?: (action: () => Promise<void>) => void
}

/** The fixed 56px column at the far left (Codex style). It never collapses; the conversation list beside it does. */
export function IconRail({ active, onNavigate, ...menu }: RailProps) {
  const i18nText = useTranslations()
  // A non-collapsing Sidebar, as in shadcn's nested icon-rail pattern; phones get these items in the list footer.
  return <Sidebar collapsible="none" role="navigation" aria-label={i18nText('Nav.rail')} className="sticky top-0 z-20 hidden h-svh w-14 shrink-0 items-center gap-2 py-3 md:flex">
    {RAIL_ITEMS.map(item => <Tooltip key={item.id}>
      <TooltipTrigger render={<Button variant={active === item.id ? 'secondary' : 'ghost'} size="icon-lg" aria-label={i18nText(item.label)} aria-current={active === item.id ? 'page' : undefined} onClick={() => onNavigate(item.id)} />}><item.icon data-icon="inline-start" /></TooltipTrigger>
      <TooltipContent side="right">{i18nText(item.label)}</TooltipContent>
    </Tooltip>)}
    <div className="mt-auto"><WorkspaceMenu compact {...menu} /></div>
  </Sidebar>
}
