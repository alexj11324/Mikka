'use client'

import { useTranslations } from 'next-intl'
import type { ComponentType } from 'react'
import { Columns3, House, Lightbulb } from 'lucide-react'
import { ArtifactIcon } from '@/components/icons/artifact-icon'
import { ArtifactFilled, Columns3Filled, HouseFilled, LightbulbFilled, PlugCircle, PlugCircleFilled } from '@/components/icons/rail-filled-icons'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { Sidebar } from '@/components/ui/sidebar'
import { WorkspaceMenu } from '@/components/workspace-menu'

export type RailDestination = 'chats' | 'suggestions' | 'board' | 'plugins' | 'artifacts'

/** A lucide icon or one of ours drawn the same way (components/icons). */
type RailIcon = ComponentType<{ className?: string; 'data-icon'?: string }>

// 主页 (the bot chats), 建议, the board, plugins, 产物. `selectedIcon` is the solid twin shown on the current item.
export const RAIL_ITEMS: { id: RailDestination; icon: RailIcon; selectedIcon: RailIcon; label: 'Nav.home' | 'Nav.suggestions' | 'Nav.board' | 'Nav.plugins' | 'Nav.artifacts' }[] = [
  { id: 'chats', icon: House, selectedIcon: HouseFilled, label: 'Nav.home' },
  { id: 'suggestions', icon: Lightbulb, selectedIcon: LightbulbFilled, label: 'Nav.suggestions' },
  { id: 'board', icon: Columns3, selectedIcon: Columns3Filled, label: 'Nav.board' },
  { id: 'plugins', icon: PlugCircle, selectedIcon: PlugCircleFilled, label: 'Nav.plugins' },
  { id: 'artifacts', icon: ArtifactIcon, selectedIcon: ArtifactFilled, label: 'Nav.artifacts' },
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

/**
 * The 68px icon column on the window's frame, left of the card (Figma 56:500,
 * Icon rail v4). Each item is an icon whose name shows as a tooltip on hover; hover and the current item fill
 * the icon, in Comma's light gray, and the current item swaps to the
 * solid icon. It never collapses; the conversation list inside the card does.
 */
export function IconRail({ active, onNavigate, ...menu }: RailProps) {
  const i18nText = useTranslations()
  // A non-collapsing Sidebar, as in shadcn's nested icon-rail pattern; phones get these items in the list footer.
  return <Sidebar collapsible="none" role="navigation" aria-label={i18nText('Nav.rail')} className="hidden h-full w-17 shrink-0 items-center gap-1 bg-transparent pt-1 pb-1 md:flex">
    {RAIL_ITEMS.map(item => {
      const selected = active === item.id
      const Icon = selected ? item.selectedIcon : item.icon
      const label = i18nText(item.label)
      return <Tooltip key={item.id}>
        <TooltipTrigger render={<Button variant="ghost" size="icon" className="group/rail-item size-9 rounded-sm text-muted-foreground/80 shadow-none hover:bg-transparent hover:text-muted-foreground/80 aria-[current=page]:text-foreground dark:hover:bg-transparent" aria-label={label} aria-current={selected ? 'page' : undefined} onClick={() => onNavigate(item.id)} />}>
          <span className={cn('flex rounded-sm p-2 group-hover/rail-item:bg-sidebar-item', selected && 'bg-sidebar-item')}><Icon className="size-5" /></span>
        </TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
    })}
    <div className="mt-auto flex w-15 justify-center"><WorkspaceMenu compact {...menu} /></div>
  </Sidebar>
}
