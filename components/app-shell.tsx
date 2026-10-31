'use client'
import { useTranslations } from 'next-intl'

import { useEffect, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { SidebarInset, SidebarProvider, SidebarTrigger, useSidebar } from '@/components/ui/sidebar'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { ArrowLeft, ArrowRight, PanelLeft } from 'lucide-react'
import { Separator } from '@/components/ui/separator'
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'

/** Settings' own palette, mapped onto the shared tokens for everything inside the frame. */
const SETTINGS_COLORS = '[--background:var(--settings-background)] [--foreground:var(--settings-foreground)] [--card:var(--settings-card)] [--card-foreground:var(--settings-foreground)] [--sidebar:var(--settings-sidebar)] [--sidebar-foreground:var(--settings-sidebar-foreground)] [--sidebar-accent:var(--settings-sidebar-accent)] [--sidebar-accent-foreground:var(--settings-foreground)] [--sidebar-border:var(--settings-border)] [--border:var(--settings-border)] [--input:var(--settings-input)] [--muted-foreground:var(--settings-muted-foreground)]'

/**
 * The app window, built like Comma's shell: one gray frame that never scrolls,
 * the window bar across the top, the rail on the left, and every page inside a
 * single rounded card. Columns inside the card scroll on their own.
 */
export function AppFrame({ bar, rail, children, settings = false }: { bar: ReactNode; rail: ReactNode; children: ReactNode; settings?: boolean }) {
  const t = useTranslations('Shell')
  return <TooltipProvider><SidebarProvider className={cn('h-svh min-h-0 flex-col overflow-hidden bg-shell-chrome', settings && SETTINGS_COLORS)}>
    {bar}
    <div className="flex min-h-0 flex-1 md:pr-2 md:pb-2">
      {rail}
      <section data-slot="app-frame-content" aria-label={t('window')} className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background md:rounded-xl md:shadow-xs md:ring-1 md:ring-border">{children}</section>
    </div>
  </SidebarProvider></TooltipProvider>
}

type NavigationHistory = EventTarget & { canGoBack: boolean; canGoForward: boolean }

/** Back and forward follow the browser's own history; where the Navigation API is missing both stay enabled. */
function useHistoryButtons() {
  const [state, setState] = useState({ back: true, forward: true })
  useEffect(() => {
    const navigation = (window as Window & { navigation?: NavigationHistory }).navigation
    if (!navigation) return
    const update = () => setState({ back: navigation.canGoBack, forward: navigation.canGoForward })
    update()
    navigation.addEventListener('currententrychange', update)
    return () => navigation.removeEventListener('currententrychange', update)
  }, [])
  return state
}

/** The strip above the card: history on the left, search centered, page actions on the right. */
export function WindowBar({ center, trailing }: { center: ReactNode; trailing?: ReactNode }) {
  const t = useTranslations('Shell')
  const history = useHistoryButtons()
  return <div data-slot="window-bar" className="hidden h-11 shrink-0 grid-cols-[1fr_minmax(0,26rem)_1fr] items-center gap-3 pr-2 pl-3 md:grid in-data-[desktop-platform=darwin]:pl-20 in-data-[desktop-platform=darwin]:[-webkit-app-region:drag] [&_:is(button,a,input,select,textarea,[role=button],[role=combobox],[role=tab],[role=menuitem],[role=switch])]:[-webkit-app-region:no-drag]">
    <div className="flex items-center gap-0.5">
      <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={t('back')} disabled={!history.back} onClick={() => window.history.back()} />}><ArrowLeft data-icon="inline-start" /></TooltipTrigger><TooltipContent side="bottom">{t('back')}</TooltipContent></Tooltip>
      <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={t('forward')} disabled={!history.forward} onClick={() => window.history.forward()} />}><ArrowRight data-icon="inline-start" /></TooltipTrigger><TooltipContent side="bottom">{t('forward')}</TooltipContent></Tooltip>
    </div>
    <div className="flex min-w-0 justify-center">{center}</div>
    <div className="flex items-center justify-end gap-0.5">{trailing}</div>
  </div>
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
  return <SidebarInset className={cn('min-h-0 min-w-0', 'overflow-y-auto overscroll-contain')}>
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
