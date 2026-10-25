'use client'

import { useTranslations } from 'next-intl'
import { Columns3, Copy, House, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sidebar } from '@/components/ui/sidebar'
import { WorkspaceMenu } from '@/components/workspace-menu'

export type RailDestination = 'conversations' | 'board' | 'plugins'

// 主页 (the agent conversations), the board, plugins.
export const RAIL_ITEMS: { id: RailDestination; icon: LucideIcon; label: 'Nav.home' | 'Nav.board' | 'Nav.plugins' }[] = [
  { id: 'conversations', icon: House, label: 'Nav.home' },
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

/** The 56px icon column on the window's gray frame, left of the card (Comma's shell). It never collapses; the conversation list inside the card does. */
export function IconRail({ active, onNavigate, ...menu }: RailProps) {
  const i18nText = useTranslations()
  // A non-collapsing Sidebar, as in shadcn's nested icon-rail pattern; phones get these items in the list footer.
  return <Sidebar collapsible="none" role="navigation" aria-label={i18nText('Nav.rail')} className="hidden h-full w-14 shrink-0 items-center gap-1 bg-transparent pt-1 pb-1 md:flex">
    {/* Icon over its name (Comma / Codex style); the name makes a tooltip unnecessary. */}
    {RAIL_ITEMS.map(item => <Button key={item.id} variant="ghost" className="h-auto w-12 flex-col gap-1 rounded-lg px-0 py-1.5 text-xs font-normal text-muted-foreground hover:bg-background/70 hover:text-foreground aria-[current=page]:bg-background aria-[current=page]:text-foreground aria-[current=page]:shadow-xs" aria-current={active === item.id ? 'page' : undefined} onClick={() => onNavigate(item.id)}>
      <item.icon data-icon="inline-start" />
      <span>{i18nText(item.label)}</span>
    </Button>)}
    <div className="mt-auto"><WorkspaceMenu compact {...menu} /></div>
  </Sidebar>
}
