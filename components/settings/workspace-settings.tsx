'use client'

import { useRef, useState, type ChangeEvent } from 'react'
import { useTranslations } from 'next-intl'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '@/components/ui/input-group'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SettingRow, SettingsLoading, SettingsSaveError, SettingsSection } from '@/components/settings/primitives'
import { useGatedFeature } from '@/hooks/use-feature-availability'
import { useReplayOnboarding } from '@/hooks/settings/use-preferences-page'
import { usePresence, type PresenceProps } from '@/lib/use-presence'
import { FieldError } from '@/components/ui/field'
import { WORKSPACE_ICON_TYPES, useDeleteWorkspace, useTransferWorkspace, useWorkspaceGeneral } from '@/hooks/settings/use-workspace-general'

/**
 * V10 常规: icon, name and address; admins edit them and can delete the workspace (S-I).
 * The owner can transfer it (Alex: 常规 fully wired; no frame draws the row, so it sits in 危险操作 like 删除).
 * Members see plain values.
 */
export function WorkspaceSettings({ workspaceId }: { userKey?: string; workspaceId?: string }) {
  const t = useTranslations('Settings.workspaceForm')
  const commonT = useTranslations('Common')
  const general = useWorkspaceGeneral(workspaceId)
  const { name, setName, slug, setSlug, saving, failed, save, commit, host } = general
  const [deleting, setDeleting] = useState(false)
  const [transferring, setTransferring] = useState(false)
  const transferDialog = usePresence(transferring)
  const deleteDialog = usePresence(deleting)
  const [transferredTo, setTransferredTo] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  if (general.loading) return <SettingsLoading label={t('loading')} rows={3} />
  if (!general.data) return <div role="alert" className="flex flex-col items-start gap-3 text-sm">
    <p className="text-destructive-foreground">{general.loadError}</p>
    <Button variant="outline" size="sm" onClick={general.reload}>{commonT('retry')}</Button>
  </div>
  const current = general.data

  async function pickIcon(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    await general.pickIcon(file)
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
          <Input ref={fileRef} type="file" accept={WORKSPACE_ICON_TYPES.join(',')} className="sr-only" tabIndex={-1} aria-hidden="true" onChange={event => void pickIcon(event)} />
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
    {failed && <SettingsSaveError message={failed.message} retryLabel={commonT('retry')} onRetry={() => { if (general.failedPick) { fileRef.current?.click(); return } general.retry() }} />}

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
      onDone={owner => { setTransferring(false); setTransferredTo(owner); general.reload() }} />}
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
  const { pending, error, replay } = useReplayOnboarding()

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
  const { people, canTransferTo, readError, reload, pending, error, transfer } = useTransferWorkspace(workspaceId)
  const [to, setTo] = useState<string | null>(null)
  const items = (people ?? []).map(person => ({ value: person.userId, label: person.name ? `${person.name} · ${person.email}` : person.email }))

  async function confirm() {
    if (!canTransferTo(to)) return
    const owner = await transfer(to)
    if (owner) onDone(owner)
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
          : readError ? <SettingsSaveError message={readError} retryLabel={commonT('retry')} onRetry={() => { void reload() }} /> : <p role="status" className="text-muted-foreground">{t('loading')}</p>}
        {error && <FieldError>{error}</FieldError>}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={pending} onClick={onClose}>{commonT('cancel')}</Button>
        <Button type="button" disabled={pending || !canTransferTo(to)} onClick={() => void confirm()}>{pending ? t('transferring') : t('transfer')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}

/** S-I: lists what goes, then the name must be typed exactly. */
function DeleteWorkspaceDialog({ workspaceId, name, onClose, open = true, onOpenChangeComplete }: { workspaceId: string; name: string; onClose: () => void } & PresenceProps) {
  const t = useTranslations('Settings.workspaceForm')
  const computerBilling = useGatedFeature('computerBilling')
  const commonT = useTranslations('Common')
  const { counts, readError, reload, pending, error, remove } = useDeleteWorkspace(workspaceId)
  const [typed, setTyped] = useState('')

  async function confirm() {
    await remove(typed)
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
          : readError ? <SettingsSaveError message={readError} retryLabel={commonT('retry')} onRetry={() => { void reload() }} /> : <p role="status" className="text-muted-foreground">{t('loading')}</p>}
        <p className="text-muted-foreground">{t('deleteKept')}</p>
        <Label className="flex flex-col items-start gap-1.5 font-normal text-muted-foreground">{t('deleteConfirmLabel', { name })}
          {/* No placeholder: the name to type is in the label once; a placeholder of it reads as already filled in. */}
          <Input value={typed} autoComplete="off" onChange={event => setTyped(event.target.value)} />
        </Label>
        {error && <FieldError>{error}</FieldError>}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={pending} onClick={onClose}>{commonT('cancel')}</Button>
        <Button type="button" variant="destructive" disabled={!counts || pending || typed.trim() !== name} onClick={() => void confirm()}>{pending ? t('deleting') : t('deleteWorkspace')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
