'use client'

import { Plus } from 'lucide-react'
import { useTranslations } from 'next-intl'
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
  const t = useTranslations('Workspace.search')
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent showCloseButton={false} className="overflow-hidden p-0 sm:max-w-xl">
      <DialogTitle className="sr-only">{t('title')}</DialogTitle>
      <DialogDescription className="sr-only">{t('description')}</DialogDescription>
      <Command>
        <CommandInput aria-label={t('global')} placeholder={t('placeholder')} />
        <CommandList>
          <CommandEmpty>{t('empty')}</CommandEmpty>
          <CommandGroup heading={t('tasks')}>
            {issues.map(issue => {
              const status = ISSUE_STATUSES.find(item => item.value === issue.status) ?? ISSUE_STATUSES[0]
              return <CommandItem key={issue.id} value={`${issueIdentifier(issue.id)} ${issue.title}`} onSelect={() => { if (onOpen(issue.id)) onOpenChange(false) }}>
                <status.icon /><span className="shrink-0 font-mono text-xs text-muted-foreground">{issueIdentifier(issue.id)}</span><span className="truncate">{issue.title}</span>
              </CommandItem>
            })}
          </CommandGroup>
          <CommandSeparator />
          {/* i18n-ignore: bilingual search keywords, not rendered */}
          <CommandGroup heading={t('quickActions')}><CommandItem value="新建任务 create issue new task" onSelect={() => { onOpenChange(false); onCreate() }}><Plus />{t('newTask')}</CommandItem></CommandGroup>
        </CommandList>
      </Command>
    </DialogContent>
  </Dialog>
}
