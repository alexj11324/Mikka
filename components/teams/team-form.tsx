'use client'
import { useTranslations } from 'next-intl'

import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, SquareUserRound } from 'lucide-react'
import posthog from 'posthog-js'
import { saveTeam } from '@/app/actions/teams'
import { SettingsContent, SettingsGroup, SettingsRow } from '@/components/ui/settings-layout'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Spinner } from '@/components/ui/spinner'
import { suggestTeamIdentifier } from '@/lib/team-identifier'

type Team = { id: string; name: string; identifier: string; description: string }
export function TeamForm({ workspaceId, team, existingIdentifiers = [], editable = true, onClose, onSaved }: { workspaceId: string; team?: Team; existingIdentifiers?: readonly string[]; editable?: boolean; onClose: () => void; onSaved: (teamId: string) => void }) {
  const i18nText = useTranslations();
  const [name, setName] = useState(team?.name ?? '')
  const [identifier, setIdentifier] = useState(team?.identifier ?? '')
  const [identifierEdited, setIdentifierEdited] = useState(!!team)
  const [description, setDescription] = useState(team?.description ?? '')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const busy = useRef(false)
  const dirty = name !== (team?.name ?? '') || identifier !== (team?.identifier ?? '') || description !== (team?.description ?? '')
  useEffect(() => {
    if (!dirty && !pending) return
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault() }
    const beforeNavigate = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null
      if (!(link instanceof HTMLAnchorElement) || link.href === window.location.href || link.target === '_blank' || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      if (busy.current || !window.confirm(i18nText("FeatureCopy.c_39f8d12d"))) { event.preventDefault(); event.stopPropagation() }
    }
    window.addEventListener('beforeunload', beforeUnload)
    window.addEventListener('click', beforeNavigate, true)
    return () => { window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('click', beforeNavigate, true) }
  }, [dirty, pending])
  function close() { if (!busy.current && (!dirty || window.confirm(i18nText("FeatureCopy.c_39f8d12d")))) onClose() }
  async function submit() {
    if (busy.current || !editable) return
    busy.current = true; setPending(true); setError('')
    try {
      const result = await saveTeam({ id: team?.id, workspaceId, name, identifier, description })
      if (!result.ok) { setError(result.error); return }
      posthog.capture(team ? 'orvilo_team_updated' : 'orvilo_team_created')
      onSaved(result.data.id)
    } catch { setError(i18nText("FeatureCopy.c_85f5c4d3")) }
    finally { busy.current = false; setPending(false) }
  }
  return <section aria-labelledby="team-form-heading">
    <SettingsContent>
      <Button type="button" variant="ghost" size="sm" className="self-start" aria-label={team ? i18nText("FeatureCopy.c_212cf650") : i18nText("Devices.connect.back")} disabled={pending} onClick={close}><ChevronLeft data-icon="inline-start" /><span lang="en">{team ? 'Team settings' : 'Back'}</span></Button>
      <header className="flex flex-col gap-2" lang="en"><h1 id="team-form-heading" className="text-2xl font-semibold tracking-tight">{team ? 'General' : 'Create a new team'}</h1><p className="text-sm text-muted-foreground">{team ? `Manage the name, identifier, and description of ${team.name}.` : 'Create a new team to manage separate cycles, workflows and notifications'}</p></header>
      <form aria-label={team ? i18nText("FeatureCopy.c_455685f2") : i18nText("FeatureCopy.c_4eec1ff7")} className="flex flex-col gap-8" onSubmit={event => { event.preventDefault(); void submit() }} onKeyDown={event => { if (event.nativeEvent.isComposing || event.keyCode === 229) return; if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); event.currentTarget.requestSubmit() } }}>
        <SettingsGroup className="bg-card">
          <SettingsRow title="Icon & Name" htmlFor="team-name" data-disabled={pending} lang="en">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground" aria-hidden="true"><SquareUserRound className="size-4" /></span><Input id="team-name" required maxLength={100} value={name} onChange={event => { const value = event.target.value; setName(value); if (!team && !identifierEdited) setIdentifier(suggestTeamIdentifier(value, existingIdentifiers)) }} disabled={pending} readOnly={!editable} aria-label={i18nText("FeatureCopy.c_b2629c38")} placeholder="e.g. Engineering" className="min-w-0 flex-1 @md/field-group:w-48" />
          </SettingsRow>
          <SettingsRow title="Identifier" htmlFor="team-identifier" description="Used to identify issues from this team (e.g. ENG-123)" descriptionId="team-identifier-description" data-disabled={pending} lang="en">
            <Input id="team-identifier" required maxLength={12} pattern="[A-Z][A-Z0-9]{1,11}" value={identifier} onChange={event => { const value = event.target.value.toUpperCase(); setIdentifierEdited(!!value); setIdentifier(value || (!team ? suggestTeamIdentifier(name, existingIdentifiers) : '')) }} disabled={pending} readOnly={!editable} aria-label={i18nText("FeatureCopy.c_f60daeb5")} aria-describedby="team-identifier-description" title={i18nText("FeatureCopy.c_86fcb79a")} placeholder="e.g. ENG" className="min-w-0 @md/field-group:w-36" />
          </SettingsRow>
          {team && <SettingsRow title={i18nText("FeatureCopy.c_4136230f")} htmlFor="team-description" description={i18nText("FeatureCopy.c_8b5a11e2")} data-disabled={pending}><Textarea id="team-description" maxLength={500} rows={3} value={description} onChange={event => setDescription(event.target.value)} disabled={pending} readOnly={!editable} placeholder={i18nText("FeatureCopy.c_9d2c0eb0")} className="min-w-0 @md/field-group:w-64" /></SettingsRow>}
        </SettingsGroup>
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        <div className="flex flex-wrap items-center justify-end gap-4">{team && <p className="mr-auto text-xs leading-relaxed text-muted-foreground">{editable ? i18nText("FeatureCopy.c_561baad2") : i18nText("FeatureCopy.c_10d239d6")}</p>}{editable && <Button type="submit" className="rounded-full px-5" aria-label={team ? i18nText("FeatureCopy.c_cd5cd93c") : i18nText("FeatureCopy.c_cb11190c")} disabled={pending || !name.trim() || !identifier.trim() || (!!team && !dirty)}>{pending && <Spinner data-icon="inline-start" />}<span lang="en">{team ? 'Save changes' : 'Create team'}</span></Button>}</div>
      </form>
    </SettingsContent>
  </section>
}
