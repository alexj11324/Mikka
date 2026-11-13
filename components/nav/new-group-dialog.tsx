'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import type { BotView } from '@/app/actions/bots'
import { withBasePath } from '@/lib/base-path'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { useOpenerFocus } from '@/hooks/use-focus-return'
import { BotAvatar } from './bot-avatar'

type CreatedGroup = { id: string; title: string; workspaceId: string }
type Props = {
  purpose?: 'conversation'
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId: string
  bots: BotView[]
  onCreated: (group: CreatedGroup) => void
  onNewBot: () => void
  onReviewGroups: () => void
}

/** Both entry points use the workspace's owned Bots and the same persistent message transport. */
export function NewGroupDialog({ purpose, open, onOpenChange, workspaceId, bots, onCreated, onNewBot, onReviewGroups }: Props) {
  const t = useTranslations(purpose ? 'Shell.newConversation' : 'Shell.newGroup')
  const common = useTranslations('Common')
  const [title, setTitle] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<'failed' | 'unconfirmed' | null>(null)
  const pending = useRef(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const created = useRef(false)
  const openerFocus = useOpenerFocus(open)
  const choices = purpose ? bots : bots.filter(bot => !bot.coordinator)
  const selected = picked.filter(id => choices.some(bot => bot.id === id))
  const ready = Boolean(title.trim() && selected.length && selected.length <= 100 && workspaceId)

  async function submit() {
    if (!ready || pending.current || error === 'unconfirmed') return
    pending.current = true
    setSaving(true)
    setError(null)
    try {
      const response = await fetch(withBasePath('/api/conversations'), {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId, ...(purpose ? { purpose, leadBotId: selected[0] } : {}), title: title.trim(), members: selected.map(memberId => ({ memberType: 'bot', memberId })) }),
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

  return <Dialog open={open} onOpenChange={next => { if (!pending.current) onOpenChange(next) }} onOpenChangeComplete={next => {
    if (!next) { setTitle(''); setPicked([]); setError(null); created.current = false }
  }}>
    <DialogContent aria-describedby={undefined} className="sm:max-w-md" showCloseButton={!saving} closeLabel={common('close')} finalFocus={() => !created.current && openerFocus()}>
      <DialogHeader><DialogTitle>{t('title')}</DialogTitle></DialogHeader>
      <form id="new-group" className="flex min-h-0 flex-col gap-4" onSubmit={event => { event.preventDefault(); void submit() }}>
        <FieldGroup>
        <Field>
          <FieldLabel htmlFor="new-group-title">{t('name')}</FieldLabel>
          <Input id="new-group-title" autoFocus value={title} maxLength={200} disabled={saving || error === 'unconfirmed'} onChange={event => setTitle(event.target.value)} />
        </Field>
        <FieldSet disabled={saving || error === 'unconfirmed'} className="gap-2">
          <FieldLegend variant="label">{t('bots')}</FieldLegend>
          {choices.length ? <FieldGroup className="max-h-72 gap-1 overflow-y-auto">
            {choices.map(bot => <Field key={bot.id} orientation="horizontal" className="min-w-0 rounded-lg p-2 hover:bg-control has-data-checked:bg-control">
              <Checkbox id={`new-group-bot-${bot.id}`} checked={selected.includes(bot.id)} onCheckedChange={checked => setPicked(current => checked ? [...new Set([...current, bot.id])] : current.filter(id => id !== bot.id))} disabled={saving || error === 'unconfirmed' || (!selected.includes(bot.id) && selected.length >= 100)} />
              <FieldLabel htmlFor={`new-group-bot-${bot.id}`} className="min-w-0 cursor-pointer">
                <BotAvatar id={bot.id} color={bot.color} shape={bot.shape} size="row" still />
                <span className="min-w-0 flex-1 truncate">{bot.name}</span>
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
        <Button type="button" variant="ghost" disabled={saving} onClick={() => onOpenChange(false)}>{common('cancel')}</Button>
        {error === 'unconfirmed'
          ? <Button type="button" onClick={onReviewGroups}>{t('reviewGroups')}</Button>
          : <Button type="submit" form="new-group" disabled={!ready || saving} aria-busy={saving}>{saving && <Spinner data-icon="inline-start" />}{t('create')}</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
