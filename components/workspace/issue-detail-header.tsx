'use client'

import { ArrowDown, ArrowUp, Check, FileText, History, MoreHorizontal, Users, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Separator } from '@/components/ui/separator'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { WORKSPACE_NAME, issueIdentifier } from './issue-properties'

export type IssueDetailNavigation = { index: number; total: number; onOpen: (offset: -1 | 1) => void }

export function IssueDetailHeader({ id, title, saveLabel, saved, pending, documentTools, navigation, onDocumentTools, onHistory, onMembers, onClose }: {
  id: string; title: string; saveLabel: string; saved: boolean; pending: boolean; documentTools: boolean
  navigation: IssueDetailNavigation
  onDocumentTools: () => void; onHistory: () => void; onMembers: () => void; onClose: () => void
}) {
  return <header className="sticky top-0 z-10 flex h-12 shrink-0 items-center justify-between gap-3 border-b bg-background px-3 sm:px-4">
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <SidebarTrigger className="-ml-1" aria-label="展开或收起侧栏" />
      <Separator orientation="vertical" className="mr-1 data-vertical:h-4 data-vertical:self-auto" />
      <Breadcrumb aria-label="当前位置" className="min-w-0"><BreadcrumbList className="flex-nowrap gap-2 sm:gap-2">
        <BreadcrumbItem className="hidden shrink-0 md:inline-flex"><span>{WORKSPACE_NAME}</span></BreadcrumbItem>
        <BreadcrumbSeparator className="hidden md:block" />
        <BreadcrumbItem className="hidden shrink-0 sm:inline-flex"><Button variant="ghost" size="xs" disabled={pending} onClick={onClose}>任务</Button></BreadcrumbItem>
        <BreadcrumbSeparator className="hidden sm:block" />
        <BreadcrumbItem className="min-w-0"><BreadcrumbPage className="flex min-w-0 items-center gap-2"><span className="shrink-0">{issueIdentifier(id)}</span><span className="hidden truncate text-muted-foreground lg:inline" title={title}>{title}</span></BreadcrumbPage></BreadcrumbItem>
      </BreadcrumbList></Breadcrumb>
    </div>
    <div className="flex shrink-0 items-center gap-1">
      <span role="status" aria-live="polite" className="sr-only">{saveLabel}</span>
      <Tooltip><TooltipTrigger render={<span tabIndex={0} className="mr-2 hidden items-center gap-1.5 text-xs text-muted-foreground md:flex" />}>
        {saved && <span className="inline-flex"><Check className="size-3.5" aria-hidden="true" /></span>}<span>{saveLabel}</span>
      </TooltipTrigger><TooltipContent>标题、描述和属性会自动保存</TooltipContent></Tooltip>
      <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="更多任务操作" disabled={pending} />}><MoreHorizontal /></DropdownMenuTrigger><DropdownMenuContent align="end" className="w-44"><DropdownMenuGroup>
        <DropdownMenuItem onClick={onDocumentTools}><FileText />{documentTools ? '返回任务描述' : '高级文档工具'}</DropdownMenuItem>
        <DropdownMenuItem onClick={onHistory}><History />版本历史</DropdownMenuItem>
        <DropdownMenuItem onClick={onMembers}><Users />管理协作成员</DropdownMenuItem>
      </DropdownMenuGroup></DropdownMenuContent></DropdownMenu>
      {navigation.index >= 0 && <>
        <span className="hidden px-2 text-xs tabular-nums text-muted-foreground sm:inline">{navigation.index + 1} / {navigation.total}</span>
        <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="上一个任务" disabled={pending || navigation.index === 0} onClick={() => navigation.onOpen(-1)} />}><ArrowUp /></TooltipTrigger><TooltipContent>上一个任务</TooltipContent></Tooltip>
        <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="下一个任务" disabled={pending || navigation.index >= navigation.total - 1} onClick={() => navigation.onOpen(1)} />}><ArrowDown /></TooltipTrigger><TooltipContent>下一个任务</TooltipContent></Tooltip>
      </>}
      <Button variant="ghost" size="icon-sm" aria-label="关闭任务详情" disabled={pending} onClick={onClose}><X data-icon="inline-start" /></Button>
    </div>
  </header>
}
