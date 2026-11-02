'use client'

import { useRef, useState, type ChangeEvent } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { deleteWorkspace, transferWorkspace, updateWorkspace, type getWorkspaceDeletionImpact, type getWorkspaceGeneral, type getWorkspaceTransferTargets } from '@/app/actions/workspace-settings'
import { settingsRead } from '@/lib/settings-read'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '@/components/ui/input-group'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SettingRow, SettingsLoading, SettingsSaveError, SettingsSection } from '@/components/settings/primitives'
import { useGatedFeature } from '@/hooks/use-feature-availability'
import { withBasePath } from '@/lib/base-path'
import { resetOnboarding } from '@/app/actions/onboarding'
import { useActionError } from '@/lib/use-action-error'
import { usePresence, type PresenceProps } from '@/lib/use-presence'
import { FieldError } from '@/components/ui/field'

const ICON_MAX_BYTES = 200 * 1024
const ICON_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

type Field = 'name' | 'slug' | 'icon'
interface FailedSave { field: Field; value: string | null; message: string }

function readDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('read failed'))
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsDataURL(file)
  })
}

/**
 * V10 常规: icon, name and address; admins edit them and can delete the workspace (S-I).
 * The owner can transfer it (Alex: 常规 fully wired; no frame draws the row, so it sits in 危险操作 like 删除).
 * Members see plain values.
 */
