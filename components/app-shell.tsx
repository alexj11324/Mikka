'use client'

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { SidebarInset, SidebarProvider, SidebarTrigger, useSidebar } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Separator } from '@/components/ui/separator'
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb'

export function AppShell({ children, variant = 'workspace' }: { children: ReactNode; variant?: 'workspace' | 'settings' }) {
  return <TooltipProvider><SidebarProvider className={cn(variant === 'settings' && 'bg-sidebar [--background:var(--settings-background)] [--foreground:var(--settings-foreground)] [--card:var(--settings-card)] [--card-foreground:var(--settings-foreground)] [--sidebar:var(--settings-sidebar)] [--sidebar-foreground:var(--settings-sidebar-foreground)] [--sidebar-accent:var(--settings-sidebar-accent)] [--sidebar-accent-foreground:var(--settings-foreground)] [--sidebar-border:var(--settings-border)] [--border:var(--settings-border)] [--input:var(--settings-input)] [--muted-foreground:var(--settings-muted-foreground)]')}>{children}</SidebarProvider></TooltipProvider>
}

export function AppShellContent({ parent, title, actions, children, variant = 'workspace' }: { parent: string; title: string; actions?: ReactNode; children: ReactNode; variant?: 'workspace' | 'settings' }) {
  const { isMobile, openMobile, open } = useSidebar()
  return <SidebarInset className={cn('min-w-0', variant === 'settings' && 'md:rounded-tl-xl')}>
    <header className={cn('flex h-12 shrink-0 items-center justify-between gap-3 px-4', variant === 'settings' && 'md:hidden')}>
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
