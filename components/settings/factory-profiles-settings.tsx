'use client'

import { useId, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Archive, CircleAlert, CircleCheck, CircleSlash, Copy, KeyRound, MoreHorizontal, Pencil, Plus, Share2, UserRound } from 'lucide-react'
import type { AgentProfile, AgentProfileDefinition } from '@/lib/factory/agent-profile-definition'
import { AGENT_PROFILE_TEMPLATES } from '@/lib/factory/agent-profile-templates'
import { HarnessLabel, ModelLabel, harnessName } from '@/components/labels/entity-labels'
import { ProfileMark, ProfileMarkPicker } from '@/components/labels/profile-mark'
import { DEFAULT_PROFILE_MARK, resolveProfileMark } from '@/lib/factory/agent-profile-mark'
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
import { profileAvailabilityKey, profileModelKey, shareWorkspaceSkill, type AgentProfilesView, type ProfileSkillView } from './factory-profiles-data'
import { useAgentProfileEditor, useAgentProfileList, profileFailure, type ProfileEditor, type ProfileFailure } from '@/hooks/settings/use-agent-profiles'

const EFFORTS = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const SKILL_COPY = ['implementation-evidence', 'independent-review', 'systematic-debugging', 'test-driven-development', 'verification-before-completion', 'performance-investigation', 'security-review'] as const
const skillCopyKey = (id: string) => (SKILL_COPY as readonly string[]).includes(id) ? id as typeof SKILL_COPY[number] : null
const REPOSITORY_SKILL = /^repository:([a-z0-9][a-z0-9-]{0,63})$/i

function modelSourceName(model: AgentProfilesView['catalog']['models'][number], t: ReturnType<typeof useTranslations<'Settings.agentProfiles'>>) {
  return model.sourceLabel || (model.sourceOrdinal ? t('numberedSource', { source: t(`sources.${model.source.kind}`), number: model.sourceOrdinal }) : t(`sources.${model.source.kind}`))
}

function ProfileSource({ model }: { model: AgentProfilesView['catalog']['models'][number] }) {
  const t = useTranslations('Settings.agentProfiles')
  const Icon = model.source.kind === 'subscription' ? UserRound : KeyRound
  return <span className="inline-flex min-w-0 items-center gap-1.5"><Icon aria-hidden="true" className="size-3.5 shrink-0" /><span className="truncate">{modelSourceName(model, t)}</span></span>
}


