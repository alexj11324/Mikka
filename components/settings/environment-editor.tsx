'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { EnvironmentView } from '@/app/actions/environments'
import { saveEnvironment } from '@/app/actions/environments'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldTitle } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import type { EnvironmentActionKind } from '@/lib/environments/contract'
import { ENVIRONMENT_ACTION_KINDS, ENVIRONMENT_LIMITS } from '@/lib/environments/contract'
import { emptyEnvironmentDraft, environmentDraft, environmentSaveBody, newAction, type EnvironmentDraft } from './environments-data'

/** 设置 › 运行环境 › add or edit. Saving appends a revision; the dialog says
 * that only new tasks pick it up. */
export function EnvironmentEditorDialog({ workspaceId, environment, duplicate = false, projects, onClose, onSaved }: {
  workspaceId: string
  environment: EnvironmentView | null
  duplicate?: boolean
  projects: { id: string; name: string }[]
  onClose: () => void
  onSaved: () => void
}) {
  const t = useTranslations('Settings.environments')
  const common = useTranslations('Common')
  const [draft, setDraft] = useState<EnvironmentDraft>(() => environment ? environmentDraft(environment, duplicate) : emptyEnvironmentDraft())
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const change = (patch: Partial<EnvironmentDraft>) => { setDraft(current => ({ ...current, ...patch })); setFailure(null) }
  const changeAction = (id: string, patch: Partial<EnvironmentDraft['actions'][number]>) =>
    change({ actions: draft.actions.map(action => action.id === id ? { ...action, ...patch } : action) })
  const moveAction = (index: number, delta: number) => {
    const next = [...draft.actions]
    const target = index + delta
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target]!, next[index]!]
    change({ actions: next })
  }
  const invalid = !draft.name.trim() || draft.actions.some(action => !action.name.trim() || !action.command.trim())

  async function save() {
    if (pending || invalid) return
    setPending(true); setFailure(null)
    try {
      const result = await saveEnvironment(environmentSaveBody(draft, environment && !duplicate ? environment.revision : undefined), workspaceId)
      if (result.error) { setFailure(result.error); return }
      toast.success(t('saved'))
      onSaved()
    } catch { setFailure('environmentSaveFailed') }
    finally { setPending(false) }
  }

  return <Dialog open onOpenChange={open => { if (!open && !pending) onClose() }}>
    <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-2xl" aria-describedby={undefined} closeLabel={common('close')}>
      <DialogTitle className="pr-8">{duplicate ? t('copyTitle') : environment ? t('editTitle') : t('addTitle')}</DialogTitle>
      <form className="flex min-h-0 flex-col gap-4" onSubmit={event => { event.preventDefault(); void save() }}>
        <FieldGroup className="min-h-0 overflow-y-auto px-0.5 pb-1">
          <Field><FieldLabel htmlFor="environment-name">{t('name')}</FieldLabel>
            <Input id="environment-name" value={draft.name} maxLength={ENVIRONMENT_LIMITS.name} required disabled={pending} onChange={event => change({ name: event.target.value })} /></Field>
          <Field><FieldLabel htmlFor="environment-description">{t('descriptionField')}</FieldLabel>
            <Textarea id="environment-description" className="min-h-16 resize-y" value={draft.description} maxLength={ENVIRONMENT_LIMITS.description} disabled={pending} onChange={event => change({ description: event.target.value })} /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field><FieldLabel htmlFor="environment-project">{t('project')}</FieldLabel>
              <Select value={draft.projectId ?? 'workspace'} disabled={pending} onValueChange={value => change({ projectId: value === 'workspace' ? null : value })}
                items={[{ value: 'workspace', label: t('workspaceDefault') }, ...projects.map(project => ({ value: project.id, label: project.name }))]}>
                <SelectTrigger id="environment-project" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent><SelectGroup>
                  <SelectItem value="workspace">{t('workspaceDefault')}</SelectItem>
                  {projects.map(project => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}
                </SelectGroup></SelectContent>
              </Select></Field>
            <Field><FieldLabel htmlFor="environment-runtime">{t('runtime')}</FieldLabel>
              <Select value={draft.runtime} disabled={pending} onValueChange={value => { if (value === 'cloud' || value === 'local') change({ runtime: value }) }}
                items={[{ value: 'cloud', label: t('runtimeCloud') }, { value: 'local', label: t('runtimeLocal') }]}>
                <SelectTrigger id="environment-runtime" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent><SelectGroup>
                  <SelectItem value="cloud">{t('runtimeCloud')}</SelectItem>
                  <SelectItem value="local">{t('runtimeLocal')}</SelectItem>
                </SelectGroup></SelectContent>
              </Select></Field>
          </div>
          <Field><FieldLabel htmlFor="environment-workdir">{t('workdir')}</FieldLabel>
            <Input id="environment-workdir" value={draft.workdir} maxLength={ENVIRONMENT_LIMITS.workdir} disabled={pending} placeholder={t('workdirPlaceholder')} onChange={event => change({ workdir: event.target.value })} /></Field>
          <Field><FieldLabel htmlFor="environment-install">{t('installScript')}</FieldLabel>
            <Textarea id="environment-install" className="min-h-20 resize-y font-mono text-xs" value={draft.installScript} disabled={pending} placeholder={t('installPlaceholder')} onChange={event => change({ installScript: event.target.value })} />
            <p className="text-xs text-muted-foreground">{t('scriptsHint')}</p></Field>
          <Field><FieldLabel htmlFor="environment-setup">{t('setupScript')}</FieldLabel>
            <Textarea id="environment-setup" className="min-h-20 resize-y font-mono text-xs" value={draft.setupScript} disabled={pending} placeholder={t('setupPlaceholder')} onChange={event => change({ setupScript: event.target.value })} /></Field>
          <Field><FieldLabel htmlFor="environment-repositories">{t('repositories')}</FieldLabel>
            <Textarea id="environment-repositories" className="min-h-16 resize-y font-mono text-xs" value={draft.repositories} disabled={pending} placeholder={t('repositoriesPlaceholder')} onChange={event => change({ repositories: event.target.value })} /></Field>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldTitle>{t('defaultTitle')}</FieldTitle>
              <FieldDescription>{t('defaultDescription')}</FieldDescription>
            </FieldContent>
            <Switch checked={draft.isDefault} disabled={pending} aria-label={t('defaultTitle')} onCheckedChange={checked => change({ isDefault: checked })} />
          </Field>
          <Field>
            <div className="flex items-center justify-between gap-3">
              <div><FieldLabel>{t('actions')}</FieldLabel><p className="text-sm text-muted-foreground">{t('actionsHint')}</p></div>
              <Button type="button" variant="secondary" size="sm" disabled={pending || draft.actions.length >= ENVIRONMENT_LIMITS.actions} onClick={() => change({ actions: [...draft.actions, newAction()] })}>
                <Plus data-icon="inline-start" />{t('addAction')}
              </Button>
            </div>
            <div className="flex flex-col gap-3">
              {draft.actions.length === 0 && <p className="text-sm text-muted-foreground">{t('noActions')}</p>}
              {draft.actions.map((action, index) => <div key={action.id} className="flex flex-col gap-2 border-t border-border pt-3 first:border-t-0 first:pt-0">
                <div className="grid gap-2 sm:grid-cols-[7rem_1fr_5rem]">
                  <Select value={action.kind} disabled={pending} onValueChange={value => { if (ENVIRONMENT_ACTION_KINDS.includes(value as EnvironmentActionKind)) changeAction(action.id, { kind: value as EnvironmentActionKind }) }}
                    items={ENVIRONMENT_ACTION_KINDS.map(kind => ({ value: kind, label: t(`kinds.${kind}`) }))}>
                    <SelectTrigger className="w-full" aria-label={t('actionKind')}><SelectValue /></SelectTrigger>
                    <SelectContent><SelectGroup>{ENVIRONMENT_ACTION_KINDS.map(kind => <SelectItem key={kind} value={kind}>{t(`kinds.${kind}`)}</SelectItem>)}</SelectGroup></SelectContent>
                  </Select>
                  <Input value={action.name} maxLength={ENVIRONMENT_LIMITS.actionName} disabled={pending} aria-label={t('actionName')} placeholder={t('actionName')} onChange={event => changeAction(action.id, { name: event.target.value })} />
                  <Input type="number" min={ENVIRONMENT_LIMITS.minTimeoutSeconds} max={ENVIRONMENT_LIMITS.maxTimeoutSeconds} value={action.timeoutSeconds} disabled={pending} aria-label={t('actionTimeout')} onChange={event => changeAction(action.id, { timeoutSeconds: Number(event.target.value) || ENVIRONMENT_LIMITS.defaultTimeoutSeconds })} />
                </div>
                <Input value={action.command} maxLength={ENVIRONMENT_LIMITS.command} disabled={pending} aria-label={t('actionCommand')} placeholder={t('actionCommandPlaceholder')} className="font-mono text-xs" onChange={event => changeAction(action.id, { command: event.target.value })} />
                <div className="flex items-center justify-end gap-1">
                  <Button type="button" variant="ghost" size="icon-sm" disabled={pending || index === 0} aria-label={t('moveUp')} onClick={() => moveAction(index, -1)}><ArrowUp data-icon="inline-start" /></Button>
                  <Button type="button" variant="ghost" size="icon-sm" disabled={pending || index === draft.actions.length - 1} aria-label={t('moveDown')} onClick={() => moveAction(index, 1)}><ArrowDown data-icon="inline-start" /></Button>
                  <Button type="button" variant="ghost" size="icon-sm" disabled={pending} aria-label={t('removeAction', { name: action.name })} onClick={() => change({ actions: draft.actions.filter(item => item.id !== action.id) })}><Trash2 data-icon="inline-start" /></Button>
                </div>
              </div>)}
            </div>
          </Field>
          <p className="text-xs text-muted-foreground">{t('revisionHint')}</p>
          {failure && <FieldError>{t.has(`errors.${failure}` as never) ? t(`errors.${failure}` as never) : t('errors.generic')}</FieldError>}
        </FieldGroup>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={onClose}>{common('cancel')}</Button>
          <Button type="submit" disabled={pending || invalid}>{pending ? common('saving') : common('save')}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
}
