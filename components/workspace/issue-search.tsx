'use client'

import { Plus } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type { listIssues } from '@/app/actions/issues'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from '@/components/ui/command'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { ISSUE_STATUSES, issueIdentifier } from './issue-properties'

export function IssueSearch({ open, onOpenChange, issues, onOpen, onCreate }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  issues: Awaited<ReturnType<typeof listIssues>>
  onOpen: (id: string) => boolean
  onCreate: () => void
}) {
  const i18nText = useTranslations();
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
              return <CommandItem key={issue.id} value={`${issueIdentifier(issue.metadata.number)} ${issue.title}`} onSelect={() => { if (onOpen(issue.id)) onOpenChange(false) }}>
                <status.icon /><span className="shrink-0 font-mono text-xs text-muted-foreground">{issueIdentifier(issue.metadata.number)}</span><span className="truncate">{issue.title}</span>
              </CommandItem>
            })}
          </CommandGroup>
          <CommandSeparator />
          {/* i18n-ignore: bilingual search keywords, not rendered */}
          <CommandGroup heading={t('quickActions')}><CommandItem value="新建任务 create issue new task" onSelect={() => { onOpenChange(false); onCreate() }}>{/* i18n-ignore: bilingual search keywords */}<Plus />{t('newTask')}</CommandItem></CommandGroup>
        </CommandList>
      </Command>
      <div className="flex flex-wrap items-center gap-4 bg-muted/30 px-4 py-3 text-xs text-muted-foreground"><span className="flex items-center gap-1.5"><KbdGroup><Kbd>↑</Kbd><Kbd>↓</Kbd></KbdGroup>{i18nText("FeatureCopy.c_70b20820")}</span><span className="flex items-center gap-1.5"><Kbd>Enter</Kbd>{i18nText("FeatureCopy.c_65fc81e1")}</span><span className="ml-auto flex items-center gap-1.5"><Kbd>Esc</Kbd>{i18nText("Common.close")}</span></div>
    </DialogContent>
  </Dialog>
}
