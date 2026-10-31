'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { Cloud } from 'lucide-react'
import { createSecret, deleteSecret, replaceSecret, type listSecrets } from '@/app/actions/workspace-secrets'
import { E2BKeyDialog, useE2BKeyStatus } from '@/components/settings/e2b-key-dialog'
import { settingsRead } from '@/lib/settings-read'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { FieldError } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SettingRow, SettingsLoading, SettingsSection, settingsSectionAction } from '@/components/settings/primitives'
import type { WorkspaceSecretView } from '@/lib/secrets/store'
import { useActionError } from '@/lib/use-action-error'
import { cn } from '@/lib/utils'
import { usePresence, type PresenceProps } from '@/lib/use-presence'

/** Rows grouped as N5 shows them: 工作区 first, then one group per repository. */
function groupByScope(secrets: WorkspaceSecretView[]) {
  const groups = new Map<string, WorkspaceSecretView[]>()
  for (const secret of secrets) {
    const key = secret.scopeType === 'workspace' ? '' : secret.scopeRef
    groups.set(key, [...groups.get(key) ?? [], secret])
  }
  return [...groups.entries()].sort(([a], [b]) => a === '' ? -1 : b === '' ? 1 : a.localeCompare(b))
}

/** N5 密钥与环境: workspace and repository secrets and environment variables. Values are write-only. */
export function SecretsSettings({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('Settings.secrets')
  const actionError = useActionError()
  const list = useSWR(['settings:secrets', workspaceId], () => settingsRead<Awaited<ReturnType<typeof listSecrets>>>('secrets', { workspace: workspaceId }))
  const [editing, setEditing] = useState<WorkspaceSecretView | 'new' | null>(null)
  const secretDialog = usePresence(editing)
  const [warning, setWarning] = useState<string | null>(null)
  const secrets = list.data && !list.data.error ? list.data.secrets : null

  return <>
    <SettingsSection id="secrets-heading" title={t('heading')} action={<Button {...settingsSectionAction} onClick={() => { setWarning(null); setEditing('new') }}>{t('add')}</Button>}>
      {!list.data && !list.error && <SettingsLoading label={t('loading')} rows={2} />}
      {(list.error || list.data?.error) && <FieldError className="px-5 py-4">{actionError(list.data?.error)}</FieldError>}
      {secrets?.length === 0 && <p className="px-5 py-4 text-sm text-muted-foreground">{t('empty')}</p>}
      {secrets && groupByScope(secrets).map(([repository, rows]) => <div key={repository || 'workspace'} role="group" aria-label={repository ? t('repositoryGroup', { repository }) : t('workspaceGroup')}>
        <p className="px-5 pt-3 text-xs font-medium text-muted-foreground">{repository ? t('repositoryGroup', { repository }) : t('workspaceGroup')}</p>
        <div className="divide-y divide-border">
          {rows.map(secret => <SecretRow key={secret.id} secret={secret} onEdit={() => { setWarning(null); setEditing(secret) }} />)}
        </div>
      </div>)}
    </SettingsSection>
    {warning && <p role="status" className="px-1 text-sm text-muted-foreground">{warning}</p>}
    {secretDialog.value && <SecretDialog open={secretDialog.open} onOpenChangeComplete={secretDialog.onOpenChangeComplete} workspaceId={workspaceId} secret={secretDialog.value === 'new' ? null : secretDialog.value} onClose={saved => {
      setEditing(null)
      if (saved?.warning === 'shortValueNotMasked') setWarning(t('shortValueNotMasked', { name: saved.name }))
      if (saved) void list.mutate()
    }} />}
    <E2BKeySettings workspaceId={workspaceId} />
  </>
}

/** BYO E2B: the workspace's own E2B API key for cloud computers. Write-only; the row shows its state only. */
function E2BKeySettings({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('Settings.secrets.e2b')
  const actionError = useActionError()
  const status = useE2BKeyStatus(workspaceId)
  const [open, setOpen] = useState(false)
  const keyDialog = usePresence(open)
  const data = status.data && !status.data.error ? status.data : null
  const state = !data ? null : !data.configured ? 'missing' : data.lastErrorCode ? `errors.${data.lastErrorCode}` : 'configured'

  return <>
    <SettingsSection id="e2b-heading" title={t('heading')}>
      {!status.data && !status.error && <SettingsLoading label={t('loading')} rows={1} />}
      {(status.error || status.data?.error) && <FieldError className="px-5 py-4">{actionError(status.data?.error)}</FieldError>}
      {data && state && <SettingRow title="E2B API Key" icon={<Cloud aria-hidden="true" className="size-4 text-muted-foreground" />}>
        <div className="flex items-center gap-3">
          <span role="status" className={cn(data.lastErrorCode ? 'text-destructive' : 'text-muted-foreground')}>{t(state as 'missing')}</span>
          <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)}>{data.configured ? t('replace') : t('set')}</Button>
        </div>
      </SettingRow>}
    </SettingsSection>
    {keyDialog.value && data && <E2BKeyDialog open={keyDialog.open} onOpenChangeComplete={keyDialog.onOpenChangeComplete} configured={data.configured} onClose={changed => { setOpen(false); if (changed) void status.mutate() }} />}
  </>
}

