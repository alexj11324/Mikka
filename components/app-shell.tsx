'use client'

import type { ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import { SidebarInset, SidebarProvider, SidebarTrigger, useSidebar } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Separator } from '@/components/ui/separator'
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'

export function AppShell({ children, fixed = false }: { children: ReactNode; fixed?: boolean }) {
  return <TooltipProvider><SidebarProvider className={cn(fixed && 'h-svh overflow-hidden')}>{children}</SidebarProvider></TooltipProvider>
}

export function SignOutBoundary({ pending, children }: { pending: boolean; children: ReactNode }) {
  const t = useTranslations('Nav')
  return <>
    {/* Keep editor drafts mounted so failed revocation can restore them. */}
    <div hidden={pending} inert={pending} className={cn('contents', pending && 'hidden')}>{children}</div>
    {pending && <Dialog open disablePointerDismissal>
      {/* The global sidebar shortcut can reopen its portal above this modal. */}
      <DialogContent showCloseButton={false} aria-label={t('signingOut')} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') event.stopPropagation() }} className="inset-0 flex h-dvh max-w-none translate-x-0 translate-y-0 items-center justify-center rounded-none bg-background p-0 text-foreground ring-0 sm:max-w-none data-open:animate-none">
        <DialogTitle className="sr-only">{t('signingOut')}</DialogTitle>
        <div role="status" aria-label={t('signingOut')} className="flex items-center gap-3 text-sm text-muted-foreground">
          <span aria-hidden="true" className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none" />
          {t('signingOut')}
        </div>
      </DialogContent>
    </Dialog>}
  </>
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