export function FactoryProfilesSettings({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('Settings.agentProfiles')
  const common = useTranslations('Common')
  const [editor, setEditor] = useState<ProfileEditor | null>(null)
  const [archiving, setArchiving] = useState<AgentProfile | null>(null)
  const { list, data, pending, failure, setFailure, announce, update } = useAgentProfileList(workspaceId, () => setArchiving(null))

  return <>
    <SettingsSection id="factory-profiles-heading" title={t('title')}
      action={<DropdownMenu>
        <DropdownMenuTrigger render={<Button {...settingsSectionAction} disabled={!data || !!list.error || !!pending} />}><Plus data-icon="inline-start" />{t('add')}</DropdownMenuTrigger>
        <DropdownMenuContent align="end"><DropdownMenuGroup>
          <DropdownMenuItem onClick={() => { setFailure(null); setEditor({}) }}>{t('blankProfile')}</DropdownMenuItem>
          {AGENT_PROFILE_TEMPLATES.map(template => <DropdownMenuItem key={template.id} onClick={() => { setFailure(null); setEditor({ template: template.id }) }}>{t(`templates.${template.id}.name`)}</DropdownMenuItem>)}
        </DropdownMenuGroup></DropdownMenuContent>
      </DropdownMenu>}>
      {!data && !list.error ? <SettingsLoading bare rows={2} label={t('loading')} />
        : !data ? <div className="p-4"><SettingsSaveError message={t('loadFailed')} retryLabel={common('retry')} onRetry={() => { void list.mutate() }} /></div>
        : <>
          <SettingRow title={t('defaultName')} icon={<ProfileMark {...DEFAULT_PROFILE_MARK} />}
            description={<span className="flex flex-col gap-1"><span>{t('inherit')}</span>
              {data.defaultAvailability && <ProfileState available={data.defaultAvailability.available} enabled label={data.defaultAvailability.available ? t('available') : t(`reasons.${profileAvailabilityKey(data.defaultAvailability.reason)}`)} />}</span>}>
            <span className="text-muted-foreground">{t('builtIn')}</span>
          </SettingRow>
          {data.profiles.length === 0 && <p className="px-5 py-4 text-sm text-muted-foreground">{t('empty')}</p>}
          {data.profiles.map(profile => {
            const state = data.availability[profile.id]
            const fixed = profile.model.mode === 'fixed' ? profile.model : null
            const source = fixed ? data.catalog.models.find(model => profileModelKey(model) === profileModelKey(fixed)) : undefined
            return <SettingRow key={profile.id} title={profile.name} icon={<ProfileMark {...resolveProfileMark(profile, profile)} />}
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
    {editor && data && <ProfileEditorDialog key={(editor.template ?? '') + (editor.duplicate ? 'copy:' : 'edit:') + (editor.profile?.id ?? 'new')} workspaceId={workspaceId} editor={editor} catalog={data.catalog}
      onCatalogReload={() => { void list.mutate() }}
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

function ProfileEditorDialog({ workspaceId, editor, catalog, onCatalogReload, onClose, onSaved, onReload }: {
  workspaceId: string; editor: ProfileEditor; catalog: AgentProfilesView['catalog']
  onCatalogReload: () => void; onClose: () => void; onSaved: () => void; onReload: () => void
}) {
  const t = useTranslations('Settings.agentProfiles')
  const common = useTranslations('Common')
  const id = useId()
  const [repositoryInput, setRepositoryInput] = useState('')
  const [sharing, setSharing] = useState<string | null>(null)
  const [shareError, setShareError] = useState<ProfileFailure | null>(null)
  const { original, draft, change, mark, changeMark, roles, setRoles, modelMode, setModelMode, modelKey, setModelKey, models, selectedModel, frozen, pending, error, setError, save } = useAgentProfileEditor({ workspaceId, editor, catalog, onSaved })
  const sourceName = (model: AgentProfilesView['catalog']['models'][number]) => modelSourceName(model, t)
  const catalogIds = new Set(catalog.skills.map(skill => skill.id))
  const repositorySelected = draft.skills.filter(skill => REPOSITORY_SKILL.test(skill))
  const missingSelected = draft.skills.filter(skill => !catalogIds.has(skill) && !REPOSITORY_SKILL.test(skill))
  const blockedSkill = draft.skills.some(skill => catalog.skills.some(item => item.id === skill && !item.available))
  function addRepositorySkills() {
    const slugs = repositoryInput.split(/[,，\s]+/).map(value => value.trim().toLowerCase()).filter(Boolean)
    if (!slugs.length || slugs.some(slug => !REPOSITORY_SKILL.test(`repository:${slug}`))) { setError('invalid'); return }
    change({ skills: [...new Set([...draft.skills.filter(skill => !REPOSITORY_SKILL.test(skill)), ...slugs.map(slug => `repository:${slug}`)])] })
    setRepositoryInput('')
  }
  async function toggleShare(skill: ProfileSkillView) {
    const skillId = skill.id.startsWith('personal:') ? skill.id.slice('personal:'.length) : null
    if (!skillId) return
    setSharing(skill.id); setShareError(null)
    try { await shareWorkspaceSkill(workspaceId, skillId, !skill.shared); onCatalogReload() }
    catch (failure) { setShareError(profileFailure(failure)) }
    finally { setSharing(null) }
  }

  return <Dialog open onOpenChange={open => { if (!open && !pending) onClose() }}>
    <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-2xl" aria-describedby={undefined} closeLabel={common('close')}>
      <DialogTitle className="pr-8">{original ? t('editTitle') : t('addTitle')}</DialogTitle>
      <form className="flex min-h-0 flex-col gap-4" onSubmit={event => { event.preventDefault(); void save() }}>
        <FieldGroup className="min-h-0 overflow-y-auto px-0.5 pb-1">
          <Field><FieldLabel htmlFor={id + '-name'}>{t('name')}</FieldLabel>
            <div className="flex min-w-0 items-center gap-2"><ProfileMark {...mark} size="lg" /><Input id={id + '-name'} value={draft.name} maxLength={80} required disabled={pending || frozen} onChange={event => change({ name: event.target.value })} /></div>
          </Field>
          <FieldSet className="gap-3"><FieldLegend className="text-sm">{t('mark.icon')}</FieldLegend>
            <ProfileMarkPicker value={mark} disabled={pending || frozen} onChange={changeMark} />
          </FieldSet>
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
              {catalog.skills.length === 0 ? <p className="text-sm text-muted-foreground">{t('noSkills')}</p> : catalog.skills.map(skill => {
                const key = skillCopyKey(skill.id), checked = draft.skills.includes(skill.id)
                const label = key ? t(`skillNames.${key}`) : skill.name, description = key ? t(`skillDescriptions.${key}`) : skill.description
                return <Field key={skill.id} orientation="horizontal">
                  <Checkbox id={id + '-skill-' + skill.id} checked={checked} disabled={pending || frozen || (!skill.available && !checked)} onCheckedChange={value => change({ skills: value ? [...draft.skills, skill.id] : draft.skills.filter(item => item !== skill.id) })} />
                  <div className="flex min-w-0 flex-1 items-start justify-between gap-2">
                    <FieldLabel htmlFor={id + '-skill-' + skill.id} className="flex min-w-0 flex-col items-start gap-0.5">
                      <span>{label} <span className="font-normal text-muted-foreground">{t(`skillSources.${skill.source}`)} · {t('version', { version: skill.version })}</span></span>
                      {description && <span className="text-xs font-normal text-muted-foreground">{description}</span>}
                      {!skill.available && <span className="text-xs font-normal text-destructive-foreground">{t(`skillStates.${skill.reason ?? 'missing'}`)}</span>}
                    </FieldLabel>
                    {skill.source === 'personal' && skill.shareable && <Button type="button" variant="ghost" size="sm" className="shrink-0" disabled={pending || frozen || sharing === skill.id} onClick={() => { void toggleShare(skill) }}>
                      <Share2 data-icon="inline-start" />{skill.shared ? t('unshareSkill') : t('shareSkill')}
                    </Button>}
                  </div>
                </Field>
              })}
              {missingSelected.map(skill => <Field key={skill} orientation="horizontal">
                <Checkbox id={id + '-missing-' + skill} checked onCheckedChange={() => change({ skills: draft.skills.filter(value => value !== skill) })} />
                <FieldLabel htmlFor={id + '-missing-' + skill} className="text-destructive-foreground">{(key => key ? t('unavailableNamed', { name: t(`skillNames.${key}`) }) : t('removedSkill'))(skillCopyKey(skill))}</FieldLabel>
              </Field>)}
            </FieldGroup>
          </FieldSet>
          <FieldSet className="gap-3"><FieldLegend className="text-sm">{t('repositorySkills')}</FieldLegend>
            <Field><FieldLabel htmlFor={id + '-repository'}>{t('repositorySkillName')}</FieldLabel>
              <div className="flex gap-2">
                <Input id={id + '-repository'} value={repositoryInput} maxLength={200} placeholder={t('repositorySkillPlaceholder')} disabled={pending || frozen}
                  onChange={event => setRepositoryInput(event.target.value)}
                  onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addRepositorySkills() } }} />
                <Button type="button" variant="secondary" disabled={pending || frozen || !repositoryInput.trim()} onClick={addRepositorySkills}>{t('addRepositorySkill')}</Button>
              </div>
            </Field>
            {repositorySelected.length > 0 && <FieldGroup className="gap-2">
              {repositorySelected.map(skill => { const slug = REPOSITORY_SKILL.exec(skill)?.[1] ?? skill; return <Field key={skill} orientation="horizontal">
                <Checkbox id={id + '-repo-' + slug} checked disabled={pending || frozen} onCheckedChange={() => change({ skills: draft.skills.filter(value => value !== skill) })} />
                <FieldLabel htmlFor={id + '-repo-' + slug} className="flex min-w-0 flex-col items-start gap-0.5">
                  <span>{slug} <span className="font-normal text-muted-foreground">{t('skillSources.repository')}</span></span>
                  <span className="text-xs font-normal text-muted-foreground">{t('repositorySkillHint')}</span>
                </FieldLabel>
              </Field> })}
            </FieldGroup>}
          </FieldSet>
          {shareError && <FieldError>{t(shareError)}</FieldError>}
        </FieldGroup>
        {error && <FieldError>{t(error)}</FieldError>}
        <DialogFooter className="shrink-0">
          {(error === 'versionConflict' || error === 'profileMissing' || frozen) && <Button type="button" variant="secondary" disabled={pending} onClick={onReload}>{t('reload')}</Button>}
          <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>{common('cancel')}</Button>
          <Button type="submit" disabled={pending || (modelMode === 'fixed' && !selectedModel) || !draft.name.trim() || blockedSkill || missingSelected.length > 0}>{pending ? t('saving') : frozen ? common('retry') : t('save')}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
}

/** A Profile's state as the shared status badge (R-34, R-87): icon, colour and word. */
function ProfileState({ available, enabled, label }: { available: boolean; enabled: boolean; label: string }) {
  const Icon = available ? CircleCheck : enabled ? CircleAlert : CircleSlash
  return <Badge size="lg" variant={available ? 'success-light' : enabled ? 'destructive-light' : 'secondary'} className="max-w-full self-start">
    <Icon aria-hidden="true" /><span className="truncate">{label}</span>
  </Badge>
}