export function WorkspaceSettings({ workspaceId }: { userKey?: string; workspaceId?: string }) {
  const t = useTranslations('Settings.workspaceForm')
  const commonT = useTranslations('Common')
  const actionError = useActionError()
  const general = useSWR(['workspace:general', workspaceId ?? ''], () => settingsRead<Awaited<ReturnType<typeof getWorkspaceGeneral>>>('workspace-general', { workspace: workspaceId }))
  const data = general.data && !general.data.error ? general.data : null
  const [name, setName] = useState<string | null>(null)
  const [slug, setSlug] = useState<string | null>(null)
  const [saving, setSaving] = useState<Field | null>(null)
  const [failed, setFailed] = useState<FailedSave | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [transferring, setTransferring] = useState(false)
  const transferDialog = usePresence(transferring)
  const deleteDialog = usePresence(deleting)
  const [transferredTo, setTransferredTo] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  // One save at a time: Enter followed by the blur from disabling the field must not send it twice.
  const inFlight = useRef(false)
  // A save asked for while another runs goes next; dropping it would leave a draft that looks saved.
  const queued = useRef<{ field: Field; value: string | null } | null>(null)
  const host = typeof window === 'undefined' ? '' : `${window.location.host}${withBasePath('/w/')}`

  if (!general.data && !general.error) return <SettingsLoading label={t('loading')} rows={3} />
  if (!data) return <div role="alert" className="flex flex-col items-start gap-3 text-sm">
    <p className="text-destructive">{actionError(general.data?.error)}</p>
    <Button variant="outline" size="sm" onClick={() => void general.mutate()}>{commonT('retry')}</Button>
  </div>
  const current = data

  function clearDraft(field: Field) {
    if (field === 'name') setName(null)
    if (field === 'slug') setSlug(null)
  }

  async function save(field: Field, value: string | null) {
    if (inFlight.current) { queued.current = { field, value }; return }
    inFlight.current = true
    setSaving(field)
    setFailed(null)
    try {
      const result = await updateWorkspace({ [field]: value }, current.id)
      // S-O: the shown value goes back to the saved one; 重试 sends the same change again.
      if (result.error) { setFailed({ field, value, message: actionError(result.error) }); return }
      await general.mutate({ ...current, ...result }, { revalidate: false })
    } catch {
      setFailed({ field, value, message: actionError() })
    } finally {
      clearDraft(field)
      setSaving(null)
      inFlight.current = false
      const next = queued.current
      queued.current = null
      if (next) void save(next.field, next.value)
    }
  }

  function commit(field: 'name' | 'slug') {
    const draft = field === 'name' ? name : slug
    if (draft === null) return
    const value = field === 'slug' ? draft.trim().toLowerCase() : draft.trim()
    const saved = field === 'name' ? current.name : current.slug ?? ''
    if (!value || value === saved) { clearDraft(field); return }
    void save(field, value)
  }

  async function pickIcon(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!ICON_TYPES.includes(file.type) || file.size > ICON_MAX_BYTES) { setFailed({ field: 'icon', value: null, message: actionError('workspaceIconInvalid') }); return }
    try { await save('icon', await readDataUrl(file)) } catch { setFailed({ field: 'icon', value: null, message: actionError('workspaceIconInvalid') }) }
  }

  const initial = [...current.name.trim()][0]?.toUpperCase() ?? '?'
  const icon = <Avatar className="size-8"><AvatarImage src={current.icon ?? undefined} alt="" /><AvatarFallback>{initial}</AvatarFallback></Avatar>

  // S-P: members read the same rows as plain values, with no controls.
  if (!current.canEdit) return <><SettingsSection id="workspace-general">
    <SettingRow title={t('icon')}>{icon}</SettingRow>
    <SettingRow title={t('name')}><span>{current.name}</span></SettingRow>
    {current.slug && <SettingRow title={t('address')}><span className="break-all">{host}{current.slug}</span></SettingRow>}
  </SettingsSection></>

  return <>
    <SettingsSection id="workspace-general">
      <SettingRow title={t('icon')}>
        <div className="flex items-center gap-2">
          {icon}
          <Input ref={fileRef} type="file" accept={ICON_TYPES.join(',')} className="sr-only" tabIndex={-1} aria-hidden="true" onChange={event => void pickIcon(event)} />
          {current.icon && <Button type="button" variant="ghost" size="sm" disabled={saving !== null} onClick={() => void save('icon', null)}>{t('removeIcon')}</Button>}
          <Button type="button" variant="secondary" size="sm" disabled={saving !== null} onClick={() => fileRef.current?.click()}>{saving === 'icon' ? commonT('saving') : t('changeIcon')}</Button>
        </div>
      </SettingRow>
      <SettingRow title={t('name')}>
        <Input aria-label={t('name')} className="w-full sm:w-50" maxLength={120} value={name ?? current.name} disabled={saving === 'name'}
          onChange={event => setName(event.target.value)} onBlur={() => commit('name')}
          onKeyDown={event => { if (event.key === 'Enter') commit('name'); if (event.key === 'Escape') setName(null) }} />
      </SettingRow>
      <SettingRow title={t('address')}>
        <InputGroup className="w-full sm:w-72">
          <InputGroupAddon><InputGroupText>{host}</InputGroupText></InputGroupAddon>
          <InputGroupInput aria-label={t('address')} maxLength={64} value={slug ?? current.slug ?? ''} disabled={saving === 'slug'}
            onChange={event => setSlug(event.target.value)} onBlur={() => commit('slug')}
            onKeyDown={event => { if (event.key === 'Enter') commit('slug'); if (event.key === 'Escape') setSlug(null) }} />
        </InputGroup>
      </SettingRow>
    </SettingsSection>
    {failed && <SettingsSaveError message={failed.message} retryLabel={commonT('retry')} onRetry={() => { if (failed.field === 'icon' && failed.value === null) { fileRef.current?.click(); return } void save(failed.field, failed.value) }} />}

    <SettingsSection id="workspace-danger" title={t('danger')}>
      {current.canTransfer && <SettingRow title={t('transferWorkspace')}>
        <Button type="button" variant="secondary" size="sm" onClick={() => setTransferring(true)}>{t('transfer')}</Button>
      </SettingRow>}
      <SettingRow title={t('deleteWorkspace')}>
        {/* Every account keeps its personal workspace (decision 2026-11-02-0203): the row names that state. */}
        {current.personal
          ? <span className="text-sm text-muted-foreground">{t('personalUndeletable')}</span>
          : <Button type="button" variant="destructive" size="sm" onClick={() => setDeleting(true)}>{commonT('delete')}</Button>}
      </SettingRow>
    </SettingsSection>
    {transferredTo && <p role="status" className="text-sm text-muted-foreground">{t('transferred', { name: transferredTo })}</p>}
    {transferDialog.value && <TransferWorkspaceDialog open={transferDialog.open} onOpenChangeComplete={transferDialog.onOpenChangeComplete} workspaceId={current.id} name={current.name} onClose={() => setTransferring(false)}
      onDone={owner => { setTransferring(false); setTransferredTo(owner); void general.mutate() }} />}
    {deleteDialog.value && <DeleteWorkspaceDialog open={deleteDialog.open} onOpenChangeComplete={deleteDialog.onOpenChangeComplete} workspaceId={current.id} name={current.name} onClose={() => setDeleting(false)} />}
  </>
}

/**
 * 重新播放引导 (docs/design/onboarding.md §3): clears this person's completion (`resetOnboarding`)
 * and reloads the app, which shows the first-run guide again. The person's own, so it sits in
 * 偏好设置 and shows in every workspace, a personal one too (decision 2026-11-02-0203).
 */
export function ReplayOnboarding() {
  const t = useTranslations('Settings.workspaceForm')
  const commonT = useTranslations('Common')
  const actionError = useActionError()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function replay() {
    setPending(true)
    setError(null)
    try {
      await resetOnboarding()
      window.location.assign(withBasePath('/'))
    } catch {
      setError(actionError())
      setPending(false)
    }
  }

  return <>
    <SettingsSection id="workspace-onboarding">
      <SettingRow title={t('replayOnboarding')}>
        <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => void replay()}>{pending ? t('replaying') : t('replay')}</Button>
      </SettingRow>
    </SettingsSection>
    {error && <SettingsSaveError message={error} retryLabel={commonT('retry')} onRetry={() => void replay()} />}
  </>
}

