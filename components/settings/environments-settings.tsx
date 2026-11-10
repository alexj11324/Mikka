'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Archive, Cloud, Copy, Laptop, MoreHorizontal, Pencil, Plus } from 'lucide-react'
import type { EnvironmentView } from '@/app/actions/environments'
import { archiveEnvironment } from '@/app/actions/environments'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Badge } from '@/components/reui/badge'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { FieldError } from '@/components/ui/field'
import { EnvironmentEditorDialog } from './environment-editor'
import { EnvironmentRunActions } from './environment-run-actions'
import { SettingsLoading, SettingsSaveError, SettingsSection, SettingRow, settingsSectionAction } from './primitives'
import { useEnvironments } from './environments-data'

/** 设置 › 运行环境 (issue #1734): versioned scripts and Run Actions per
 * project or workspace default, with the frozen revision of every run. */
export function EnvironmentsSettings({ workspaceId, canManage }: { workspaceId: string; canManage: boolean }) {
  const t = useTranslations('Settings.environments')
  const common = useTranslations('Common')
  const envError = (code?: string | null) => code && t.has(`errors.${code}` as never) ? t(`errors.${code}` as never) : t('errors.generic')
  const list = useEnvironments(workspaceId)
  const [editing, setEditing] = useState<{ environment: EnvironmentView | null; duplicate?: boolean } | null>(null)
  const [archiving, setArchiving] = useState<EnvironmentView | null>(null)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const result = list.data
  const data = result && !('error' in result) ? result : null
  const readError = list.error ? t('errors.generic') : result && 'error' in result ? envError(result.error) : null
  const writable = canManage && Boolean(data)

  async function archive(environment: EnvironmentView) {
    setPending(true); setFailure(null)
    try {
      const saved = await archiveEnvironment({ id: environment.id, revision: environment.revision }, workspaceId)
      if (saved.error) setFailure(saved.error)
      else setArchiving(null)
      await list.mutate()
    } catch { setFailure('environmentSaveFailed') }
    finally { setPending(false) }
  }

  return <>
    <SettingsSection id="environments-heading" title={t('title')} description={canManage ? t('description') : t('memberDescription')}
      action={writable ? <Button {...settingsSectionAction} disabled={pending} onClick={() => { setFailure(null); setEditing({ environment: null }) }}><Plus data-icon="inline-start" />{t('add')}</Button> : undefined}>
      {!data && !readError && <SettingsLoading bare rows={2} label={t('loading')} />}
      {data?.environments.length === 0 && <p className="px-5 py-4 text-sm text-muted-foreground">{t('empty')}</p>}
      {data?.environments.map(environment => <SettingRow key={environment.id} title={environment.name}
        icon={environment.runtime === 'cloud' ? <Cloud aria-hidden="true" className="size-4 text-muted-foreground" /> : <Laptop aria-hidden="true" className="size-4 text-muted-foreground" />}
        description={<span className="flex min-w-0 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            {environment.isDefault && <Badge variant="secondary">{t('defaultBadge')}</Badge>}
            <span>{environment.projectName ?? t('workspaceDefault')}</span>
            <span>{environment.runtime === 'cloud' ? t('runtimeCloud') : t('runtimeLocal')}</span>
            <span>{t('version', { version: environment.revision })}</span>
            <span>{t('actionCount', { count: environment.actions.length })}</span>
            <span>{t('boundRuns', { count: environment.boundRunCount })}</span>
          </span>
          {environment.lastExecution && <span className="text-xs">{t('lastExecution', { name: environment.lastExecution.actionName, status: t(`status.${environment.lastExecution.status}`) })}</span>}
          {environment.setupScript || environment.installScript ? <span className="text-xs">{t('hasScripts')}</span> : <span className="text-xs">{t('noScripts')}</span>}
        </span>}>
        {writable && <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" disabled={pending} aria-label={t('actionsNamed', { name: environment.name })} />}><MoreHorizontal data-icon="inline-start" /></DropdownMenuTrigger>
          <DropdownMenuContent align="end"><DropdownMenuGroup>
            <DropdownMenuItem onClick={() => { setFailure(null); setEditing({ environment }) }}><Pencil />{t('edit')}</DropdownMenuItem>
            <DropdownMenuItem onClick={() => { setFailure(null); setEditing({ environment, duplicate: true }) }}><Copy />{t('duplicate')}</DropdownMenuItem>
            <DropdownMenuItem onClick={() => { setFailure(null); setArchiving(environment) }}><Archive />{t('archive')}</DropdownMenuItem>
          </DropdownMenuGroup></DropdownMenuContent>
        </DropdownMenu>}
      </SettingRow>)}
    </SettingsSection>
    {readError && <SettingsSaveError message={readError} retryLabel={common('retry')} onRetry={() => { void list.mutate() }} />}
    {failure && <FieldError className="px-1">{envError(failure)}</FieldError>}
    {data && <EnvironmentRunActions workspaceId={workspaceId} runs={data.eligibleRuns} />}
    {editing && data && <EnvironmentEditorDialog key={(editing.duplicate ? 'copy:' : '') + (editing.environment?.id ?? 'new')} workspaceId={workspaceId} environment={editing.environment} duplicate={editing.duplicate} projects={data.projects}
      onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void list.mutate() }} />}
    <AlertDialog open={archiving !== null} onOpenChange={open => { if (!open && !pending) setArchiving(null) }}>
      <AlertDialogContent aria-describedby={undefined}>
        <AlertDialogHeader><AlertDialogTitle>{t('archiveNamed', { name: archiving?.name ?? '' })}</AlertDialogTitle></AlertDialogHeader>
        {failure && <FieldError>{envError(failure)}</FieldError>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{common('cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={pending} onClick={event => { event.preventDefault(); if (archiving) void archive(archiving) }}>{pending ? common('saving') : t('archive')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>
}
