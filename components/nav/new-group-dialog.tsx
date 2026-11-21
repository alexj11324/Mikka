'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from '@/lib/intl/i18n-client'
import type { BotView } from '@/app/actions/bots'
import { withBasePath } from '@/lib/base-path'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { WORKSPACE_BOT_MODELS } from '@/lib/bot-models'
import { useOpenerFocus } from '@/hooks/use-focus-return'
import { BotAvatar } from './bot-avatar'

type CreatedGroup = { id: string; title: string; workspaceId: string }
export type DeviceOption = { id: string; name: string; online: boolean }
type Props = {
  purpose?: 'conversation'
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId: string
  bots: BotView[]
  onCreated: (group: CreatedGroup) => void
  onNewBot: () => void
  onReviewGroups: () => void
  /** The person's live machines. Omit to let the dialog read them once it opens. */
  devices?: readonly DeviceOption[]
}

/** Both entry points use the workspace's owned Bots and the same persistent message transport. */
export function NewGroupDialog({ purpose, open, onOpenChange, workspaceId, bots, onCreated, onNewBot, onReviewGroups, devices }: Props) {
  const t = useTranslations(purpose ? 'Shell.createConversation' : 'Shell.newGroup')
  const common = useTranslations('Common')
  const [title, setTitle] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  // A thread may pin the model that answers it and the machine that runs it. 'auto' means "Mikka chooses".
  const [model, setModel] = useState('auto')
  const [deviceId, setDeviceId] = useState('auto')
  // The page may hand the roster over; otherwise the dialog asks once on open. Reading it never blocks the form,
  // and a failed read simply leaves the picker out instead of offering a machine that cannot be honoured.
  const [roster, setRoster] = useState<readonly DeviceOption[] | null>(null)
  useEffect(() => {
    if (!open || devices) return
    let live = true
    fetch(withBasePath('/api/devices'), { credentials: 'same-origin' })
      .then(async response => response.ok ? await response.json() as { items?: DeviceOption[] } : { items: [] })
      .then(body => { if (live) setRoster(body.items ?? []) })
      .catch(() => { if (live) setRoster([]) })
    return () => { live = false }
  }, [open, devices])
  const machines = devices ?? roster ?? []
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<'failed' | 'unconfirmed' | 'nameRequired' | 'botsRequired' | null>(null)
  const pending = useRef(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const created = useRef(false)
  const openerFocus = useOpenerFocus(open)
  const choices = purpose ? bots : bots.filter(bot => !bot.coordinator)
  const selected = picked.filter(id => choices.some(bot => bot.id === id))
  const nameMissing = !title.trim()
  const botsMissing = selected.length === 0

  async function submit() {
    if (pending.current || error === 'unconfirmed') return
    // The primary button always answers a press: an incomplete form names what is missing instead of sitting dead.
    if (nameMissing) { setError('nameRequired'); return }
    if (botsMissing) { setError('botsRequired'); return }
    if (selected.length > 100 || !workspaceId) return
    pending.current = true
    setSaving(true)
    setError(null)
    try {
      const response = await fetch(withBasePath('/api/conversations'), {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId, ...(purpose ? { purpose, leadBotId: selected[0] } : {}), title: title.trim(), model: model === 'auto' ? null : model, deviceId: deviceId === 'auto' ? null : deviceId, members: selected.map(memberId => ({ memberType: 'bot', memberId })) }),
        signal: AbortSignal.timeout(30000),
      })
      const group = await response.json().catch(() => null) as { id?: unknown; title?: unknown } | null
      // A workspace switch unmounts this instance; its response must not navigate the new workspace.
      if (!alive.current) return
      if (!response.ok) {
        setError(response.status >= 500 || response.status === 408 ? 'unconfirmed' : 'failed')
        return
      }
      if (typeof group?.id !== 'string' || typeof group.title !== 'string') {
        setError('unconfirmed')
        return
      }
      created.current = true
      onCreated({ id: group.id, title: group.title, workspaceId })
    } catch {
      // A lost response may follow a committed create. Never replay it automatically.
      if (alive.current) setError('unconfirmed')
    } finally {
      pending.current = false
      if (alive.current) setSaving(false)
    }
  }

  // Every exit stays live, including while a create is in flight: Esc, the backdrop, ✕ and 取消 are the ways out of a
  // dialog, and a pending POST must never take all four away at once (alive.current already stops a late reply from
  // navigating away from the workspace the person is looking at).
  return <Dialog open={open} onOpenChange={onOpenChange} onOpenChangeComplete={next => {
    if (!next) { setTitle(''); setPicked([]); setModel('auto'); setDeviceId('auto'); setError(null); created.current = false }
  }}>
    <DialogContent aria-describedby={undefined} className="top-[12vh] translate-y-0 sm:max-w-[45rem]" closeLabel={common('close')} finalFocus={() => !created.current && openerFocus()}>
      <DialogHeader><DialogTitle>{t('title')}</DialogTitle></DialogHeader>
      <form id="new-group" className="flex min-h-0 flex-col gap-4" onSubmit={event => { event.preventDefault(); void submit() }}>
        <FieldGroup>
        <Field>
          <FieldLabel htmlFor="new-group-title">{t('name')}</FieldLabel>
          <Input id="new-group-title" autoFocus value={title} maxLength={200} disabled={saving || error === 'unconfirmed'} onChange={event => { setTitle(event.target.value); if (error === 'nameRequired') setError(null) }} />
        </Field>
        {/* Capy's new-thread panel carries the run's terms beside the name; so does this one. */}
        <FieldGroup className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel>{t('model')}</FieldLabel>
            <ToggleGroup variant="outline" spacing={0} aria-label={t('model')} disabled={saving || error === 'unconfirmed'} value={[model]} onValueChange={values => setModel(values[0] ?? 'auto')}>
              <ToggleGroupItem value="auto">{t('modelAuto')}</ToggleGroupItem>
              {WORKSPACE_BOT_MODELS.map(name => <ToggleGroupItem key={name} value={name}>{name}</ToggleGroupItem>)}
            </ToggleGroup>
          </Field>
          {machines.length > 1 && <Field>
            <FieldLabel>{t('device')}</FieldLabel>
            <ToggleGroup variant="outline" spacing={0} aria-label={t('device')} disabled={saving || error === 'unconfirmed'} value={[deviceId]} onValueChange={values => setDeviceId(values[0] ?? 'auto')}>
              <ToggleGroupItem value="auto">{t('deviceAuto')}</ToggleGroupItem>
              {machines.map(device => <ToggleGroupItem key={device.id} value={device.id}>{device.name}</ToggleGroupItem>)}
            </ToggleGroup>
          </Field>}
        </FieldGroup>
        <FieldSet disabled={saving || error === 'unconfirmed'} className="gap-2">
          <FieldLegend variant="label">{t('bots')}</FieldLegend>
          {choices.length ? <FieldGroup className="grid max-h-60 grid-cols-1 gap-1 overflow-y-auto sm:grid-cols-2">
            {choices.map(bot => <Field key={bot.id} orientation="horizontal" className="min-w-0 rounded-lg p-2 hover:bg-control has-data-checked:bg-control">
              <Checkbox id={`new-group-bot-${bot.id}`} checked={selected.includes(bot.id)} onCheckedChange={checked => { setPicked(current => checked ? [...new Set([...current, bot.id])] : current.filter(id => id !== bot.id)); if (error === 'botsRequired' && checked) setError(null) }} disabled={saving || error === 'unconfirmed' || (!selected.includes(bot.id) && selected.length >= 100)} />
              <FieldLabel htmlFor={`new-group-bot-${bot.id}`} className="min-w-0 cursor-pointer">
                <BotAvatar id={bot.id} color={bot.color} shape={bot.shape} size="row" still />
                <span className="min-w-0 flex-1 truncate">{bot.name}</span>
                {/* The first Bot picked leads the replies (leadBotId): say so where the choice is made, not in a hint. */}
                {selected[0] === bot.id && <span className="shrink-0 rounded-full bg-control px-1.5 py-0.5 text-xs text-muted-foreground">{t('lead')}</span>}
              </FieldLabel>
            </Field>)}
          </FieldGroup> : <div className="flex flex-col items-start gap-2">
            <p className="text-muted-foreground">{t('noBots')}</p>
            <Button type="button" variant="outline" onClick={onNewBot}>{t('newBot')}</Button>
          </div>}
        </FieldSet>
        </FieldGroup>
        {error && <FieldError>{t(error)}</FieldError>}
      </form>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>{common('cancel')}</Button>
        {error === 'unconfirmed'
          ? <Button type="button" onClick={onReviewGroups}>{t('reviewGroups')}</Button>
          : <Button type="submit" form="new-group" disabled={saving} aria-busy={saving}>{saving && <Spinner data-icon="inline-start" />}{t('create')}</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
