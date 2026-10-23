'use client'
import { useTranslations } from 'next-intl'

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { SidebarInset, SidebarProvider, SidebarTrigger, useSidebar } from '@/components/ui/sidebar'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { PanelLeft } from 'lucide-react'
import { Separator } from '@/components/ui/separator'
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'

export function AppShell({ children, variant = 'workspace', fixed = false, topBar = false }: { children: ReactNode; variant?: 'workspace' | 'settings'; fixed?: boolean; topBar?: boolean }) {
  return <TooltipProvider><SidebarProvider className={cn(fixed && 'h-svh overflow-hidden', topBar && 'md:pt-10', variant === 'settings' && 'h-svh overflow-hidden bg-sidebar [--background:var(--settings-background)] [--foreground:var(--settings-foreground)] [--card:var(--settings-card)] [--card-foreground:var(--settings-foreground)] [--sidebar:var(--settings-sidebar)] [--sidebar-foreground:var(--settings-sidebar-foreground)] [--sidebar-accent:var(--settings-sidebar-accent)] [--sidebar-accent-foreground:var(--settings-foreground)] [--sidebar-border:var(--settings-border)] [--border:var(--settings-border)] [--input:var(--settings-input)] [--muted-foreground:var(--settings-muted-foreground)]')}>{children}</SidebarProvider></TooltipProvider>
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

export function AppShellContent({ parent, title, actions, children, variant = 'workspace', hideHeader = false, listToggle = true }: { parent: string; title: string; actions?: ReactNode; children: ReactNode; variant?: 'workspace' | 'settings'; hideHeader?: boolean; listToggle?: boolean }) {
  const i18nText = useTranslations();
  const { isMobile, openMobile, open, toggleSidebar } = useSidebar()
  return <SidebarInset className={cn('min-h-0 min-w-0', variant === 'settings' && 'overflow-y-auto overscroll-contain md:my-2 md:mr-2 md:rounded-xl md:border md:shadow-sm')}>
    {/* Desktop has no title bar (MIK-40): the top bar searches and the pill names the conversation. Phones keep it, having no rail. */}
    {!hideHeader && <header className={cn('flex h-12 shrink-0 items-center justify-between gap-3 px-4 md:hidden')}>
      <div className="flex min-w-0 items-center gap-2">
        <SidebarTrigger className="-ml-1" aria-label={i18nText("Workspace.toggleSidebar")} aria-expanded={isMobile ? openMobile : open} />
        <Separator orientation="vertical" className="mr-2 data-vertical:h-4 data-vertical:self-auto" />
        <Breadcrumb aria-label={i18nText("Workspace.breadcrumb")}><BreadcrumbList><BreadcrumbItem className="hidden sm:inline-flex"><span>{parent}</span></BreadcrumbItem><BreadcrumbSeparator className="hidden sm:block" /><BreadcrumbItem><BreadcrumbPage>{title}</BreadcrumbPage></BreadcrumbItem></BreadcrumbList></Breadcrumb>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>}
    {/* With the list collapsed, its panel button waits at the top left (Figma 60:299). */}
    {variant === 'workspace' && listToggle && !open && <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" className="absolute top-3 left-3 z-20 hidden md:inline-flex" aria-label={i18nText('Shell.openList')} aria-expanded={false} onClick={toggleSidebar} />}><PanelLeft data-icon="inline-start" /></TooltipTrigger><TooltipContent side="right">{i18nText('Shell.openList')}</TooltipContent></Tooltip>}
    {children}
  </SidebarInset>
}
