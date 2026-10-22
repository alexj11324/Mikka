'use client'

import type { ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { ArrowDown, ArrowUp, Check, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb'
import { Separator } from '@/components/ui/separator'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { issueIdentifier } from './issue-properties'

export type IssueDetailNavigation = { index: number; total: number; onOpen: (offset: -1 | 1) => void }

export function IssueDetailHeader({ workspaceName, number, title, saveLabel, saved, pending, navigation, actions, onClose }: {
  workspaceName: string; number: number | undefined; title: string; saveLabel: string; saved: boolean; pending: boolean
  navigation: IssueDetailNavigation; actions: ReactNode
  onClose: () => void
}) {
  const t = useTranslations('Workspace')
  const tDetail = useTranslations('IssueDetail')
  const tWorkspaceDetail = useTranslations('Workspace.detail')
  return <header className="sticky top-0 z-10 flex h-12 shrink-0 items-center justify-between gap-3 bg-background px-3 sm:px-4">
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <SidebarTrigger className="-ml-1" aria-label={t('toggleSidebar')} />
      <Separator orientation="vertical" className="mr-1 data-vertical:h-4 data-vertical:self-auto" />
      <Breadcrumb aria-label={t('breadcrumb')} className="min-w-0"><BreadcrumbList className="flex-nowrap gap-2 sm:gap-2">
        <BreadcrumbItem className="hidden shrink-0 md:inline-flex"><span className="max-w-40 truncate" title={workspaceName}>{workspaceName}</span></BreadcrumbItem>
        <BreadcrumbSeparator className="hidden md:block" />
        <BreadcrumbItem className="hidden shrink-0 sm:inline-flex"><Button variant="ghost" size="xs" disabled={pending} onClick={onClose}>{tDetail('breadcrumbTask')}</Button></BreadcrumbItem>
        <BreadcrumbSeparator className="hidden sm:block" />
        <BreadcrumbItem className="min-w-0"><BreadcrumbPage className="flex min-w-0 items-center gap-2"><span className="shrink-0">{issueIdentifier(number)}</span><span className="hidden truncate text-muted-foreground lg:inline" title={title}>{title}</span></BreadcrumbPage></BreadcrumbItem>
      </BreadcrumbList></Breadcrumb>
    </div>
    <div className="flex shrink-0 items-center gap-1">
      <span role="status" aria-live="polite" className="sr-only">{saveLabel}</span>
      <Tooltip><TooltipTrigger render={<span tabIndex={0} className="mr-2 hidden items-center gap-1.5 text-xs text-muted-foreground md:flex" />}>
        {saved && <span className="inline-flex"><Check className="size-3.5" aria-hidden="true" /></span>}<span>{saveLabel}</span>
      </TooltipTrigger><TooltipContent>{tDetail('autosaveHint')}</TooltipContent></Tooltip>
      {actions}
      {navigation.index >= 0 && <>
        <span className="hidden px-2 text-xs tabular-nums text-muted-foreground sm:inline">{navigation.index + 1} / {navigation.total}</span>
        <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={tDetail('previousTask')} disabled={pending || navigation.index === 0} onClick={() => navigation.onOpen(-1)} />}><ArrowUp /></TooltipTrigger><TooltipContent>{tDetail('previousTask')}</TooltipContent></Tooltip>
        <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={tDetail('nextTask')} disabled={pending || navigation.index >= navigation.total - 1} onClick={() => navigation.onOpen(1)} />}><ArrowDown /></TooltipTrigger><TooltipContent>{tDetail('nextTask')}</TooltipContent></Tooltip>
      </>}
      <Button variant="ghost" size="icon-sm" aria-label={tWorkspaceDetail('closeDetail')} disabled={pending} onClick={onClose}><X data-icon="inline-start" /></Button>
    </div>
  </header>
}
