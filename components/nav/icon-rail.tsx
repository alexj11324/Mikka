'use client'

import { useTranslations } from 'next-intl'
import { Columns3, Copy, RectangleHorizontal, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Sidebar } from '@/components/ui/sidebar'
import { WorkspaceMenu } from '@/components/workspace-menu'

export type RailDestination = 'conversations' | 'board' | 'plugins'

// Drawn as in Figma 48:3: a rounded rectangle, a split panel, two stacked squares.
export const RAIL_ITEMS: { id: RailDestination; icon: LucideIcon; label: 'Nav.conversations' | 'Nav.board' | 'Nav.plugins' }[] = [
  { id: 'conversations', icon: RectangleHorizontal, label: 'Nav.conversations' },
  { id: 'board', icon: Columns3, label: 'Nav.board' },
  { id: 'plugins', icon: Copy, label: 'Nav.plugins' },
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

/** The fixed 56px column at the far left (Codex style), under the top bar. It never collapses; the conversation list beside it does. */
export function IconRail({ active, onNavigate, ...menu }: RailProps) {
  const i18nText = useTranslations()
  // A non-collapsing Sidebar, as in shadcn's nested icon-rail pattern; phones get these items in the list footer.
  return <Sidebar collapsible="none" role="navigation" aria-label={i18nText('Nav.rail')} className="sticky top-10 z-20 hidden h-[calc(100svh-2.5rem)] w-14 shrink-0 items-center gap-2 bg-shell-chrome pt-3 pb-4 md:flex">
    {RAIL_ITEMS.map(item => <Tooltip key={item.id}>
      <TooltipTrigger render={<Button variant={active === item.id ? 'secondary' : 'ghost'} size="icon-lg" className="size-10 rounded-xl" aria-label={i18nText(item.label)} aria-current={active === item.id ? 'page' : undefined} onClick={() => onNavigate(item.id)} />}><item.icon data-icon="inline-start" /></TooltipTrigger>
      <TooltipContent side="right">{i18nText(item.label)}</TooltipContent>
    </Tooltip>)}
    <div className="mt-auto"><WorkspaceMenu compact {...menu} /></div>
  </Sidebar>
}
