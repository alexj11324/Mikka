'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Building2, User } from 'lucide-react'
import { toast } from 'sonner'
import { setIssueScope } from '@/app/actions/issues'
import { useActionError } from '@/lib/use-action-error'
import type { TaskScope } from '@/lib/task-identifier'
import { IssuePropertyMenu } from './issue-property-menu'
import type { MetadataSavedIssue } from './issue-metadata-controls'

/** Workspace or personal, as the agent judged it; one click changes it (MIK-47). */
export function IssueScopeControl({ task, disabled, onSaved }: {
  task: { id: string; revision: number; scope: TaskScope; scopeSetBy: 'agent' | 'user' }
  disabled?: boolean
  onSaved: (issue: MetadataSavedIssue) => void
}) {
  const t = useTranslations('Issue.scope')
  const actionError = useActionError()
  const [pending, setPending] = useState(false)
  const options = [
    { value: 'workspace', label: t('workspace'), icon: Building2 },
    { value: 'personal', label: t('personal'), icon: User },
  ]
  async function change(value: string) {
    if (value === task.scope || pending) return
    setPending(true)
    try {
      const result = await setIssueScope({ id: task.id, revision: task.revision, scope: value })
      if (!('issue' in result) || !result.issue) { toast.error(actionError(result.error)); return }
      onSaved(result.issue)
      toast.success(value === 'workspace' ? t('movedToWorkspace') : t('movedToPersonal'))
    } catch { toast.error(actionError('generic')) }
    finally { setPending(false) }
  }
  const current = options.find(option => option.value === task.scope)?.label ?? task.scope
  return <div className="flex min-w-0 items-center gap-2">
    <IssuePropertyMenu label={t('label')} value={task.scope} options={options} icon={task.scope === 'workspace' ? Building2 : User} disabled={disabled || pending} displayValue={current} onChange={value => { void change(value) }} />
    {task.scopeSetBy === 'agent' && <span className="truncate text-xs text-muted-foreground">{t('judgedByAgent')}</span>}
  </div>
}
