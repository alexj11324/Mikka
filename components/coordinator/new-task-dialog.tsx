'use client'

import { useEffect, useRef, useState, useId } from 'react'
import { useTranslations } from 'next-intl'
import useSWR, { useSWRConfig } from 'swr'
import { toast } from 'sonner'
import { ChevronRight, Laptop, Paperclip } from 'lucide-react'
import { listDevices } from '@/app/actions/agents'
import { listBots } from '@/app/actions/bots'
import { issueCreationAvailable } from '@/app/actions/coordinator'
import { useCoordinatorSubmit } from './use-coordinator-submit'
import type { TaskDestination } from '@/lib/task-destination'
import { TEXT_ATTACHMENT_ACCEPT, textAttachment } from '@/lib/text-attachment'
import { Alert, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { DeviceIcon } from '@/components/devices/device-icon'
import { useComputer } from '@/hooks/use-computer'

const MAX_LENGTH = 8000

type Machine = { value: string; label: string; cloud?: boolean; online?: boolean }

/** A machine's icon with its state dot. Mikka Cloud stays green asleep, since picking it wakes it; red only when it failed (the workspace has one, so any bot's computer reports it). */
function MachineIcon({ machine, cloudBotId }: { machine: Machine; cloudBotId: string | undefined }) {
  const t = useTranslations('Shell.newTaskDialog')
  const tStatus = useTranslations('Computer.status')
  const { data: state } = useComputer(machine.cloud ? cloudBotId : null)
  if (machine.cloud) return <DeviceIcon kind="cloud" state={state?.machine === 'error' ? 'error' : 'online'} label={state ? tStatus(state.machine === 'error' ? 'failed' : state.machine) : t('cloud')} />
  return <DeviceIcon kind="personal" state={machine.online ? 'online' : 'offline'} label={machine.online ? t('online') : t('offline')} />
}

function MachineLabel({ machine, cloudBotId }: { machine: Machine; cloudBotId: string | undefined }) {
  return <><MachineIcon machine={machine} cloudBotId={cloudBotId} /><span className="min-w-0 flex-1 truncate pr-3">{machine.label}</span></>
}

/**
 * 新建任务 the Comma way: say what needs doing in a sentence, on which machine,
 * and the Coordinator turns it into the task (title, status, assignee…). The
 * request goes into the Coordinator conversation, where its reply shows up.
 */
export function NewTaskDialog({ open, onOpenChange, onSent, project, initialText = '' }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSent?: () => void
  /** Project page the request came from. */
  project?: string | null
  /** Keys typed before the dialog finished opening. */
  initialText?: string
}) {
  const t = useTranslations('Shell.newTaskDialog')
  const tShell = useTranslations('Shell')
  const tDevices = useTranslations('Devices')
  const tCommon = useTranslations('Common')
  const { submit: submitMessage, failureMessage } = useCoordinatorSubmit()
  const { mutate } = useSWRConfig()
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [coordinatorUnavailable, setCoordinatorUnavailable] = useState(false)
  const tCoordinator = useTranslations('Coordinator')
  const { data: available = true } = useSWR(open ? 'issue-creation-available' : null, () => issueCreationAvailable())
  const fileRef = useRef<HTMLInputElement>(null)
  const composed = useRef<{ key: string; message: string; taskDestination: TaskDestination } | null>(null)
  const fileId = useId()

  const { data: devices = [] } = useSWR(open ? 'devices' : null, listDevices)
  const { data: bots = [] } = useSWR(open ? 'bots' : null, listBots)
  const cloudBotId = bots[0]?.id
  // Mikka Cloud first and by default: there the Coordinator picks the bot, so no bot is named.
  // Direct daemon devices are 本机, including Linux. OS is not evidence that
  // a computer is an SSH target reached through another machine (R-23).
  const cloud: Machine = { value: 'cloud', label: t('cloud'), cloud: true }
  const own: Machine[] = devices.map(item => ({ value: item.id, label: item.name, online: item.online }))
  // R-23: the task keeps its chosen destination even when cloud execution is
  // unavailable; the Coordinator can create it and report the missing setup.
  const machines: Machine[] = [cloud, ...own]
  const [picked, setPicked] = useState<string | null>(null)
  const device = machines.find(item => item.value === picked) ?? machines[0]
  useEffect(() => { if (open && initialText) setDraft(current => current || initialText) }, [open, initialText])

  async function attach(files: File[]) {
    let next = draft
    for (const file of files) {
      const block = await textAttachment(file, MAX_LENGTH - next.length - 2)
      if (!block) { toast.error(tShell('attachUnsupported', { max: MAX_LENGTH })); continue }
      next = next.trim() ? `${next.trimEnd()}\n\n${block}` : block
    }
    setDraft(next)
  }

  async function submit() {
    const text = draft.trim()
    if (!text || sending || !available) return
    setSending(true)
    setCoordinatorUnavailable(false)
    try {
      const key = JSON.stringify([text, picked, project ?? null])
      if (composed.current?.key !== key) {
        const context = [device && t('contextDevice', { device: device.label }), project && t('contextProject', { project })].filter(Boolean).join(t('contextSeparator'))
        composed.current = { key, message: context ? t('promptWithContext', { context, text }) : t('prompt', { text }),
          taskDestination: device.cloud ? { kind: 'cloud' } : { kind: 'device', deviceId: device.value } }
      }
      const outcome = await submitMessage(composed.current.message, { taskDestination: composed.current.taskDestination })
      if (outcome.kind === 'rejected' && outcome.error === 'coordinatorUnavailable') { setCoordinatorUnavailable(true); return }
      if (outcome.kind !== 'accepted') { const message = failureMessage(outcome); if (message) toast.error(message); return }
      setDraft('')
      composed.current = null
      onOpenChange(false)
      onSent?.()
      void mutate('coordinator-chat')
    } catch {
      toast.error(t('failed'))
    } finally {
      setSending(false)
    }
  }

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="gap-3 p-5 sm:max-w-2xl" closeLabel={tCommon('close')}>
      <div className="flex items-center gap-2 pr-8 text-sm">
        {device
          ? <Select value={device.value} onValueChange={value => setPicked(value)} items={machines.map(({ value, label }) => ({ value, label }))}>
            <SelectTrigger size="sm" className="h-7 min-w-32 max-w-56 gap-1.5 rounded-full px-2.5" aria-label={t('device')}><MachineIcon machine={device} cloudBotId={cloudBotId} /><SelectValue className="min-w-0 truncate" /></SelectTrigger>
            <SelectContent align="start" alignItemWithTrigger={false} className="w-auto min-w-60">
              <SelectGroup><SelectItem value={cloud.value}><MachineLabel machine={cloud} cloudBotId={cloudBotId} /></SelectItem></SelectGroup>
              {own.length > 0 && <SelectGroup><SelectLabel>{tDevices('thisMachine')}</SelectLabel>{own.map(item => <SelectItem key={item.value} value={item.value}><MachineLabel machine={item} cloudBotId={cloudBotId} /></SelectItem>)}</SelectGroup>}
            </SelectContent>
          </Select>
          : <span className="flex h-7 items-center gap-1.5 rounded-full bg-control px-2.5 text-muted-foreground"><Laptop aria-hidden="true" className="size-3.5" />{t('noDevice')}</span>}
        <ChevronRight aria-hidden="true" className="size-3.5 text-muted-foreground" />
        <DialogTitle className="text-sm font-medium">{t('title')}</DialogTitle>
        {project && <span className="flex h-7 max-w-40 items-center rounded-full bg-control px-2.5 text-xs text-muted-foreground"><span className="truncate">{project}</span></span>}
      </div>
      <DialogDescription className="sr-only">{t('description')}</DialogDescription>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="new-issue-title" className="sr-only">{t('label')}</FieldLabel>
          <Textarea id="new-issue-title" autoFocus value={draft} maxLength={MAX_LENGTH} disabled={sending} placeholder={t('placeholder')} className="min-h-32 resize-none border-0 px-0 text-base shadow-none focus-visible:ring-0 bg-transparent" onChange={event => setDraft(event.target.value)} onKeyDown={event => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void submit() }
          }} />
        </Field>
      </FieldGroup>
      <FieldGroup className="sr-only w-px"><Field><FieldLabel htmlFor={fileId}>{tShell('attach')}</FieldLabel><Input ref={fileRef} id={fileId} type="file" accept={TEXT_ATTACHMENT_ACCEPT} multiple className="sr-only" tabIndex={-1} onChange={event => { void attach(Array.from(event.target.files ?? [])); event.target.value = '' }} /></Field></FieldGroup>
      {!available && <p className="text-sm text-muted-foreground">{t('unavailable')}</p>}
      {coordinatorUnavailable && <Alert variant="destructive"><AlertTitle>{tCoordinator('unavailable', { name: 'Coordinator' })}</AlertTitle></Alert>}
      <div className="flex items-center gap-2">
        <Button variant="outline" size="icon-sm" className="rounded-full" aria-label={tShell('attach')} disabled={sending} onClick={() => fileRef.current?.click()}><Paperclip data-icon="inline-start" /></Button>
        <Button size="sm" className="ml-auto bg-sidebar-primary text-sidebar-primary-foreground hover:bg-sidebar-primary/90" disabled={!available || !draft.trim() || sending} aria-keyshortcuts="Control+Enter Meta+Enter" onClick={() => { void submit() }}>{sending ? t('sending') : t('create')}</Button>
      </div>
    </DialogContent>
  </Dialog>
}
