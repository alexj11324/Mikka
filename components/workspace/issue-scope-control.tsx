'use client'

import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Building2, User } from 'lucide-react'
import { toast } from 'sonner'
import { setIssueScope, promoteIssueToTeam } from '@/app/actions/issues'
import { getIssueTeam } from '@/app/actions/team-relations'
import { submitTeamPromotion, type ExplicitTeamChoice, type TeamPromotionIntent } from '@/lib/issue-team-intent'
import { useActionError } from '@/lib/use-action-error'
import type { TaskScope } from '@/lib/task-identifier'
import { IssuePropertyMenu } from './issue-property-menu'
import type { MetadataSavedIssue } from './issue-metadata-controls'

/** Sharing requires the team's explicit save event; never infer a destination. */
export function IssueScopeControl({ task, disabled, onSaved, teamChoice }: {
  task: { id: string; revision: number; scope: TaskScope; scopeSetBy: 'agent' | 'user' }
  disabled?: boolean
  teamChoice?: ExplicitTeamChoice | null
  onSaved: (issue: MetadataSavedIssue) => void
}) {
  const t = useTranslations('Issue.scope')
  const actionError = useActionError()
  const [pending, setPending] = useState(false)
  const promotion = useRef<TeamPromotionIntent | null>(null)
  const generation = useRef(0)
  useLayoutEffect(() => {
    generation.current++
    return () => { generation.current++ }
  }, [task.id, task.revision, teamChoice?.issueId, teamChoice?.teamId, teamChoice?.selectionId])
  const options = [
    { value: 'workspace', label: t('workspace'), icon: Building2 },
    { value: 'personal', label: t('personal'), icon: User },
  ]
  async function change(value: string) {
    if (value === task.scope || pending) return
    const started = generation.current
    const isCurrent = () => started === generation.current
    setPending(true)
    try {
      let result
      if (value === 'workspace') {
        result = await submitTeamPromotion(task, teamChoice, promotion.current, {
          isCurrent, readTeam: () => getIssueTeam(task.id), requestId: () => crypto.randomUUID(),
          remember: intent => { promotion.current = intent }, promote: promoteIssueToTeam,
        })
      } else {
        result = await setIssueScope({ id: task.id, revision: task.revision, scope: value })
      }
      if (!isCurrent()) return
      if (!('issue' in result) || !result.issue) { toast.error(actionError(result.error)); return }
      onSaved(result.issue)
      // An idempotent replay returns the current task, which another request
      // may since have made personal. Never describe the old requested state.
      if (result.issue.scope !== value) { toast.error(actionError('teamIssueChanged')); return }
      toast.success(value === 'workspace' ? t('movedToWorkspace') : t('movedToPersonal'))
    } catch { if (isCurrent()) toast.error(actionError('generic')) }
    finally { setPending(false) }
  }
  const current = options.find(option => option.value === task.scope)?.label ?? task.scope
  return <div className="flex min-w-0 items-center gap-2">
    <IssuePropertyMenu variant="row" label={t('label')} value={task.scope} options={options} icon={task.scope === 'workspace' ? Building2 : User} disabled={disabled || pending} displayValue={current} onChange={value => { void change(value) }} />
    {task.scopeSetBy === 'agent' && <span className="truncate text-xs text-muted-foreground">{t('judgedByAgent')}</span>}
  </div>
}
