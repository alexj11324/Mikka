"use client"

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar"
import { ChevronRight, type IconGlyph } from "@/components/icons"
import { Button } from '@/components/ui/button'
import { useTranslations } from '@/lib/intl/i18n-client'

export function NavMain({
  items,
}: {
  items: {
    title: string
    onClick: () => void
    icon: IconGlyph
    isActive?: boolean
    count?: number
    items?: {
      title: string
      onClick: () => void
      isActive?: boolean
      count?: number
    }[]
  }[]
}) {
  const t = useTranslations('Nav')
  return (
    <SidebarGroup>
      <SidebarGroupLabel>{t('workspace')}</SidebarGroupLabel>
      <SidebarMenu>
        {items.map((item) => (
          <Collapsible
            key={item.title}
            defaultOpen
            render={<SidebarMenuItem />}
          >
            <SidebarMenuButton
              tooltip={item.title}
              onClick={item.onClick}
              isActive={item.isActive}
            >
              <item.icon />
              <span>{item.title}</span>
              {item.count !== undefined && <span className="ml-auto mr-5 text-xs tabular-nums text-muted-foreground">{item.count}</span>}
            </SidebarMenuButton>
            {item.items?.length ? (
              <>
                <CollapsibleTrigger
                  render={
                    <SidebarMenuAction className="aria-expanded:rotate-90" />
                  }
                >
                  <ChevronRight
                  />
                  <span className="sr-only">{t('toggleStatusFilter')}</span>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <SidebarMenuSub>
                    {item.items?.map((subItem) => (
                      <SidebarMenuSubItem key={subItem.title}>
                        <SidebarMenuSubButton render={<Button type="button" variant="ghost" size="sm" />} onClick={subItem.onClick} isActive={subItem.isActive}>
                          <span>{subItem.title}</span>
                          <span className="ml-auto tabular-nums text-muted-foreground">{subItem.count}</span>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    ))}
                  </SidebarMenuSub>
                </CollapsibleContent>
              </>
            ) : null}
          </Collapsible>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  )
}
