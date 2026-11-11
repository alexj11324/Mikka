'use client'

import type { ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { ArrowDown, ArrowUp, Check, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Breadcrumb, BreadcrumbEllipsis, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Separator } from '@/components/ui/separator'
import { SidebarTrigger, useSidebar } from '@/components/ui/sidebar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export type IssueDetailNavigation = { index: number; total: number; onOpen: (offset: -1 | 1) => void }

export function IssueDetailHeader({ origin, identifier, title, saveLabel, saved, pending, navigation, actions, onClose }: {
  /** Where the task was opened from: a bot's chat, the Coordinator, 看板, a project. */
  origin: string
  identifier: string | null; title: string; saveLabel: string; saved: boolean; pending: boolean
  navigation: IssueDetailNavigation; actions: ReactNode
  onClose: () => void
}) {
  const t = useTranslations('Workspace')
  const tDetail = useTranslations('IssueDetail')
  const tWorkspaceDetail = useTranslations('Workspace.detail')
  const { isMobile, openMobile, open } = useSidebar()
  // The header lays itself out by its own width (the sidebar changes it, the viewport doesn't).
  // One breakpoint system only: container queries on `@container/header`, three steps (@sm, @md, @lg), no viewport
  // `sm:`/`md:` — a container-bound layout that also switched on viewport width contradicted itself when the
  // sidebar moved the border. The bar's own padding sits on an inner box so it can be a container query too; an
  // element cannot query the container it defines.
  // No workspace name: it cannot be clicked here, and the workspace is switched only from the avatar menu
  // (decision 2026-11-01-1300-no-workspace-name-in-breadcrumbs, R-79).
  // The first crumb is the place the task was opened from and returns there, as ✕ does (R-82).
  // On a desktop that crumb always shows, as 「Coordinator › NAVA-1」 (the title truncates first); only at
  // phone width does it fold into the ellipsis. Narrowing then drops the save label text and the
  // previous/next arrows (the list still opens any task). The ID never truncates.
  return <header className="@container/header sticky top-0 z-10 h-12 shrink-0 border-b border-rule bg-background">
    <div className="flex h-full items-center justify-between gap-3 px-3 @md/header:px-4">
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
        <SidebarTrigger className="-ml-1" aria-label={t('toggleSidebar')} aria-expanded={isMobile ? openMobile : open} />
        <Separator orientation="vertical" className="mr-1 data-vertical:h-4 data-vertical:self-auto" />
        <Breadcrumb className="min-w-0" aria-label={t('breadcrumb')}><BreadcrumbList className="min-w-0 flex-nowrap">
          <BreadcrumbItem className="@md/header:hidden">
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label={tDetail('breadcrumbMore')} />}><BreadcrumbEllipsis /></DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuGroup>
                  <DropdownMenuItem disabled={pending} onClick={onClose}>{origin}</DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </BreadcrumbItem>
          {/* At the list's own size, colour and weight like the crumbs beside it: no button size of its own shrinks the text. */}
          {/* A narrow header truncates the origin before the ID: the ID's crumb never shrinks below the ID itself. */}
          <BreadcrumbItem className="hidden min-w-0 @md/header:inline-flex"><Button variant="ghost" className="h-6 max-w-40 min-w-0 shrink px-2 font-normal" disabled={pending} onClick={onClose}><span className="truncate">{origin}</span></Button></BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem className={cn(identifier ? 'min-w-min' : 'min-w-0')}>
            {identifier ? <><BreadcrumbPage className="shrink-0 whitespace-nowrap">{identifier}</BreadcrumbPage>
              <span className="hidden min-w-0 truncate @lg/header:inline" title={title}>{title}</span></>
              : <BreadcrumbPage className="min-w-0 truncate" title={title}>{title}</BreadcrumbPage>}
          </BreadcrumbItem>
        </BreadcrumbList></Breadcrumb>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {saveLabel && <><span role="status" aria-live="polite" className="sr-only">{saveLabel}</span>
        <Tooltip><TooltipTrigger render={<span tabIndex={0} className="mr-2 flex items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground" />}>
          {saved && <span className="inline-flex"><Check className="size-3.5" aria-hidden="true" /></span>}<span className="sr-only @md/header:not-sr-only">{saveLabel}</span>
        </TooltipTrigger><TooltipContent>{tDetail('autosaveHint')}</TooltipContent></Tooltip></>}
        {actions}
        {navigation.index >= 0 && <>
          <span className="hidden px-2 text-xs tabular-nums text-muted-foreground @lg/header:inline">{navigation.index + 1} / {navigation.total}</span>
          <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={tDetail('previousTask')} className="hidden @sm/header:inline-flex" disabled={pending || navigation.index === 0} onClick={() => navigation.onOpen(-1)} />}><ArrowUp /></TooltipTrigger><TooltipContent>{tDetail('previousTask')}</TooltipContent></Tooltip>
          <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={tDetail('nextTask')} className="hidden @sm/header:inline-flex" disabled={pending || navigation.index >= navigation.total - 1} onClick={() => navigation.onOpen(1)} />}><ArrowDown /></TooltipTrigger><TooltipContent>{tDetail('nextTask')}</TooltipContent></Tooltip>
        </>}
        <Button variant="ghost" size="icon-sm" aria-label={tWorkspaceDetail('closeDetail')} disabled={pending} onClick={onClose}><X data-icon="inline-start" /></Button>
      </div>
    </div>
  </header>
}
