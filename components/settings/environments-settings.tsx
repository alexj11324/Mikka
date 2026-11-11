'use client'

import { useEffect, useState } from 'react'
import useSWR, { unstable_serialize } from 'swr'
import { useTranslations } from 'next-intl'
import { Archive, Pencil, Plus } from 'lucide-react'
import type { EnvironmentView, EnvironmentsView } from '@/app/actions/environments'
import { saveEnvironment, setProjectDefaultEnvironment } from '@/app/actions/project-resources'
import type { EnvironmentConfiguration } from '@/lib/project-resources/contracts'
import type { ActionResult } from '@/lib/action-result'
import { settingsRead } from '@/lib/settings-read'
import { settingsKeys } from '@/lib/swr/keys'
import { readAccessFailure } from '@/lib/swr/persistent-cache'
import { settingsReadOptions } from '@/lib/settings-data'
import { useLiveKey } from '@/hooks/use-live-key'
import { useActionError } from '@/lib/use-action-error'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SettingsLoading, SettingsSaveError, SettingsSection, SettingRow, settingsSectionAction } from './primitives'

export function EnvironmentsSettings({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('Settings.environments'), common = useTranslations('Common')
  const actionError = useActionError()
  const key = settingsKeys.environments(workspaceId)
  const list = useSWR<ActionResult<EnvironmentsView>>(key, () => settingsRead('environments', { workspace: workspaceId }), settingsReadOptions)
  useLiveKey('workspace_settings', workspaceId, [unstable_serialize(key)], workspaceId)
  const data = !list.error && list.data && !list.data.error ? list.data : null
  const [editing, setEditing] = useState<{ environment?: EnvironmentView } | null>(null)
  const [archiving, setArchiving] = useState<EnvironmentView | null>(null)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const readError = list.error ? actionError() : list.data?.error ? actionError(list.data.error) : null
  const active = data?.environments.filter(environment => !environment.archived) ?? []
  const archived = data?.environments.filter(environment => environment.archived) ?? []
  const canManage = data?.canManage === true
  useEffect(() => {
    if (!canManage) { setEditing(null); setArchiving(null) }
  }, [canManage])
  function refuse(code: string) {
    if (['authRequired', 'workspaceAccessDenied', 'workspaceMembershipSuspended'].includes(code)) {
      setEditing(null); setArchiving(null)
      void list.mutate(undefined, { revalidate: false })
    }
    setFailure(actionError(code))
  }

  async function archive(environment: EnvironmentView, restore = false) {
    setPending(true); setFailure(null)
    try {
      const result = await saveEnvironment({ workspaceId, id: environment.id, revision: environment.revision,
        name: environment.name, configuration: environment.configuration, archived: !restore })
      if (result.error) refuse(result.error)
      else setArchiving(null)
      await list.mutate()
    } catch (error) {
      const access = readAccessFailure(error)
      if (access) refuse(access === 'session' ? 'authRequired' : 'workspaceAccessDenied')
      else setFailure(actionError())
    }
    finally { setPending(false) }
  }

  async function choose(projectId: string, revision: number, environmentId: string) {
    setPending(true); setFailure(null)
    try {
      const result = await setProjectDefaultEnvironment({ workspaceId, projectId, revision, environmentId: environmentId === 'none' ? null : environmentId })
      if (result.error) refuse(result.error)
      await list.mutate()
    } catch (error) {
      const access = readAccessFailure(error)
      if (access) refuse(access === 'session' ? 'authRequired' : 'workspaceAccessDenied')
      else setFailure(actionError())
    }
    finally { setPending(false) }
  }

  return <div className="flex flex-col gap-6" data-settings-state={readError ? 'error' : data ? 'ready' : 'loading'}>
    <SettingsSection id="environments-heading" title={t('title')} action={data?.canManage ?
      <Button {...settingsSectionAction} onClick={() => setEditing({})}><Plus data-icon="inline-start" />{t('add')}</Button> : undefined}>
      {!data && !readError && <SettingsLoading bare rows={2} label={common('loading')} />}
      {data && active.length === 0 && <p className="px-5 py-4 text-sm text-muted-foreground">{t('empty')}</p>}
      {active.map(environment => <SettingRow key={environment.id} title={environment.name}
        description={t('version', { revision: environment.revision })}>
        {canManage && <div className="flex gap-1">
          <Button variant="ghost" size="icon-sm" disabled={pending} aria-label={t('editNamed', { name: environment.name })} onClick={() => setEditing({ environment })}><Pencil /></Button>
          <Button variant="ghost" size="icon-sm" disabled={pending} aria-label={t('archiveNamed', { name: environment.name })} onClick={() => setArchiving(environment)}><Archive /></Button>
        </div>}
      </SettingRow>)}
    </SettingsSection>
    {data && data.projects.length > 0 && <SettingsSection id="environment-defaults" title={t('projectDefaults')}>
      {data.projects.map(project => {
        const items = [{ value: 'none', label: t('none') }, ...active.map(environment => ({ value: environment.id, label: environment.name }))]
        if (project.environmentId && !active.some(environment => environment.id === project.environmentId)) items.push({ value: project.environmentId, label: t('archived') })
        return <SettingRow key={project.id} title={project.name}><Select value={project.environmentId ?? 'none'} items={items}
          disabled={!data.canManage || pending} onValueChange={value => { if (value) void choose(project.id, project.revision, value) }}>
          <SelectTrigger className="w-48" aria-label={t('defaultFor', { name: project.name })}><SelectValue /></SelectTrigger>
          <SelectContent><SelectGroup>{items.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
        </Select></SettingRow>
      })}
    </SettingsSection>}
    {archived.length > 0 && <SettingsSection id="archived-environments" title={t('archived')}>
      {archived.map(environment => <SettingRow key={environment.id} title={environment.name} description={t('version', { revision: environment.revision })}>
        {canManage && <Button variant="outline" size="sm" disabled={pending} onClick={() => { void archive(environment, true) }}>{t('restore')}</Button>}
      </SettingRow>)}
    </SettingsSection>}
    {readError && <SettingsSaveError message={readError} retryLabel={common('retry')} onRetry={() => { void list.mutate() }} />}
    {failure && <FieldError>{failure}<Button variant="link" size="sm" onClick={() => { setEditing(null); setArchiving(null); setFailure(null); void list.mutate() }}>{common('refresh')}</Button></FieldError>}
    {canManage && editing && <EnvironmentEditor key={`${editing.environment?.id ?? 'new'}:${editing.environment?.revision ?? 0}`} workspaceId={workspaceId} environment={editing.environment}
      onClose={() => setEditing(null)} onRefused={refuse} onReload={() => { setEditing(null); void list.mutate() }} onSaved={() => { setEditing(null); void list.mutate() }} />}
    <AlertDialog open={canManage && !!archiving} onOpenChange={open => { if (!open && !pending) setArchiving(null) }}>
      <AlertDialogContent aria-describedby={undefined}>
        <AlertDialogHeader><AlertDialogTitle>{t('archiveNamed', { name: archiving?.name ?? '' })}</AlertDialogTitle></AlertDialogHeader>
        {failure && <FieldError>{failure}<Button variant="link" size="sm" onClick={() => { setArchiving(null); setFailure(null); void list.mutate() }}>{common('refresh')}</Button></FieldError>}
        <AlertDialogFooter><AlertDialogCancel disabled={pending}>{common('cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={pending} onClick={event => { event.preventDefault(); if (archiving) void archive(archiving) }}>{t('archive')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
}

function EnvironmentEditor({ workspaceId, environment, onClose, onSaved, onRefused, onReload }: {
  workspaceId: string; environment?: EnvironmentView; onClose: () => void; onSaved: () => void
  onRefused: (code: string) => void; onReload: () => void
}) {
  const t = useTranslations('Settings.environments'), common = useTranslations('Common'), actionError = useActionError()
  const [name, setName] = useState(environment?.name ?? '')
  const [runtime, setRuntime] = useState<EnvironmentConfiguration['runtime']>(environment?.configuration.runtime ?? 'any')
  const [command, setCommand] = useState(environment?.configuration.setup?.command ?? '')
  const [copyFiles, setCopyFiles] = useState(environment?.configuration.setup?.copyFiles.join('\n') ?? '')
  const [approved, setApproved] = useState(environment?.configuration.setup?.approved ?? false)
  const [pending, setPending] = useState(false), [failure, setFailure] = useState<string | null>(null)
  const options = (['any', 'local', 'cloud'] as const).map(value => ({ value, label: t(`runtimes.${value}`) }))
  async function save() {
    const existing: EnvironmentConfiguration = environment?.configuration ?? { runtime: 'any', harness: 'any', variables: {}, secretIds: [], repositoryKeys: [] }
    const files = copyFiles.split('\n').map(path => path.trim()).filter(Boolean)
    const setup = { copyFiles: files, ...(command.trim() ? { command } : {}), approved }
    const configuration: EnvironmentConfiguration = { ...existing, runtime, setup: setup.command || setup.copyFiles.length ? setup : undefined }
    if (!name.trim() || files.length > 200 || files.some(path => path.length > 1000)) { setFailure(t('invalid')); return }
    setPending(true); setFailure(null)
    try {
      const result = await saveEnvironment({ workspaceId, name: name.trim(), configuration,
        ...(environment ? { id: environment.id, revision: environment.revision } : {}) })
      if (result.error) {
        if (['authRequired', 'workspaceAccessDenied', 'workspaceMembershipSuspended'].includes(result.error)) onRefused(result.error)
        else setFailure(actionError(result.error))
      }
      else onSaved()
    } catch (error) {
      const access = readAccessFailure(error)
      if (access) onRefused(access === 'session' ? 'authRequired' : 'workspaceAccessDenied')
      else setFailure(actionError())
    }
    finally { setPending(false) }
  }
  return <Dialog open onOpenChange={open => { if (!open && !pending) onClose() }}>
    <DialogContent aria-describedby={undefined}>
      <DialogHeader><DialogTitle>{environment ? t('edit') : t('add')}</DialogTitle></DialogHeader>
      <form onSubmit={event => { event.preventDefault(); void save() }} className="flex flex-col gap-5">
        <FieldGroup>
          <Field><FieldLabel htmlFor="environment-name">{t('name')}</FieldLabel><Input id="environment-name" value={name} maxLength={120} required disabled={pending} onChange={event => setName(event.target.value)} /></Field>
          <Field><FieldLabel htmlFor="environment-runtime">{t('runtime')}</FieldLabel><Select items={options} value={runtime} disabled={pending}
            onValueChange={value => { if (value === 'any' || value === 'local' || value === 'cloud') setRuntime(value) }}>
            <SelectTrigger id="environment-runtime"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{options.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectGroup></SelectContent>
          </Select></Field>
          <Field><FieldLabel htmlFor="environment-setup">{t('setup')}</FieldLabel><Textarea id="environment-setup" value={command} maxLength={2000} rows={5} disabled={pending} onChange={event => { setCommand(event.target.value); setApproved(false) }} /></Field>
          <Field><FieldLabel htmlFor="environment-copy">{t('copyFiles')}</FieldLabel><Textarea id="environment-copy" value={copyFiles} rows={3} disabled={pending} onChange={event => { setCopyFiles(event.target.value); setApproved(false) }} /></Field>
          <Field orientation="horizontal"><Checkbox id="environment-approved" checked={approved} disabled={pending} onCheckedChange={value => setApproved(value === true)} /><FieldLabel htmlFor="environment-approved">{t('approveSetup')}</FieldLabel></Field>
        </FieldGroup>
        {failure && <FieldError>{failure}<Button type="button" variant="link" size="sm" onClick={onReload}>{common('refresh')}</Button></FieldError>}
        <DialogFooter><Button type="button" variant="outline" disabled={pending} onClick={onClose}>{common('cancel')}</Button><Button type="submit" disabled={pending}>{pending ? common('saving') : common('save')}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
}
