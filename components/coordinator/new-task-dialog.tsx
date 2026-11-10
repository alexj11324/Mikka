'use client'

import { useEffect, useRef, useState, useId } from 'react'
import { useTranslations } from 'next-intl'
import useSWR, { useSWRConfig } from 'swr'
import { toast } from 'sonner'
import { ChevronRight, KeyRound, Laptop, Paperclip } from 'lucide-react'
import { listDevices } from '@/app/actions/agents'
import { listBots } from '@/app/actions/bots'
import { issueCreationAvailable } from '@/app/actions/coordinator'
import { useCoordinatorSubmit } from './use-coordinator-submit'
import type { TaskDestination } from '@/lib/task-destination'
import { TEXT_ATTACHMENT_ACCEPT, textAttachment } from '@/lib/text-attachment'
import { Alert, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { DeviceIcon } from '@/components/devices/device-icon'
import { useComputer } from '@/hooks/use-computer'
import { cn } from '@/lib/utils'
import { machineDot, type PickerMachine } from '@/lib/machine-picker'
import { defaultTaskMachine, pickedTaskDestination, taskMachineUsable } from '@/lib/new-task-placement'
import { settingsRead } from '@/lib/settings-read'
import type { getModelOrder } from '@/app/actions/model-order'
import { E2BKeyDialog, useOwnE2BKey } from '@/components/settings/e2b-key-dialog'
import { usePresence } from '@/lib/use-presence'
import { BotAvatar, CoordinatorAvatar } from '@/components/nav/bot-avatar'
import { newTaskBotChoices } from '@/lib/new-task-bot'
import { useOpenerFocus } from '@/hooks/use-focus-return'
import { useChatFiles } from '@/components/chat/use-chat-files'
import { ChatFileCards } from '@/components/chat/chat-file-cards'
import { CHAT_FILE_ACCEPT } from '@mikka/protocol/chat-attachments'
import { taskProfileSelectable, useAgentProfiles } from '@/components/settings/factory-profiles-data'
import { TaskProfileNotice, TaskProfilePicker, useTaskProfileChoices } from './task-profile-picker'
import * as newTaskSlot from '@ui-slot/new-task'
import type { NewTaskMachine } from '@/components/slots/new-task-contract'

const MAX_LENGTH = 8000

type Machine = PickerMachine & { label: string; status?: string }

/** A machine's icon with its state dot (`machineDot`), and the state in words for screen readers. */
function MachineIcon({ machine, cloudBotId }: { machine: Machine; cloudBotId: string | undefined }) {
  const t = useTranslations('Shell.newTaskDialog')
  const tStatus = useTranslations('Computer.status')
  const e2b = useTranslations('Settings.secrets.e2b')
  const { data: state } = useComputer(machine.cloud && machine.usable ? cloudBotId : null)
  const dot = machineDot(machine, state)
  if (machine.cloud) return <DeviceIcon kind="cloud" state={dot} label={!machine.usable ? `E2B API Key ${e2b('missing')}` : state ? tStatus(state.machine === 'error' ? 'failed' : state.machine) : t('cloud')} />
  return <DeviceIcon kind="personal" state={dot} label={machine.status ?? (machine.usable ? t('online') : t('offline'))} />
}

function MachineLabel({ machine, cloudBotId }: { machine: Machine; cloudBotId: string | undefined }) {
  const t = useTranslations('Shell.newTaskDialog')
  return <><MachineIcon machine={machine} cloudBotId={cloudBotId} /><span className={cn('min-w-0 flex-1 truncate pr-3', !machine.usable && 'text-muted-foreground')}>{machine.label}</span>
    {machine.cloud && !machine.usable && <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"><KeyRound aria-hidden="true" className="size-3" />{t('addE2BKey')}</span>}
    {!machine.cloud && !machine.usable && machine.status && <span className="shrink-0 text-xs text-muted-foreground">{machine.status}</span>}</>
}

/**
 * 新建任务 the Comma way: say what needs doing in a sentence, on which machine and
 * for which bot, and that bot (the Coordinator by default) turns it into the task (title, status, assignee…). The
 * request goes into the Coordinator conversation, where its reply shows up. A UI layer's new-task slot draws the
 * window instead (docs/ui-overlay.md); the data, state and sending stay here.
 */
export function NewTaskDialog({ open, onOpenChange, onSent, project, projectId, workspaceId, initialText = '' }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSent?: () => void
  /** Project page the request came from. */
  project?: string | null
  projectId?:string|null
  workspaceId?: string
  /** Keys typed before the dialog finished opening. */
  initialText?: string
}) {
  const t = useTranslations('Shell.newTaskDialog')
  const tShell = useTranslations('Shell')
  const tDevices = useTranslations('Devices')
  const tCommon = useTranslations('Common')
  const sharing=useTranslations('ResourceAccess')
  const [visibility,setVisibility]=useState<'shared'|'private'>('shared')
  const locationT = useTranslations('Settings.modelOrder')
  const { submit: submitMessage, failureMessage } = useCoordinatorSubmit()
  const { mutate } = useSWRConfig()
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [picked, setPicked] = useState<string | null>(null)
  const profiles = useAgentProfiles(workspaceId, open, picked ? picked === 'cloud' ? { location: 'cloud' } : { location: 'local', deviceId: picked } : undefined)
  const [profilePick, setProfilePick] = useState<{ workspaceId: string; id: string } | null>(null)
  const profileId = profilePick?.workspaceId === workspaceId ? profilePick?.id : undefined
  const profileAllowed = !profileId || (!profiles.error && taskProfileSelectable(profileId, profiles.data))
  const openerFocus = useOpenerFocus(open)
  const [coordinatorUnavailable, setCoordinatorUnavailable] = useState(false)
  const tCoordinator = useTranslations('Coordinator')
  const { data: available = true } = useSWR(open ? 'issue-creation-available' : null, () => issueCreationAvailable())
  const fileRef = useRef<HTMLInputElement>(null)
  const composed = useRef<{ key: string; message: string; taskDestination?: TaskDestination } | null>(null)
  const fileId = useId()

  const { data: devices = [] } = useSWR(open ? 'devices' : null, listDevices)
  const { data: placement } = useSWR(open ? ['settings:model-order', 'current'] : null, () => settingsRead<Awaited<ReturnType<typeof getModelOrder>>>('model-order'))
  const order = placement && !placement.error ? placement : undefined
  const { data: bots = [] } = useSWR(open ? 'bots' : null, listBots)
  // 交给: the bot the request goes to (usability review T4). The Coordinator by default; a picked bot gets it
  // in its own chat, creates the task and dispatches it, so the board shows that bot on the card.
  const [botPick, setBotPick] = useState<string | null>(null)
  const botChoices = newTaskBotChoices(bots)
  const handler = botChoices.find(bot => bot.id === botPick) ?? null
  // The task runs on Mikka Cloud on the computer of the bot it goes to.
  const cloudBotId = handler?.id ?? (bots.find(bot => bot.coordinator) ?? bots[0])?.id
  const attachments = useChatFiles(draft, setDraft, cloudBotId ? { kind: 'bot', id: cloudBotId } : undefined, sending)
  // The menu's availability comes from the same dispatch planner as Settings. The default inherits
  // 运行位置 (会先用: the cloud, a server or a computer); only a destination the person explicitly picks becomes a fixed task destination.
  const e2bKey = useOwnE2BKey(open)
  const cloud: Machine = { value: 'cloud', label: t('cloud'), cloud: true, usable: e2bKey.configured !== false }
  const quotaUnchecked = order?.entries.some(entry => entry.block?.reason === 'checking')
  const own: Machine[] = devices.map(item => ({ value: item.id, label: item.name, usable: taskMachineUsable(item, order?.readyDeviceIds ?? []),
    status: !item.enabled ? t('notParticipating') : !item.online ? item.lastSeenAt ? t('offline') : tDevices('neverOnline') : !order ? t('loadingPlacement') : !order.readyDeviceIds.includes(item.id) ? quotaUnchecked ? t('quotaUnchecked') : t('modelUnavailable') : t('online') }))
  const machines: Machine[] = [cloud, ...own]
  const inherited = defaultTaskMachine(machines, order)
  const defaults: Machine = { value: 'auto', label: order ? `${t('workspaceDefault')} · ${inherited?.label ?? locationT(order.location)}` : t('workspaceDefault'),
    cloud: inherited?.cloud === true, usable: inherited?.usable ?? false, status: inherited?.status ?? (inherited?.usable ? t('online') : order ? quotaUnchecked ? t('quotaUnchecked') : t('modelUnavailable') : t('loadingPlacement')) }
  const device = machines.find(item => item.value === picked) ?? defaults
  // Picking Mikka Cloud without a key opens 填入 E2B Key; once saved, the task goes to the cloud.
  const [addingKey, setAddingKey] = useState(false)
  const keyDialog = usePresence(addingKey)
  function pick(value: string) {
    if (value === 'auto') { setPicked(null); return }
    if (value === cloud.value && !cloud.usable) { setAddingKey(true); return }
    setPicked(value)
  }
  useEffect(() => { if (open && initialText) setDraft(current => current || initialText) }, [open, initialText])

  async function attach(files: File[]) {
    if (cloudBotId) { attachments.add(files); return }
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
    if (!text || sending || attachments.locked || !available || !profileAllowed) return
    setSending(true)
    setCoordinatorUnavailable(false)
    try {
      const key = JSON.stringify([text, picked, project ?? null, projectId??null, visibility, handler?.id ?? null, profileId ?? null])
      if (composed.current?.key !== key) {
        const destination = pickedTaskDestination(picked)
        const context = [destination && device && t('contextDevice', { device: device.label }), project && t('contextProject', { project })].filter(Boolean).join(t('contextSeparator'))
        composed.current = { key, message: context ? t('promptWithContext', { context, text }) : t('prompt', { text }),
          ...(destination ? { taskDestination: destination } : {}) }
      }
      const outcome = await submitMessage(composed.current.message, { taskDestination: composed.current.taskDestination, botId: handler?.id ?? null, profileId,expectedWorkspaceId:workspaceId,taskCreation:{visibility,...projectId?{projectId}:{}} })
      if (outcome.kind === 'rejected' && outcome.error === 'coordinatorUnavailable') { setCoordinatorUnavailable(true); return }
      if (outcome.kind !== 'accepted') { const message = failureMessage(outcome); if (message) toast.error(message); return }
      setDraft('')
      setPicked(null)
      setProfilePick(null)
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

  const profileChoices = useTaskProfileChoices({ workspaceId, value: profileId ?? null, data: profiles.data })
  const keyDialogNode = keyDialog.value && <E2BKeyDialog open={keyDialog.open} onOpenChangeComplete={keyDialog.onOpenChangeComplete} configured={false} onClose={changed => { setAddingKey(false); if (changed) { void e2bKey.mutate(); setPicked(cloud.value) } }} />
  const NewTask = newTaskSlot.NewTask ?? null
  if (NewTask) {
    const machineNote = (machine: Machine) => machine.cloud && !machine.usable ? t('addE2BKey') : !machine.cloud && !machine.usable ? machine.status : undefined
    const slotMachine = (machine: Machine, group: NewTaskMachine['group']): NewTaskMachine => ({ value: machine.value, label: machine.label, icon: <MachineIcon machine={machine} cloudBotId={cloudBotId} />, usable: machine.usable, note: machineNote(machine), group })
    const notices = <>
      <TaskProfileNotice value={profileId ?? null} data={profiles.data} error={profiles.error} onRetry={() => { void profiles.mutate() }} />
      {!available && <p className="text-sm text-muted-foreground">{t('unavailable')}</p>}
      {coordinatorUnavailable && <Alert variant="destructive"><AlertTitle>{tCoordinator('unavailable', { name: 'Coordinator' })}</AlertTitle></Alert>}
    </>
    return <>
      {open && <NewTask onClose={() => onOpenChange(false)} project={project} text={attachments.text} onText={attachments.edit} maxLength={MAX_LENGTH}
        files={attachments.files.length || attachments.pending.length ? <ChatFileCards files={attachments.files} pending={attachments.pending} onRemove={attachments.remove} onRetry={attachments.retry} /> : null}
        onAttach={files => { void attach(files) }} accept={cloudBotId ? CHAT_FILE_ACCEPT : TEXT_ATTACHMENT_ACCEPT}
        machines={[slotMachine(defaults, 'default'), slotMachine(cloud, 'cloud'), ...own.map(item => slotMachine(item, 'own'))]} machine={picked ?? 'auto'} onMachine={pick}
        bots={botChoices.length > 0 ? [{ id: null, name: 'Coordinator', avatar: <CoordinatorAvatar size="row" /> }, ...botChoices.map(bot => ({ id: bot.id, name: bot.name, avatar: <BotAvatar id={bot.id} color={bot.color} shape={bot.shape} size="row" /> }))] : []}
        bot={handler?.id ?? null} onBot={setBotPick}
        profile={{ ...profileChoices, value: profileId ?? 'auto', onChange: id => setProfilePick(id !== 'auto' && workspaceId ? { workspaceId, id } : null), disabled: sending || !workspaceId }}
        notices={notices} sending={sending} canSubmit={available && profileAllowed && !!draft.trim() && !attachments.locked} onSubmit={() => { void submit() }} />}
      {keyDialogNode}
    </>
  }

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="gap-3 p-5 sm:max-w-2xl" closeLabel={tCommon('close')} finalFocus={openerFocus}>
      <FieldGroup><Field><FieldLabel htmlFor={`${fileId}-visibility`}>{sharing('visibility')}</FieldLabel><NativeSelect id={`${fileId}-visibility`} value={visibility} disabled={sending} onChange={event=>setVisibility(event.target.value as 'shared'|'private')}><NativeSelectOption value="shared">{sharing('shared')}</NativeSelectOption><NativeSelectOption value="private">{sharing('private')}</NativeSelectOption></NativeSelect><p className="text-xs text-muted-foreground">{sharing(projectId?'parentBoundary':'creationHint')}</p></Field></FieldGroup>
      <div className="flex flex-wrap items-center gap-2 pr-8 text-sm">
        {device
          ? <Select value={picked ?? 'auto'} onValueChange={value => { if (value) pick(value) }} items={[defaults, ...machines].map(({ value, label }) => ({ value, label }))}>
            <SelectTrigger size="sm" className="h-7 min-w-32 max-w-56 gap-1.5 rounded-full px-2.5" aria-label={t('device')}><MachineIcon machine={device} cloudBotId={cloudBotId} /><SelectValue className="min-w-0 truncate" /></SelectTrigger>
            <SelectContent align="start" alignItemWithTrigger={false} className="w-auto min-w-60">
              <SelectGroup><SelectItem value="auto"><MachineLabel machine={defaults} cloudBotId={cloudBotId} /></SelectItem></SelectGroup>
              <SelectGroup><SelectItem value={cloud.value}><MachineLabel machine={cloud} cloudBotId={cloudBotId} /></SelectItem></SelectGroup>
              {own.length > 0 && <SelectGroup><SelectLabel>{tDevices('thisMachine')}</SelectLabel>{own.map(item => <SelectItem key={item.value} value={item.value}><MachineLabel machine={item} cloudBotId={cloudBotId} /></SelectItem>)}</SelectGroup>}
            </SelectContent>
          </Select>
          : <span className="flex h-7 items-center gap-1.5 rounded-full bg-control px-2.5 text-muted-foreground"><Laptop aria-hidden="true" className="size-3.5" />{order ? t('noDevice') : t('loadingPlacement')}</span>}
        {botChoices.length > 0 && <Select value={handler?.id ?? 'coordinator'} onValueChange={value => setBotPick(value && value !== 'coordinator' ? value : null)} items={[{ value: 'coordinator', label: 'Coordinator' }, ...botChoices.map(bot => ({ value: bot.id, label: bot.name }))]}>
          <SelectTrigger size="sm" className="h-7 min-w-28 max-w-48 gap-1.5 rounded-full px-2.5" aria-label={t('bot')}>{handler ? <BotAvatar id={handler.id} color={handler.color} shape={handler.shape} size="row" /> : <CoordinatorAvatar size="row" />}<SelectValue className="min-w-0 truncate" /></SelectTrigger>
          <SelectContent align="start" alignItemWithTrigger={false} className="w-auto min-w-48">
            <SelectGroup>
              <SelectItem value="coordinator"><CoordinatorAvatar size="row" /><span className="min-w-0 flex-1 truncate pr-3">Coordinator</span></SelectItem>
              {botChoices.map(bot => <SelectItem key={bot.id} value={bot.id}><BotAvatar id={bot.id} color={bot.color} shape={bot.shape} size="row" /><span className="min-w-0 flex-1 truncate pr-3">{bot.name}</span></SelectItem>)}
            </SelectGroup>
          </SelectContent>
        </Select>}
        <TaskProfilePicker workspaceId={workspaceId} value={profileId ?? null} onChange={id => setProfilePick(id && workspaceId ? { workspaceId, id } : null)} data={profiles.data} disabled={sending} />
        {/* The chevron and the title wrap together, so the chevron never ends a line on its own. */}
        <span className="flex items-center gap-2 whitespace-nowrap"><ChevronRight aria-hidden="true" className="size-3.5 text-muted-foreground" />
        <DialogTitle className="text-sm font-medium">{t('title')}</DialogTitle></span>
        {project && <span className="flex h-7 max-w-40 items-center rounded-full bg-control px-2.5 text-xs text-muted-foreground"><span className="truncate">{project}</span></span>}
      </div>
      <DialogDescription className="sr-only">{t('description')}</DialogDescription>
      <TaskProfileNotice value={profileId ?? null} data={profiles.data} error={profiles.error} onRetry={() => { void profiles.mutate() }} />
      <FieldGroup onDragOver={event => { if (Array.from(event.dataTransfer.types).includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = sending ? 'none' : 'copy' } }} onDrop={event => { if (event.dataTransfer.files.length) { event.preventDefault(); void attach(Array.from(event.dataTransfer.files)) } }} onPaste={event => { if (event.clipboardData.files.length) { event.preventDefault(); void attach(Array.from(event.clipboardData.files)) } }}>
        <Field>
          <ChatFileCards files={attachments.files} pending={attachments.pending} onRemove={attachments.remove} onRetry={attachments.retry} />
          <FieldLabel htmlFor="new-issue-title" className="sr-only">{t('label')}</FieldLabel>
          <Textarea id="new-issue-title" autoFocus value={attachments.text} maxLength={MAX_LENGTH} disabled={sending} placeholder={t('placeholder')} className="min-h-32 resize-none border-0 px-0 text-base shadow-none focus-visible:ring-0 bg-transparent" onChange={event => attachments.edit(event.target.value)} onKeyDown={event => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void submit() }
          }} />
        </Field>
      </FieldGroup>
      <FieldGroup className="sr-only w-px"><Field><FieldLabel htmlFor={fileId}>{tShell('attach')}</FieldLabel><Input ref={fileRef} id={fileId} type="file" accept={cloudBotId ? CHAT_FILE_ACCEPT : TEXT_ATTACHMENT_ACCEPT} multiple className="sr-only" tabIndex={-1} onChange={event => { void attach(Array.from(event.target.files ?? [])); event.target.value = '' }} /></Field></FieldGroup>
      {!available && <p className="text-sm text-muted-foreground">{t('unavailable')}</p>}
      {coordinatorUnavailable && <Alert variant="destructive"><AlertTitle>{tCoordinator('unavailable', { name: 'Coordinator' })}</AlertTitle></Alert>}
      <div className="flex items-center gap-2">
        <Button variant="outline" size="icon-sm" className="rounded-full" aria-label={tShell('attach')} disabled={sending} onClick={() => fileRef.current?.click()}><Paperclip data-icon="inline-start" /></Button>
        <Button size="sm" className="ml-auto bg-sidebar-primary text-sidebar-primary-foreground hover:bg-sidebar-primary/90" disabled={!available || !profileAllowed || !draft.trim() || sending || attachments.locked} aria-keyshortcuts="Control+Enter Meta+Enter" onClick={() => { void submit() }}>{sending ? t('sending') : t('create')}</Button>
      </div>
      {keyDialogNode}
    </DialogContent>
  </Dialog>
}
