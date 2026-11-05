'use client'

import { useId, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Archive, CircleAlert, CircleCheck, CircleSlash, Copy, KeyRound, MoreHorizontal, Pencil, Plus, SlidersHorizontal, UserRound } from 'lucide-react'
import { toast } from 'sonner'
import type { AgentProfile, AgentProfileDefinition } from '@/lib/factory/agent-profile-definition'
import { HarnessLabel, ModelLabel, harnessName } from '@/components/labels/entity-labels'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Badge } from '@/components/reui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Field, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { SettingRow, SettingsLoading, SettingsSaveError, SettingsSection, settingsSectionAction } from './primitives'
import { profileAvailabilityKey, profileDefinition, profileModelKey, profileRequest, ProfileRequestError, useAgentProfiles, type AgentProfilesView } from './factory-profiles-data'

type ProfileEditor = { profile?: AgentProfile; duplicate?: boolean }
const EFFORTS = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const skillCopyKey = (id: string) => id === 'implementation-evidence' || id === 'independent-review' || id === 'systematic-debugging' ? id : null
const initialDefinition: AgentProfileDefinition = { name: '', description: '', roles: [], enabled: true, harness: 'auto', model: { mode: 'inherit' }, instructions: '', skills: [] }

function modelSourceName(model: AgentProfilesView['catalog']['models'][number], t: ReturnType<typeof useTranslations<'Settings.agentProfiles'>>) {
  return model.sourceLabel || (model.sourceOrdinal ? t('numberedSource', { source: t(`sources.${model.source.kind}`), number: model.sourceOrdinal }) : t(`sources.${model.source.kind}`))
}

function ProfileSource({ model }: { model: AgentProfilesView['catalog']['models'][number] }) {
  const t = useTranslations('Settings.agentProfiles')
  const Icon = model.source.kind === 'subscription' ? UserRound : KeyRound
  return <span className="inline-flex min-w-0 items-center gap-1.5"><Icon aria-hidden="true" className="size-3.5 shrink-0" /><span className="truncate">{modelSourceName(model, t)}</span></span>
}

function profileFailure(error: unknown) {
  if (!(error instanceof ProfileRequestError)) return 'saveUnconfirmed'
  switch (error.code) {
    case 'agentProfileVersionConflict': case 'agentProfileRequestConflict': return 'versionConflict'
    case 'agentProfileModelUnavailable': return 'modelUnavailable'
    case 'agentProfileSkillUnavailable': return 'skillUnavailable'
    case 'agentProfileLimit': return 'limitReached'
    case 'agentProfileInvalid': case 'agentProfileTooLarge': return 'invalid'
    case 'agentProfileArchived': case 'agentProfileNotFound': return 'profileMissing'
    case 'authRequired': case 'agentProfileScopeNotFound': case 'originMismatch': return 'accessChanged'
    default: return 'saveFailed'
  }
}