function SecretRow({ secret, onEdit }: { secret: WorkspaceSecretView; onEdit: () => void }) {
  const t = useTranslations('Settings.secrets')
  return <div className="flex items-center gap-3 px-5 py-3">
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
      <span className="truncate font-mono text-sm">{secret.name}</span>
      {secret.kind === 'env' && <Badge variant="secondary">{t('kinds.env')}</Badge>}
    </div>
    <Button type="button" variant="secondary" size="sm" aria-label={t('editNamed', { name: secret.name })} onClick={onEdit}>{t('edit')}</Button>
  </div>
}

type Saved = { name: string; warning: 'shortValueNotMasked' | null } | null

function SecretDialog({ workspaceId, secret, onClose, open = true, onOpenChangeComplete }: { workspaceId: string; secret: WorkspaceSecretView | null; onClose: (saved: Saved) => void } & PresenceProps) {
  const t = useTranslations('Settings.secrets')
  const commonT = useTranslations('Common')
  const actionError = useActionError()
  const [kind, setKind] = useState<'secret' | 'env'>(secret?.kind ?? 'secret')
  const [name, setName] = useState(secret?.name ?? '')
  const [value, setValue] = useState('')
  const [scope, setScope] = useState<'workspace' | 'repository'>(secret?.scopeType ?? 'workspace')
  const [repository, setRepository] = useState(secret?.scopeRef ?? '')
  const [pending, setPending] = useState<'save' | 'delete' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const kindItems = [{ value: 'secret', label: t('kinds.secret') }, { value: 'env', label: t('kinds.env') }]
  const scopeItems = [{ value: 'workspace', label: t('workspaceGroup') }, { value: 'repository', label: t('repository') }]
  const scopeValue = scope === 'workspace' ? { type: 'workspace' as const } : { type: 'repository' as const, repository: repository.trim() }
  const ready = Boolean(value) && Boolean(name.trim()) && (scope === 'workspace' || /^[^/\s]+\/[^/\s]+$/.test(repository.trim()))

  async function save() {
    setPending('save')
    setError(null)
    try {
      const result = secret
        ? await replaceSecret({ id: secret.id, value, scope: scopeValue }, workspaceId)
        : await createSecret({ name: name.trim(), kind, value, scope: scopeValue }, workspaceId)
      if (result.error) { setError(actionError(result.error)); return }
      onClose({ name: result.name, warning: result.warning })
    } catch {
      setError(actionError())
    } finally {
      setPending(null)
    }
  }

  async function remove() {
    if (!secret) return
    setPending('delete')
    setError(null)
    try {
      const result = await deleteSecret({ id: secret.id }, workspaceId)
      if (result.error) { setError(actionError(result.error)); return }
      onClose({ name: secret.name, warning: null })
    } catch {
      setError(actionError())
    } finally {
      setPending(null)
    }
  }

  return <Dialog open={open} onOpenChangeComplete={onOpenChangeComplete} onOpenChange={open => { if (!open && !pending) onClose(null) }}>
    <DialogContent>
      <DialogHeader><DialogTitle>{secret ? secret.name : t('addTitle')}</DialogTitle></DialogHeader>
      <div className="flex flex-col gap-3">
        {!secret && <>
          <Label className="flex flex-col items-start gap-1.5">{t('kind')}
            <Select value={kind} items={kindItems} onValueChange={next => { if (next === 'secret' || next === 'env') setKind(next) }}>
              <SelectTrigger aria-label={t('kind')} className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent><SelectGroup>{kindItems.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
            </Select>
          </Label>
          <Label className="flex flex-col items-start gap-1.5">{t('name')}
            <Input value={name} className="font-mono" maxLength={128} autoComplete="off" placeholder="VERCEL_TOKEN" onChange={event => setName(event.target.value)} />
          </Label>
        </>}
        <Label className="flex flex-col items-start gap-1.5">{secret ? t('newValue') : t('value')}
          <Input type="password" value={value} autoComplete="new-password" onChange={event => setValue(event.target.value)} />
        </Label>
        <Label className="flex flex-col items-start gap-1.5">{t('scope')}
          <Select value={scope} items={scopeItems} onValueChange={next => { if (next === 'workspace' || next === 'repository') setScope(next) }}>
            <SelectTrigger aria-label={t('scope')} className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent><SelectGroup>{scopeItems.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
          </Select>
        </Label>
        {scope === 'repository' && <Label className="flex flex-col items-start gap-1.5">{t('repository')}
          <Input value={repository} placeholder="owner/repo" autoComplete="off" onChange={event => setRepository(event.target.value)} />
        </Label>}
        {error && <FieldError>{error}</FieldError>}
      </div>
      <DialogFooter>
        {secret && <Button type="button" variant="destructive" className="sm:mr-auto" disabled={pending !== null} onClick={() => void remove()}>{pending === 'delete' ? t('deleting') : commonT('delete')}</Button>}
        <Button type="button" variant="outline" disabled={pending !== null} onClick={() => onClose(null)}>{commonT('cancel')}</Button>
        <Button type="button" disabled={pending !== null || !ready} onClick={() => void save()}>{pending === 'save' ? commonT('saving') : commonT('save')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
