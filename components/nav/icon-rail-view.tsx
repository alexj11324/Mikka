'use client'

import { useTranslations } from 'next-intl'
import { useEffect, useState } from 'react'
import { CircleArrowDown, SquarePen } from 'lucide-react'
import { RAIL_ITEMS, type RailProps } from '@/components/nav/rail-items'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { bridgeFromWindow } from '@/lib/platform/detect'
import { cn } from '@/lib/utils'
import { Sidebar } from '@/components/ui/sidebar'
import { WorkspaceMenu } from '@/components/workspace-menu'

const ITEM = 'group/rail-item size-9 rounded-sm text-muted-foreground/80 shadow-none hover:bg-transparent hover:text-muted-foreground/80 aria-[current=page]:text-foreground dark:hover:bg-transparent'
const ITEM_ICON = 'flex rounded-sm p-2 group-hover/rail-item:bg-sidebar-item in-data-desktop-translucent:group-hover/rail-item:bg-control'


/**
 * The 68px icon column on the window's frame, left of the card (R-35). Each
 * item is an icon only; its name shows as a tooltip on hover and stays its
 * accessible name (Alex, #580). Hover and the current item fill the icon, in
 * Comma's light gray, and the current item swaps to the solid icon. It never
 * collapses; the bot list inside the card does.
 */
export function IconRailView({ active, onNavigate, ...menu }: RailProps) {
  const i18nText = useTranslations()
  // A non-collapsing Sidebar, as in shadcn's nested icon-rail pattern; phones get these items in the list footer.
  return <Sidebar collapsible="none" role="navigation" aria-label={i18nText('Nav.rail')} className="hidden h-full w-17 shrink-0 items-center gap-1 bg-transparent pt-1 pb-1 md:flex">
    {menu.chats?.onNewConversation && <Button size="icon" variant="ghost" aria-label={i18nText('Nav.startConversation')} title={i18nText('Nav.startConversation')} onClick={menu.chats.onNewConversation}><SquarePen /></Button>}
    {RAIL_ITEMS.map(item => {
      const selected = active === item.id
      const Icon = selected ? item.selectedIcon : item.icon
      const label = i18nText(item.label)
      return <Tooltip key={item.id}>
        <TooltipTrigger render={<Button variant="ghost" size="icon" className={ITEM} aria-label={label} aria-current={selected ? 'page' : undefined} onClick={() => onNavigate(item.id)} />}>
          <span className={cn(ITEM_ICON, selected && 'bg-sidebar-item in-data-desktop-translucent:bg-control-hover')}><Icon className="size-5" /></span>
        </TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
    })}
    <div className="mt-auto flex w-15 flex-col items-center gap-1">
      <UpdateButton />
      <WorkspaceMenu compact {...menu} />
    </div>
  </Sidebar>
}

/**
 * The desktop app's restart button above the avatar (Alex, 2026-10-31): shown
 * only once an update has downloaded in the background; a click restarts into it.
 */
export function UpdateButton() {
  const i18nText = useTranslations()
  const [version, setVersion] = useState<string | null>(null)
  useEffect(() => {
    const app = bridgeFromWindow(window)?.app
    if (!app?.updateReady || !app.onUpdateReady) return
    void app.updateReady().then(ready => { if (ready) setVersion(ready) }).catch(() => {})
    return app.onUpdateReady(setVersion)
  }, [])
  if (!version) return null
  const label = i18nText('Nav.restartToUpdate', { version })
  return <Tooltip>
    <TooltipTrigger render={<Button variant="ghost" size="icon" className={cn(ITEM, 'text-sidebar-primary hover:text-sidebar-primary animate-in fade-in-0 duration-200 motion-reduce:animate-none')} aria-label={label} onClick={() => { void bridgeFromWindow(window)?.app.installUpdate?.() }} />}>
      {/* The accent (R-30) and a 24px icon in the same 36px target as the other items. */}
      <span className={cn(ITEM_ICON, 'p-1.5')}><CircleArrowDown className="size-6" /></span>
    </TooltipTrigger>
    <TooltipContent side="right">{label}</TooltipContent>
  </Tooltip>
}
