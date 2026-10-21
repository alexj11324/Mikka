'use client'

import type { ReactNode } from 'react'
import { SidebarInset, SidebarProvider, SidebarTrigger, useSidebar } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Separator } from '@/components/ui/separator'
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb'

export function AppShell({ children }: { children: ReactNode }) {
  return <TooltipProvider><SidebarProvider>{children}</SidebarProvider></TooltipProvider>
}

export function AppShellContent({ parent, title, actions, children }: { parent: string; title: string; actions?: ReactNode; children: ReactNode }) {
  const { isMobile, openMobile, open } = useSidebar()
  return <SidebarInset className="min-w-0">
    <header className="flex h-12 shrink-0 items-center justify-between gap-3 px-4">
      <div className="flex min-w-0 items-center gap-2">
        <SidebarTrigger className="-ml-1" aria-label="展开或收起侧栏" aria-expanded={isMobile ? openMobile : open} />
        <Separator orientation="vertical" className="mr-2 data-vertical:h-4 data-vertical:self-auto" />
        <Breadcrumb aria-label="当前位置"><BreadcrumbList><BreadcrumbItem className="hidden sm:inline-flex"><span>{parent}</span></BreadcrumbItem><BreadcrumbSeparator className="hidden sm:block" /><BreadcrumbItem><BreadcrumbPage>{title}</BreadcrumbPage></BreadcrumbItem></BreadcrumbList></Breadcrumb>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
    {children}
  </SidebarInset>
}
