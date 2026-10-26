'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Building2, User } from 'lucide-react'
import { toast } from 'sonner'
import { confirmIssuePersonalScope, previewIssuePersonalScope, setIssueScope } from '@/app/actions/issues'
import { useActionError } from '@/lib/use-action-error'
import type { TaskScope } from '@/lib/task-identifier'
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { IssuePropertyMenu } from './issue-property-menu'
import type { MetadataSavedIssue } from './issue-metadata-controls'

type Preview = Extract<Awaited<ReturnType<typeof previewIssuePersonalScope>>, { preview: unknown }>['preview']
type Check = { state: 'checking' } | { state: 'ready'; preview: Preview } | { state: 'error'; message: string }

/** Thrown action failures (authRequired) reach the client as a rejected call; in
 * production their message is redacted, so anything else reads as generic. */
function thrownCode(error: unknown) {
  return error instanceof Error && error.message === 'authRequired' ? 'authRequired' : 'generic'
}

/**
 * Workspace or personal; one click changes it (MIK-47). Moving a shared task
 * back to personal (#184) asks first: it previews the recorded Linear state and
 * confirms against that preview's digest, so nothing that changed in between is
 * moved silently. A task with a Linear link, publication or unfinished sync stays
 * blocked by the server; this dialog never unlinks or archives anything itself.
 */
export function IssueScopeControl({ task, disabled, onSaved }: {
  task: { id: string; revision: number; scope: TaskScope; scopeSetBy: 'agent' | 'user' }
  disabled?: boolean
  onSaved: (issue: MetadataSavedIssue) => void
}) {
  const t = useTranslations('Issue.scope')
  const tCommon = useTranslations('Common')
  const actionError = useActionError()
  const [pending, setPending] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [check, setCheck] = useState<Check>({ state: 'checking' })
  const options = [
    { value: 'workspace', label: t('workspace'), icon: Building2 },
    { value: 'personal', label: t('personal'), icon: User },
  ]

  async function preview() {
    setCheck({ state: 'checking' })
    try {
      const result = await previewIssuePersonalScope(task.id)
      if ('error' in result) setCheck({ state: 'error', message: actionError(result.error) })
      else setCheck({ state: 'ready', preview: result.preview })
    } catch (error) { setCheck({ state: 'error', message: actionError(thrownCode(error)) }) }
  }

  async function toWorkspace() {
    setPending(true)
    try {
      const result = await setIssueScope({ id: task.id, revision: task.revision, scope: 'workspace' })
      if (!('issue' in result) || !result.issue) { toast.error(actionError(result.error)); return }
      onSaved(result.issue)
      toast.success(t('movedToWorkspace'))
    } catch (error) { toast.error(actionError(thrownCode(error))) }
    finally { setPending(false) }
  }

  async function toPersonal() {
    if (check.state !== 'ready' || pending) return
    setPending(true)
    try {
      const { revision, confirmation } = check.preview
      const result = await confirmIssuePersonalScope({ id: task.id, revision, confirmation })
      if ('issue' in result && result.issue) {
        onSaved(result.issue)
        setConfirming(false)
        toast.success(t('movedToPersonal'))
        return
      }
      const code = 'error' in result ? result.error : null
      // The task or its Linear state changed after the preview: show the new state and ask again.
      if (code === 'issueStale') { await preview(); toast.error(actionError(code)); return }
      setCheck({ state: 'error', message: actionError(code) })
    } catch (error) { setCheck({ state: 'error', message: actionError(thrownCode(error)) }) }
    finally { setPending(false) }
  }

  function change(value: string) {
    if (value === task.scope || pending) return
    if (value === 'workspace') { void toWorkspace(); return }
    setConfirming(true)
    void preview()
  }

  const blocked = check.state === 'ready' && check.preview.externalCopyPossible
  const alreadyPersonal = check.state === 'ready' && check.preview.scope === 'personal'
  const current = options.find(option => option.value === task.scope)?.label ?? task.scope
  return <div className="flex min-w-0 items-center gap-2">
    <IssuePropertyMenu variant="row" label={t('label')} value={task.scope} options={options} icon={task.scope === 'workspace' ? Building2 : User} disabled={disabled || pending} displayValue={current} onChange={change} />
    {/* Personal is the default, not a judgment; only an agent's move to the workspace is labelled. */}
    {task.scope === 'workspace' && task.scopeSetBy === 'agent' && <span className="truncate text-xs text-muted-foreground">{t('judgedByAgent')}</span>}
    <AlertDialog open={confirming} onOpenChange={open => { if (!pending) setConfirming(open) }}>
      <AlertDialogContent aria-busy={check.state === 'checking' || pending}>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('confirm.title')}</AlertDialogTitle>
          <AlertDialogDescription>{t('confirm.description')}</AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-muted-foreground">
          <li>{t('confirm.linearCopy')}</li>
          <li>{t('confirm.archiveIsNotErasure')}</li>
        </ul>
        <div aria-live="polite" className="text-sm empty:hidden">
          {check.state === 'checking' && <p className="flex items-center gap-2 text-muted-foreground"><Spinner role="presentation" aria-hidden="true" className="size-3.5" />{t('confirm.checking')}</p>}
          {blocked && <p role="alert" className="text-destructive">{t('confirm.blocked')}</p>}
          {alreadyPersonal && <p>{t('confirm.alreadyPersonal')}</p>}
          {check.state === 'error' && <p role="alert" className="text-destructive">{check.message}</p>}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel autoFocus disabled={pending}>{tCommon('cancel')}</AlertDialogCancel>
          {check.state === 'error'
            ? <Button variant="outline" onClick={() => { void preview() }}>{t('confirm.recheck')}</Button>
            : <Button variant="destructive" disabled={check.state !== 'ready' || blocked || alreadyPersonal || pending} onClick={() => { void toPersonal() }}>
              {pending && <Spinner data-icon="inline-start" role="presentation" aria-hidden="true" />}{t('confirm.action')}
            </Button>}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
}