export function FactoryProfilesSettings({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('Settings.agentProfiles')
  const common = useTranslations('Common')
  const list = useAgentProfiles(workspaceId)
  const [editor, setEditor] = useState<ProfileEditor | null>(null)
  const [archiving, setArchiving] = useState<AgentProfile | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [failure, setFailure] = useState<ReturnType<typeof profileFailure> | null>(null)
  // Only a toggle's result is announced; the rows' states are read in place, not as live regions.
  const [announce, setAnnounce] = useState('')
  const data = list.data

  async function update(profile: AgentProfile, archive = false) {
    setPending(profile.id); setFailure(null)
    try {
      await profileRequest(workspaceId, archive ? 'DELETE' : 'PATCH', profile.id,
        archive ? { version: profile.version } : { version: profile.version, profile: { ...profileDefinition(profile), enabled: !profile.enabled } })
      setArchiving(null)
      if (!archive) setAnnounce(t(profile.enabled ? 'disabledNamed' : 'enabledNamed', { name: profile.name }))
      void list.mutate()
    } catch (error) {
      setFailure(profileFailure(error))
      void list.mutate()
    } finally { setPending(null) }
  }

  return <>
    <SettingsSection id="factory-profiles-heading" title={t('title')}
      action={<Button {...settingsSectionAction} disabled={!data || !!list.error || !!pending} onClick={() => { setFailure(null); setEditor({}) }}><Plus data-icon="inline-start" />{t('add')}</Button>}>
      {!data && !list.error ? <SettingsLoading bare rows={2} label={t('loading')} />
        : !data ? <div className="p-4"><SettingsSaveError message={t('loadFailed')} retryLabel={common('retry')} onRetry={() => { void list.mutate() }} /></div>
        : <>
          <SettingRow title={t('defaultName')} icon={<SlidersHorizontal aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />}
            description={<span className="flex flex-col gap-1"><span>{t('inherit')}</span>
              {data.defaultAvailability && <span>{data.defaultAvailability.available ? t('available') : t(`reasons.${profileAvailabilityKey(data.defaultAvailability.reason)}`)}</span>}</span>}>
            <span className="text-muted-foreground">{t('builtIn')}</span>
          </SettingRow>
          {data.profiles.length === 0 && <p className="px-5 py-4 text-sm text-muted-foreground">{t('empty')}</p>}
          {data.profiles.map(profile => {
            const state = data.availability[profile.id]
            const fixed = profile.model.mode === 'fixed' ? profile.model : null
            const source = fixed ? data.catalog.models.find(model => profileModelKey(model) === profileModelKey(fixed)) : undefined
            return <SettingRow key={profile.id} title={profile.name} icon={<SlidersHorizontal aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />}
              description={<span className="flex min-w-0 flex-col gap-1">
                {profile.description && <span className="wrap-break-word">{profile.description}</span>}
                {profile.roles.length > 0 && <span className="wrap-break-word text-xs">{profile.roles.join(' · ')}</span>}
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                  {profile.harness === 'auto' ? <span>{t('autoAgent')}</span> : <HarnessLabel harness={profile.harness} />}
                  {profile.model.mode === 'inherit' ? <span>{t('inherit')}</span> : <><ModelLabel model={profile.model.model} />{source && <ProfileSource model={source} />}</>}
                  <span>{t('version', { version: profile.version })}</span>
                </span>
                <ProfileState available={!!state?.available} enabled={profile.enabled} label={state?.available ? t('available') : t(`reasons.${profileAvailabilityKey(state?.reason)}`)} />
              </span>}>
              <span className="flex items-center gap-3">
                <Switch checked={profile.enabled} disabled={!!pending || !!list.error} aria-label={t('enableNamed', { name: profile.name })} onCheckedChange={() => { void update(profile) }} />
                <DropdownMenu>
                  <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" disabled={!!pending} aria-label={t('actionsNamed', { name: profile.name })} />}><MoreHorizontal data-icon="inline-start" /></DropdownMenuTrigger>
                  <DropdownMenuContent align="end"><DropdownMenuGroup>
                    <DropdownMenuItem onClick={() => setEditor({ profile })}><Pencil />{t('edit')}</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setEditor({ profile, duplicate: true })}><Copy />{t('duplicate')}</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => { setFailure(null); setArchiving(profile) }}><Archive />{t('archive')}</DropdownMenuItem>
                  </DropdownMenuGroup></DropdownMenuContent>
                </DropdownMenu>
              </span>
            </SettingRow>
          })}
        </>}
    </SettingsSection>
    <span role="status" className="sr-only">{announce}</span>
    {(failure || (data && list.error)) && <SettingsSaveError message={t(failure ?? 'loadFailed')} retryLabel={t('reload')} onRetry={() => { setFailure(null); void list.mutate() }} />}
    {editor && data && <ProfileEditorDialog key={(editor.duplicate ? 'copy:' : 'edit:') + (editor.profile?.id ?? 'new')} workspaceId={workspaceId} editor={editor} catalog={data.catalog}
      onClose={() => { setEditor(null); void list.mutate() }} onSaved={() => { setEditor(null); void list.mutate() }} onReload={() => { setEditor(null); void list.mutate() }} />}
    <AlertDialog open={!!archiving} onOpenChange={open => { if (!open && !pending) setArchiving(null) }}>
      <AlertDialogContent aria-describedby={undefined}>
        <AlertDialogHeader><AlertDialogTitle>{t('archiveNamed', { name: archiving?.name ?? '' })}</AlertDialogTitle></AlertDialogHeader>
        {failure && <FieldError>{t(failure)}</FieldError>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={!!pending}>{common('cancel')}</AlertDialogCancel>
          <AlertDialogAction disabled={!!pending} onClick={event => { event.preventDefault(); if (archiving) void update(archiving, true) }}>{pending ? t('saving') : t('archive')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>
}

function ProfileEditorDialog({ workspaceId, editor, catalog, onClose, onSaved, onReload }: {
  workspaceId: string; editor: ProfileEditor; catalog: AgentProfilesView['catalog']
  onClose: () => void; onSaved: () => void; onReload: () => void
}) {
  const t = useTranslations('Settings.agentProfiles')
  const common = useTranslations('Common')
  const id = useId()
  const original = editor.duplicate ? undefined : editor.profile
  const [draft, setDraft] = useState<AgentProfileDefinition>(() => editor.profile
    ? { ...profileDefinition(editor.profile), ...(editor.duplicate ? { name: t('copyName', { name: editor.profile.name }).slice(0, 80) } : {}) }
    : { ...initialDefinition })
  const [roles, setRoles] = useState(draft.roles.join(', '))
  const [modelMode, setModelMode] = useState(draft.model.mode)
  const [modelKey, setModelKey] = useState(draft.model.mode === 'fixed' ? profileModelKey(draft.model) : '')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ReturnType<typeof profileFailure> | null>(null)
  const requestId = useRef<string | null>(null)
  const attempt = useRef<AgentProfileDefinition | null>(null)
  const models = catalog.models.filter(model => draft.harness === 'auto' || model.harness === draft.harness)
  const selectedModel = models.find(model => profileModelKey(model) === modelKey)
  const frozen = error === 'saveUnconfirmed'
  const sourceName = (model: AgentProfilesView['catalog']['models'][number]) => modelSourceName(model, t)
  function change(patch: Partial<AgentProfileDefinition>) { setDraft(current => ({ ...current, ...patch })); setError(null) }

  async function save() {
    if (pending) return
    const roleList = [...new Set(roles.split(/[,，\n]/).map(role => role.trim()).filter(Boolean))]
    if (!draft.name.trim() || roleList.length > 12 || roleList.some(role => role.length > 48) || (modelMode === 'fixed' && !selectedModel)) { setError('invalid'); return }
    const profile: AgentProfileDefinition = frozen && attempt.current ? attempt.current : {
      ...draft, name: draft.name.trim(), description: draft.description.trim(), roles: roleList,
      model: modelMode === 'fixed' && selectedModel ? { mode: 'fixed', harness: selectedModel.harness, model: selectedModel.model, source: selectedModel.source } : { mode: 'inherit' },
    }
    attempt.current = profile
    requestId.current ??= crypto.randomUUID()
    setPending(true); setError(null)
    try {
      await profileRequest<{ profile: AgentProfile }>(workspaceId, original ? 'PATCH' : 'POST', original?.id,
        { profile, ...(original ? { version: original.version } : { requestId: requestId.current }) })
      toast.success(t('saved'))
      onSaved()
    } catch (failure) { setError(profileFailure(failure)) }
    finally { setPending(false) }
  }

  return <Dialog open onOpenChange={open => { if (!open && !pending) onClose() }}>
    <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-2xl" aria-describedby={undefined} closeLabel={common('close')}>
      <DialogTitle className="pr-8">{original ? t('editTitle') : t('addTitle')}</DialogTitle>
      <form className="flex min-h-0 flex-col gap-4" onSubmit={event => { event.preventDefault(); void save() }}>
        <FieldGroup className="min-h-0 overflow-y-auto px-0.5 pb-1">
          <Field><FieldLabel htmlFor={id + '-name'}>{t('name')}</FieldLabel><Input id={id + '-name'} value={draft.name} maxLength={80} required disabled={pending || frozen} onChange={event => change({ name: event.target.value })} /></Field>
          <Field><FieldLabel htmlFor={id + '-description'}>{t('description')}</FieldLabel><Textarea id={id + '-description'} className="min-h-16 resize-y" value={draft.description} maxLength={600} disabled={pending || frozen} onChange={event => change({ description: event.target.value })} /></Field>
          <Field><FieldLabel htmlFor={id + '-roles'}>{t('roles')}</FieldLabel><Input id={id + '-roles'} value={roles} maxLength={600} placeholder={t('rolesPlaceholder')} disabled={pending || frozen} onChange={event => { setRoles(event.target.value); setError(null) }} /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field><FieldLabel htmlFor={id + '-agent'}>{t('agent')}</FieldLabel>
              <Select value={draft.harness} disabled={pending || frozen} onValueChange={value => { if (value === 'auto' || value === 'claude_code' || value === 'codex') { change({ harness: value }); if (selectedModel && value !== 'auto' && value !== selectedModel.harness) setModelKey('') } }}
                items={[{ value: 'auto', label: t('autoAgent') }, { value: 'claude_code', label: harnessName('claude_code') }, { value: 'codex', label: harnessName('codex') }]}>
                <SelectTrigger id={id + '-agent'} className="w-full"><SelectValue>{draft.harness === 'auto' ? t('autoAgent') : <HarnessLabel harness={draft.harness} />}</SelectValue></SelectTrigger>
                <SelectContent><SelectGroup><SelectItem value="auto">{t('autoAgent')}</SelectItem><SelectItem value="claude_code"><HarnessLabel harness="claude_code" /></SelectItem><SelectItem value="codex"><HarnessLabel harness="codex" /></SelectItem></SelectGroup></SelectContent>
              </Select>
            </Field>
            <Field><FieldLabel htmlFor={id + '-policy'}>{t('modelPolicy')}</FieldLabel>
              <Select value={modelMode} disabled={pending || frozen} items={[{ value: 'inherit', label: t('inherit') }, { value: 'fixed', label: t('fixed') }]} onValueChange={value => { if (value === 'fixed' || value === 'inherit') { setModelMode(value); setError(null) } }}>
                <SelectTrigger id={id + '-policy'} className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent><SelectGroup><SelectItem value="inherit">{t('inherit')}</SelectItem><SelectItem value="fixed">{t('fixed')}</SelectItem></SelectGroup></SelectContent>
              </Select>
            </Field>
          </div>
          {modelMode === 'fixed' && <Field><FieldLabel htmlFor={id + '-model'}>{t('modelSource')}</FieldLabel>
            <Select value={modelKey || null} disabled={pending || frozen || models.length === 0}
              items={models.map(model => ({ value: profileModelKey(model), label: model.model + ' · ' + sourceName(model) + ' · ' + harnessName(model.harness) }))}
              onValueChange={value => { setModelKey(value ?? ''); setError(null) }}>
              <SelectTrigger id={id + '-model'} className="w-full min-w-0"><SelectValue placeholder={t('chooseModel')}>{selectedModel ? <span className="flex min-w-0 items-center gap-2"><ModelLabel model={selectedModel.model} source={selectedModel.provider} /><span className="min-w-0 text-muted-foreground"><ProfileSource model={selectedModel} /></span></span> : undefined}</SelectValue></SelectTrigger>
              <SelectContent alignItemWithTrigger={false} className="max-w-[calc(100vw-3rem)]"><SelectGroup>{models.map(model => <SelectItem key={profileModelKey(model)} value={profileModelKey(model)}>
                <span className="flex min-w-0 flex-col gap-1 py-1"><ModelLabel model={model.model} source={model.provider} /><span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><HarnessLabel harness={model.harness} /><ProfileSource model={model} />{!model.available && <span>{t(`reasons.${profileAvailabilityKey(model.reason)}`)}</span>}</span></span>
              </SelectItem>)}</SelectGroup></SelectContent>
            </Select>
            {models.length === 0 && <p className="text-sm text-muted-foreground">{t('noModels')}</p>}
            {!!modelKey && !selectedModel && <FieldError>{t('modelUnavailable')}</FieldError>}
            {selectedModel && !selectedModel.available && <p className="text-sm text-muted-foreground">{t(`reasons.${profileAvailabilityKey(selectedModel.reason)}`)}</p>}
          </Field>}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field><FieldLabel htmlFor={id + '-effort'}>{t('effort')}</FieldLabel>
              <Select value={draft.effort ?? 'auto'} disabled={pending || frozen} items={EFFORTS.map(value => ({ value, label: t(`efforts.${value}`) }))} onValueChange={value => { if (value) change({ effort: value === 'auto' ? undefined : value as AgentProfileDefinition['effort'] }) }}>
                <SelectTrigger id={id + '-effort'} className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{EFFORTS.map(value => <SelectItem key={value} value={value}>{t(`efforts.${value}`)}</SelectItem>)}</SelectGroup></SelectContent>
              </Select>
            </Field>
            <Field><FieldLabel htmlFor={id + '-enabled'}>{t('enabled')}</FieldLabel><Switch id={id + '-enabled'} checked={draft.enabled} disabled={pending || frozen} onCheckedChange={enabled => change({ enabled })} /></Field>
          </div>
          <Field><FieldLabel htmlFor={id + '-instructions'}>{t('instructions')}</FieldLabel><Textarea id={id + '-instructions'} className="min-h-28 resize-y" value={draft.instructions} maxLength={24_000} disabled={pending || frozen} onChange={event => change({ instructions: event.target.value })} /></Field>
          <FieldSet className="gap-3"><FieldLegend className="text-sm">{t('skills')}</FieldLegend>
            <FieldGroup className="gap-3">
              {catalog.skills.length === 0 ? <p className="text-sm text-muted-foreground">{t('noSkills')}</p> : catalog.skills.map(skill => { const key = skillCopyKey(skill.id); return <Field key={skill.id} orientation="horizontal">
                <Checkbox id={id + '-skill-' + skill.id} checked={draft.skills.includes(skill.id)} disabled={pending || frozen} onCheckedChange={checked => change({ skills: checked ? [...draft.skills, skill.id] : draft.skills.filter(value => value !== skill.id) })} />
                <FieldLabel htmlFor={id + '-skill-' + skill.id} className="flex min-w-0 flex-col items-start gap-0.5">
                  <span>{key ? t(`skillNames.${key}`) : skill.name} <span className="font-normal text-muted-foreground">{t('version', { version: skill.version })}</span></span>
                  <span className="text-xs font-normal text-muted-foreground">{key ? t(`skillDescriptions.${key}`) : skill.description}</span>
                </FieldLabel>
              </Field> })}
              {draft.skills.filter(skill => !catalog.skills.some(item => item.id === skill)).map(skill => <Field key={skill} orientation="horizontal">
                <Checkbox id={id + '-missing-' + skill} checked disabled={pending || frozen} onCheckedChange={() => change({ skills: draft.skills.filter(value => value !== skill) })} />
                <FieldLabel htmlFor={id + '-missing-' + skill} className="text-destructive-foreground">{t.has(`skillNames.${skill}` as never) ? t(`skillNames.${skill}` as never) : t('removedSkill')} · {t('skillUnavailable')}</FieldLabel>
              </Field>)}
            </FieldGroup>
          </FieldSet>
        </FieldGroup>
        {error && <FieldError>{t(error)}</FieldError>}
        <DialogFooter className="shrink-0">
          {(error === 'versionConflict' || error === 'profileMissing' || frozen) && <Button type="button" variant="secondary" disabled={pending} onClick={onReload}>{t('reload')}</Button>}
          <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>{common('cancel')}</Button>
          <Button type="submit" disabled={pending || (modelMode === 'fixed' && !selectedModel) || !draft.name.trim() || draft.skills.some(skill => !catalog.skills.some(item => item.id === skill))}>{pending ? t('saving') : frozen ? common('retry') : t('save')}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
}

/** A Profile's state as the shared status badge (R-34, R-87): icon, colour and word. */
function ProfileState({ available, enabled, label }: { available: boolean; enabled: boolean; label: string }) {
  const Icon = available ? CircleCheck : enabled ? CircleAlert : CircleSlash
  return <Badge size="sm" variant={available ? 'success-light' : enabled ? 'destructive-light' : 'secondary'} className="max-w-full self-start">
    <Icon aria-hidden="true" /><span className="truncate">{label}</span>
  </Badge>
}
