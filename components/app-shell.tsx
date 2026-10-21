'use client'

import type { ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import { SidebarInset, SidebarProvider, SidebarTrigger, useSidebar } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Separator } from '@/components/ui/separator'
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb'

export function AppShell({ children, fixed = false }: { children: ReactNode; fixed?: boolean }) {
  return <TooltipProvider><SidebarProvider className={cn(fixed && 'h-svh overflow-hidden')}>{children}</SidebarProvider></TooltipProvider>
}

export function AppShellContent({ parent, title, actions, children, hideHeader = false }: { parent: string; title: string; actions?: ReactNode; children: ReactNode; hideHeader?: boolean }) {
  const { isMobile, openMobile, open } = useSidebar()
  const navT = useTranslations('Nav')
  const workspaceT = useTranslations('Workspace')
  return <SidebarInset className="min-h-0 min-w-0">
    {!hideHeader && <header className="flex h-12 shrink-0 items-center justify-between gap-3 px-4">
      <div className="flex min-w-0 items-center gap-2">
        <SidebarTrigger className="-ml-1" aria-label={navT('toggleSidebar')} aria-expanded={isMobile ? openMobile : open} />
        <Separator orientation="vertical" className="mr-2 data-vertical:h-4 data-vertical:self-auto" />
        <Breadcrumb aria-label={workspaceT('breadcrumb')}><BreadcrumbList><BreadcrumbItem className="hidden sm:inline-flex"><span>{parent}</span></BreadcrumbItem><BreadcrumbSeparator className="hidden sm:block" /><BreadcrumbItem><BreadcrumbPage>{title}</BreadcrumbPage></BreadcrumbItem></BreadcrumbList></Breadcrumb>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>}
    {children}
  </SidebarInset>
}
