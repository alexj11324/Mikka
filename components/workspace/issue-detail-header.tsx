'use client'

import type { ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { ArrowDown, ArrowUp, Check, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Breadcrumb, BreadcrumbEllipsis, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Separator } from '@/components/ui/separator'
import { SidebarTrigger, useSidebar } from '@/components/ui/sidebar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { issueIdentifier } from './issue-properties'

export type IssueDetailNavigation = { index: number; total: number; onOpen: (offset: -1 | 1) => void }

export function IssueDetailHeader({ workspaceName, identifier, title, saveLabel, saved, pending, navigation, actions, onClose }: {
  workspaceName: string; identifier: string | null; title: string; saveLabel: string; saved: boolean; pending: boolean
  navigation: IssueDetailNavigation; actions: ReactNode
  onClose: () => void
}) {
  const t = useTranslations('Workspace')
  const tDetail = useTranslations('IssueDetail')
  const tWorkspaceDetail = useTranslations('Workspace.detail')
  const { isMobile, openMobile, open } = useSidebar()
  // The header lays itself out by its own width (the sidebar changes it, the viewport doesn't).
  // Narrowing order: the title truncates, then the workspace name; then both fold into the ellipsis; then the save
  // label text and the previous/next arrows go (the list still opens any task). The ID never truncates.
  return <header className="@container/header sticky top-0 z-10 flex h-12 shrink-0 items-center justify-between gap-3 border-b border-rule bg-background px-3 sm:px-4">
    <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
      <SidebarTrigger className="-ml-1" aria-label={t('toggleSidebar')} aria-expanded={isMobile ? openMobile : open} />
      <Separator orientation="vertical" className="mr-1 data-vertical:h-4 data-vertical:self-auto" />
      <Breadcrumb className="min-w-0" aria-label={t('breadcrumb')}><BreadcrumbList className="min-w-0 flex-nowrap">
        <BreadcrumbItem className="@2xl/header:hidden">
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label={tDetail('breadcrumbMore')} />}><BreadcrumbEllipsis /></DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuGroup>
                <DropdownMenuLabel>{workspaceName}</DropdownMenuLabel>
                <DropdownMenuItem disabled={pending} onClick={onClose}>{tDetail('breadcrumbBoard')}</DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </BreadcrumbItem>
        <BreadcrumbItem className="hidden @2xl/header:inline-flex"><span className="min-w-0 max-w-40 truncate" title={workspaceName}>{workspaceName}</span></BreadcrumbItem>
        <BreadcrumbSeparator className="hidden @2xl/header:block" />
        <BreadcrumbItem className="hidden @2xl/header:inline-flex"><Button variant="ghost" size="xs" disabled={pending} onClick={onClose}>{tDetail('breadcrumbBoard')}</Button></BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem className="min-w-0">
          <BreadcrumbPage className="shrink-0">{issueIdentifier({ identifier })}</BreadcrumbPage>
          <span className="hidden min-w-0 truncate @lg/header:inline" title={title}>{title}</span>
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
        <span className="hidden px-2 text-xs tabular-nums text-muted-foreground @xl/header:inline">{navigation.index + 1} / {navigation.total}</span>
        <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={tDetail('previousTask')} className="hidden @sm/header:inline-flex" disabled={pending || navigation.index === 0} onClick={() => navigation.onOpen(-1)} />}><ArrowUp /></TooltipTrigger><TooltipContent>{tDetail('previousTask')}</TooltipContent></Tooltip>
        <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={tDetail('nextTask')} className="hidden @sm/header:inline-flex" disabled={pending || navigation.index >= navigation.total - 1} onClick={() => navigation.onOpen(1)} />}><ArrowDown /></TooltipTrigger><TooltipContent>{tDetail('nextTask')}</TooltipContent></Tooltip>
      </>}
      <Button variant="ghost" size="icon-sm" aria-label={tWorkspaceDetail('closeDetail')} disabled={pending} onClick={onClose}><X data-icon="inline-start" /></Button>
    </div>
  </header>
}
