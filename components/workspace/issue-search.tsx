'use client'

import { Plus } from 'lucide-react'
import type { listIssues } from '@/app/actions/issues'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from '@/components/ui/command'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { ISSUE_STATUSES, issueIdentifier } from './issue-properties'

export function IssueSearch({ open, onOpenChange, issues, onOpen, onCreate }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  issues: Awaited<ReturnType<typeof listIssues>>
  onOpen: (id: string) => boolean
  onCreate: () => void
}) {
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent showCloseButton={false} className="overflow-hidden p-0 sm:max-w-xl">
      <DialogTitle className="sr-only">搜索任务</DialogTitle>
      <DialogDescription className="sr-only">搜索当前账号可访问的任务，使用方向键选择并按 Enter 打开。</DialogDescription>
      <Command>
        <CommandInput aria-label="全局搜索任务" placeholder="搜索标题或任务编号…" />
        <CommandList>
          <CommandEmpty>没有匹配的任务</CommandEmpty>
          <CommandGroup heading="任务">
            {issues.map(issue => {
              const status = ISSUE_STATUSES.find(item => item.value === issue.status) ?? ISSUE_STATUSES[0]
              return <CommandItem key={issue.id} value={`${issueIdentifier(issue.id)} ${issue.title}`} onSelect={() => { if (onOpen(issue.id)) onOpenChange(false) }}>
                <status.icon /><span className="shrink-0 font-mono text-xs text-muted-foreground">{issueIdentifier(issue.id)}</span><span className="truncate">{issue.title}</span>
              </CommandItem>
            })}
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="快捷操作"><CommandItem value="新建任务 create issue" onSelect={() => { onOpenChange(false); onCreate() }}><Plus />新建任务</CommandItem></CommandGroup>
        </CommandList>
      </Command>
    </DialogContent>
  </Dialog>
}
