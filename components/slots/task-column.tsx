'use client'

// The default task-column slot (docs/ui-overlay.md): a task beside the centre, its title and its threads.
// The default layer never opens one (its lists open threads); a layer that lists tasks does.
import { useTranslations } from 'next-intl'
import { ArrowLeft, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { RightColumn } from '@/components/workspace/thread-column'
import { issueIdentifier } from '@/components/workspace/issue-properties'
import { closeTask, toggleAllThreads } from '@/components/workspace/workspace-navigation'
import type { TaskColumnProps } from '@/components/slots/task-column-contract'

export function TaskColumn({ children, issue, overList = false }: TaskColumnProps) {
  const t = useTranslations('Shell.panel')
  const title = issue ? [issueIdentifier(issue), issue.title].filter(Boolean).join(' ') : ''
  return <RightColumn slot="task-column">
    <header className="flex h-12 shrink-0 items-center gap-1 px-2">
      <Button variant="ghost" size="icon-sm" aria-label={t('back')} onClick={closeTask}><ArrowLeft data-icon="inline-start" /></Button>
      <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</h2>
      {overList && <Button variant="ghost" size="icon-sm" aria-label={t('closeAllThreads')} onClick={() => toggleAllThreads(false)}><X data-icon="inline-start" /></Button>}
    </header>
    <div className="min-h-0 flex-1">{children}</div>
  </RightColumn>
}
