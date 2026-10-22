'use client'
import { useTranslations } from 'next-intl'

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { SidebarInset, SidebarProvider, SidebarTrigger, useSidebar } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Separator } from '@/components/ui/separator'
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb'

export function AppShell({ children, variant = 'workspace', fixed = false }: { children: ReactNode; variant?: 'workspace' | 'settings'; fixed?: boolean }) {
  return <TooltipProvider><SidebarProvider className={cn(fixed && 'h-svh overflow-hidden', variant === 'settings' && 'h-svh overflow-hidden bg-sidebar [--background:var(--settings-background)] [--foreground:var(--settings-foreground)] [--card:var(--settings-card)] [--card-foreground:var(--settings-foreground)] [--sidebar:var(--settings-sidebar)] [--sidebar-foreground:var(--settings-sidebar-foreground)] [--sidebar-accent:var(--settings-sidebar-accent)] [--sidebar-accent-foreground:var(--settings-foreground)] [--sidebar-border:var(--settings-border)] [--border:var(--settings-border)] [--input:var(--settings-input)] [--muted-foreground:var(--settings-muted-foreground)]')}>{children}</SidebarProvider></TooltipProvider>
}

export function AppShellContent({ parent, title, actions, children, variant = 'workspace', hideHeader = false }: { parent: string; title: string; actions?: ReactNode; children: ReactNode; variant?: 'workspace' | 'settings'; hideHeader?: boolean }) {
  const i18nText = useTranslations();
  const { isMobile, openMobile, open } = useSidebar()
  return <SidebarInset className={cn('min-h-0 min-w-0', variant === 'settings' && 'overflow-y-auto overscroll-contain md:my-2 md:mr-2 md:rounded-xl md:border md:shadow-sm')}>
    {!hideHeader && <header className={cn('flex h-12 shrink-0 items-center justify-between gap-3 px-4', variant === 'settings' && 'md:hidden')}>
      <div className="flex min-w-0 items-center gap-2">
        <SidebarTrigger className="-ml-1" aria-label={i18nText("Workspace.toggleSidebar")} aria-expanded={isMobile ? openMobile : open} />
        <Separator orientation="vertical" className="mr-2 data-vertical:h-4 data-vertical:self-auto" />
        <Breadcrumb aria-label={i18nText("Workspace.breadcrumb")}><BreadcrumbList><BreadcrumbItem className="hidden sm:inline-flex"><span>{parent}</span></BreadcrumbItem><BreadcrumbSeparator className="hidden sm:block" /><BreadcrumbItem><BreadcrumbPage>{title}</BreadcrumbPage></BreadcrumbItem></BreadcrumbList></Breadcrumb>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>}
    {children}
  </SidebarInset>
}