/** 转让工作区: pick another active member; they become the owner (and an admin). */
function TransferWorkspaceDialog({ workspaceId, name, onClose, onDone, open = true, onOpenChangeComplete }: { workspaceId: string; name: string; onClose: () => void; onDone: (owner: string) => void } & PresenceProps) {
  const t = useTranslations('Settings.workspaceForm')
  const commonT = useTranslations('Common')
  const actionError = useActionError()
  const targets = useSWR(['workspace:transfer-targets', workspaceId], () => settingsRead<Awaited<ReturnType<typeof getWorkspaceTransferTargets>>>('transfer-targets', { workspace: workspaceId }))
  const people = targets.data && !targets.data.error ? targets.data : null
  const [to, setTo] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const items = (people ?? []).map(person => ({ value: person.userId, label: person.name ? `${person.name} · ${person.email}` : person.email }))

  async function confirm() {
    if (!to) return
    setPending(true)
    setError(null)
    try {
      const result = await transferWorkspace(to, workspaceId)
      if (result.error) { setError(actionError(result.error)); setPending(false); return }
      onDone(result.owner.name || result.owner.email)
    } catch {
      setError(actionError())
      setPending(false)
    }
  }

  return <Dialog open={open} onOpenChangeComplete={onOpenChangeComplete} onOpenChange={open => { if (!open && !pending) onClose() }}>
    <DialogContent>
      <DialogHeader><DialogTitle>{t('transferTitle', { name })}</DialogTitle></DialogHeader>
      <div className="flex flex-col gap-3 text-sm">
        {people
          ? people.length
            ? <Label className="flex flex-col items-start gap-1.5 font-normal text-muted-foreground">{t('transferTo')}
              <Select value={to} items={items} onValueChange={next => setTo(typeof next === 'string' ? next : null)}>
                <SelectTrigger aria-label={t('transferTo')} className="w-full"><SelectValue placeholder={t('transferPick')} /></SelectTrigger>
                <SelectContent><SelectGroup>{items.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
              </Select>
            </Label>
            : <p className="text-muted-foreground">{t('transferNoMembers')}</p>
          : targets.data?.error ? <FieldError>{actionError(targets.data.error)}</FieldError> : <p role="status" className="text-muted-foreground">{t('loading')}</p>}
        {error && <FieldError>{error}</FieldError>}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={pending} onClick={onClose}>{commonT('cancel')}</Button>
        <Button type="button" disabled={pending || !to} onClick={() => void confirm()}>{pending ? t('transferring') : t('transfer')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}

/** S-I: lists what goes, then the name must be typed exactly. */
function DeleteWorkspaceDialog({ workspaceId, name, onClose, open = true, onOpenChangeComplete }: { workspaceId: string; name: string; onClose: () => void } & PresenceProps) {
  const t = useTranslations('Settings.workspaceForm')
  const computerBilling = useGatedFeature('computerBilling')
  const commonT = useTranslations('Common')
  const actionError = useActionError()
  const impact = useSWR(['workspace:deletion-impact', workspaceId], () => settingsRead<Awaited<ReturnType<typeof getWorkspaceDeletionImpact>>>('deletion-impact', { workspace: workspaceId }))
  const counts = impact.data && !impact.data.error ? impact.data : null
  const [typed, setTyped] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function confirm() {
    setPending(true)
    setError(null)
    try {
      const result = await deleteWorkspace(workspaceId, typed)
      if (result.error) { setError(actionError(result.error)); setPending(false); return }
      window.location.assign(withBasePath('/'))
    } catch {
      setError(actionError())
      setPending(false)
    }
  }

  return <Dialog open={open} onOpenChangeComplete={onOpenChangeComplete} onOpenChange={open => { if (!open && !pending) onClose() }}>
    <DialogContent>
      <DialogHeader><DialogTitle>{t('deleteTitle', { name })}</DialogTitle></DialogHeader>
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-muted-foreground">{t('deleteLead')}</p>
        {counts
          ? <ul className="flex list-disc flex-col gap-1 pl-5">
            <li>{t('deleteBots', { count: counts.bots })}</li>
            <li>{t('deleteTasks', { tasks: counts.tasks, teams: counts.teams })}</li>
            {computerBilling && counts.purchasedPoints > 0 && <li>{t('deletePoints', { points: counts.purchasedPoints })}</li>}
          </ul>
          : impact.data?.error ? <FieldError>{actionError(impact.data.error)}</FieldError> : <p role="status" className="text-muted-foreground">{t('loading')}</p>}
        <p className="text-muted-foreground">{t('deleteKept')}</p>
        <Label className="flex flex-col items-start gap-1.5 font-normal text-muted-foreground">{t('deleteConfirmLabel', { name })}
          {/* No placeholder: the name to type is in the label once; a placeholder of it reads as already filled in. */}
          <Input value={typed} autoComplete="off" onChange={event => setTyped(event.target.value)} />
        </Label>
        {error && <FieldError>{error}</FieldError>}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={pending} onClick={onClose}>{commonT('cancel')}</Button>
        <Button type="button" variant="destructive" disabled={pending || typed.trim() !== name} onClick={() => void confirm()}>{pending ? t('deleting') : t('deleteWorkspace')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
