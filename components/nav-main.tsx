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
import { ChevronRightIcon, type LucideIcon } from "lucide-react"

export function NavMain({
  items,
}: {
  items: {
    title: string
    onClick: () => void
    icon: LucideIcon
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
  return (
    <SidebarGroup>
      <SidebarGroupLabel>工作空间</SidebarGroupLabel>
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
                  <ChevronRightIcon
                  />
                  <span className="sr-only">展开或收起状态筛选</span>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <SidebarMenuSub>
                    {item.items?.map((subItem) => (
                      <SidebarMenuSubItem key={subItem.title}>
                        <SidebarMenuSubButton render={<button type="button" />} onClick={subItem.onClick} isActive={subItem.isActive}>
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
