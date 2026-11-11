'use client'

import { useEffect, useRef, useState, useId } from 'react'
import { useTranslations } from 'next-intl'
import useSWR, { useSWRConfig } from 'swr'
import { toast } from 'sonner'
import { ChevronRight, KeyRound, Laptop, Paperclip } from 'lucide-react'
import { listDevices } from '@/app/actions/agents'
import { listBots } from '@/app/actions/bots'
import { issueCreationAvailable } from '@/app/actions/coordinator'
import { useActionError } from '@/lib/use-action-error'
import { backlogTaskDraft } from '@/lib/task-create-form'
import { TASK_TITLE_MAX } from '@/lib/task-title-input'
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
/** The task's short title column. */
const TITLE_MAX = TASK_TITLE_MAX

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
export function NewTaskDialog({ open, onOpenChange, onSent, project, workspaceId, onCreated, initialIntent = 'create_and_dispatch', initialBotId, initialText = '' }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSent?: () => void
  onCreated?: (taskId: string) => void
  initialIntent?: 'create_only' | 'create_and_dispatch'
  initialBotId?: string
  /** Project page the request came from. */
  project?: string | null
  workspaceId?: string
  /** Keys typed before the dialog finished opening. */
  initialText?: string
}) {
  const t = useTranslations('Shell.newTaskDialog')
  const tShell = useTranslations('Shell')
  const tDevices = useTranslations('Devices')
  const tCommon = useTranslations('Common')
  const locationT = useTranslations('Settings.modelOrder')
  const { submit: submitMessage, failureMessage } = useCoordinatorSubmit()
  const { mutate } = useSWRConfig()
  const actionError = useActionError()
  const [intent, setIntent] = useState(initialIntent)
  const only = Boolean(onCreated && workspaceId && !project && intent === 'create_only')
  const dispatching = open && !only
  const pending = useRef(false)
  const createRequests = useRef(new Map<string, string>())
  const [draft, setDraft] = useState('')
  // 标题 (optional): written by the person, the task gets exactly it; empty, the Bot writes one.
  const [title, setTitle] = useState('')
  const descriptionRef = useRef<HTMLTextAreaElement>(null)
  const [sending, setSending] = useState(false)
  const [picked, setPicked] = useState<string | null>(null)
  const profiles = useAgentProfiles(workspaceId, dispatching, picked ? picked === 'cloud' ? { location: 'cloud' } : { location: 'local', deviceId: picked } : undefined)
  const [profilePick, setProfilePick] = useState<{ workspaceId: string; id: string } | null>(null)
  const profileId = profilePick?.workspaceId === workspaceId ? profilePick?.id : undefined
  const profileAllowed = !profileId || (!profiles.error && taskProfileSelectable(profileId, profiles.data))
  const openerFocus = useOpenerFocus(open)
  const [coordinatorUnavailable, setCoordinatorUnavailable] = useState(false)
  const tCoordinator = useTranslations('Coordinator')
  const { data: available = true } = useSWR(dispatching ? 'issue-creation-available' : null, () => issueCreationAvailable())
  const fileRef = useRef<HTMLInputElement>(null)
  const composed = useRef<{ key: string; message: string; taskTitle?: string; taskDestination?: TaskDestination } | null>(null)
  const fileId = useId()

  const { data: devices = [] } = useSWR(dispatching ? 'devices' : null, listDevices)
  const { data: placement } = useSWR(dispatching ? ['settings:model-order', 'current'] : null, () => settingsRead<Awaited<ReturnType<typeof getModelOrder>>>('model-order'))
  const order = placement && !placement.error ? placement : undefined
  const { data: bots = [] } = useSWR(dispatching ? 'bots' : null, listBots)
  // 交给: the bot the request goes to (usability review T4). The Coordinator by default; a picked bot gets it
  // in its own chat, creates the task and dispatches it, so the board shows that bot on the card.
  const [botPick, setBotPick] = useState<string | null>(initialBotId ?? null)
  const botChoices = newTaskBotChoices(bots)
  const handler = botChoices.find(bot => bot.id === botPick) ?? null
  // The task runs on Mikka Cloud on the computer of the bot it goes to.
  const cloudBotId = only ? undefined : handler?.id ?? (bots.find(bot => bot.coordinator) ?? bots[0])?.id
  const attachments = useChatFiles(draft, setDraft, cloudBotId ? { kind: 'bot', id: cloudBotId } : undefined, sending)
  // The menu's availability comes from the same dispatch planner as Settings. The default inherits
  // 运行位置 (会先用: the cloud, a server or a computer); only a destination the person explicitly picks becomes a fixed task destination.
  const e2bKey = useOwnE2BKey(dispatching)
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
    const name = title.trim()
    const text = draft.trim() || name
    if (!text || pending.current || attachments.locked || (!only && (!available || !profileAllowed || botPick && !handler))) return
    pending.current = true
    setSending(true)
    setCoordinatorUnavailable(false)
    try {
      if (only && workspaceId) {
        const fingerprint = JSON.stringify([workspaceId, name, text])
        const requestId = createRequests.current.get(fingerprint) ?? crypto.randomUUID()
        createRequests.current.set(fingerprint, requestId)
        const { createTaskOnly } = await import('@/app/actions/issues')
        const result = await createTaskOnly({ version: 1, intent: 'create_only', workspaceId, requestId,
          ...backlogTaskDraft(name, text) })
        if (result.error || !('taskId' in result)) { toast.error(actionError(result.error)); return }
        createRequests.current.delete(fingerprint)
        setDraft('')
        setTitle('')
        onOpenChange(false)
        onCreated?.(result.taskId)
        return
      }
      const key = JSON.stringify([workspaceId, text, name, picked, project ?? null, handler?.id ?? null, profileId ?? null])
      if (composed.current?.key !== key) {
        const destination = pickedTaskDestination(picked)
        const context = [destination && device && t('contextDevice', { device: device.label }), project && t('contextProject', { project })].filter(Boolean).join(t('contextSeparator'))
        composed.current = { key, message: context ? t('promptWithContext', { context, text }) : t('prompt', { text }),
          ...(name ? { taskTitle: name } : {}),
          ...(destination ? { taskDestination: destination } : {}) }
      }
      const outcome = await submitMessage(composed.current.message, { taskDestination: composed.current.taskDestination, botId: handler?.id ?? null, profileId, taskTitle: composed.current.taskTitle, expectedWorkspaceId: workspaceId, ...(workspaceId && !project ? { taskCommand: { version: 1, intent: 'create_and_dispatch', description: text } } : {}) })
      if (outcome.kind === 'rejected' && outcome.error === 'coordinatorUnavailable') { setCoordinatorUnavailable(true); return }
      if (outcome.kind !== 'accepted') { const message = failureMessage(outcome); if (message) toast.error(message); return }
      setDraft('')
      setTitle('')
      setPicked(null)
      setProfilePick(null)
      composed.current = null
      onOpenChange(false)
      if (outcome.task && onCreated) onCreated(outcome.task.taskId)
      else onSent?.()
      void mutate('coordinator-chat')
    } catch {
      toast.error(t('failed'))
    } finally {
      pending.current = false
      setSending(false)
    }
  }

  const profileChoices = useTaskProfileChoices({ workspaceId, value: profileId ?? null, data: profiles.data })
  const keyDialogNode = keyDialog.value && <E2BKeyDialog open={keyDialog.open} onOpenChangeComplete={keyDialog.onOpenChangeComplete} configured={false} onClose={changed => { setAddingKey(false); if (changed) { void e2bKey.mutate(); setPicked(cloud.value) } }} />
  const chooseIntent = onCreated && workspaceId && !project ? <Field>
    <FieldLabel htmlFor="new-task-intent">{t('intent')}</FieldLabel>
    <Select value={intent} onValueChange={value => { if (value === 'create_only' || value === 'create_and_dispatch') setIntent(value) }}
      disabled={sending || attachments.locked || attachments.files.length > 0} items={[
        { value: 'create_only', label: t('createOnly') }, { value: 'create_and_dispatch', label: t('createAndDispatch') },
      ]}>
      <SelectTrigger id="new-task-intent" size="sm"><SelectValue /></SelectTrigger>
      <SelectContent><SelectGroup><SelectItem value="create_only">{t('createOnly')}</SelectItem>
        <SelectItem value="create_and_dispatch">{t('createAndDispatch')}</SelectItem></SelectGroup></SelectContent>
    </Select>
  </Field> : null
  const NewTask = newTaskSlot.NewTask ?? null
  if (NewTask) {
    const machineNote = (machine: Machine) => machine.cloud && !machine.usable ? t('addE2BKey') : !machine.cloud && !machine.usable ? machine.status : undefined
    const slotMachine = (machine: Machine, group: NewTaskMachine['group']): NewTaskMachine => ({ value: machine.value, label: machine.label, icon: <MachineIcon machine={machine} cloudBotId={cloudBotId} />, usable: machine.usable, note: machineNote(machine), group })
    const notices = <>
      {chooseIntent}
      {!only && <TaskProfileNotice value={profileId ?? null} data={profiles.data} error={profiles.error} onRetry={() => { void profiles.mutate() }} />}
      {!only && !available && <p className="text-sm text-muted-foreground">{t('unavailable')}</p>}
      {!only && coordinatorUnavailable && <Alert variant="destructive"><AlertTitle>{tCoordinator('unavailable', { name: 'Coordinator' })}</AlertTitle></Alert>}
    </>
    return <>
      {open && <NewTask onClose={() => onOpenChange(false)} project={project} title={title} onTitle={setTitle} titleMax={TITLE_MAX} text={attachments.text} onText={attachments.edit} maxLength={MAX_LENGTH}
        files={attachments.files.length || attachments.pending.length ? <ChatFileCards files={attachments.files} pending={attachments.pending} onRemove={attachments.remove} onRetry={attachments.retry} /> : null}
        onAttach={files => { void attach(files) }} accept={cloudBotId ? CHAT_FILE_ACCEPT : TEXT_ATTACHMENT_ACCEPT}
        machines={only ? [] : [slotMachine(defaults, 'default'), slotMachine(cloud, 'cloud'), ...own.map(item => slotMachine(item, 'own'))]} machine={picked ?? 'auto'} onMachine={pick}
        bots={!only && botChoices.length > 0 ? [{ id: null, name: 'Coordinator', avatar: <CoordinatorAvatar size="row" /> }, ...botChoices.map(bot => ({ id: bot.id, name: bot.name, avatar: <BotAvatar id={bot.id} color={bot.color} shape={bot.shape} size="row" /> }))] : []}
        bot={handler?.id ?? null} onBot={setBotPick}
        profile={{ ...profileChoices, value: profileId ?? 'auto', onChange: id => setProfilePick(id !== 'auto' && workspaceId ? { workspaceId, id } : null), disabled: sending || !workspaceId }}
        intent={chooseIntent ? intent : undefined} notices={notices} sending={sending} canSubmit={(only || available && profileAllowed && (!botPick || !!handler)) && !!(draft.trim() || title.trim()) && !attachments.locked} onSubmit={() => { void submit() }} />}
      {keyDialogNode}
    </>
  }

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="gap-3 p-5 sm:max-w-2xl" closeLabel={tCommon('close')} finalFocus={openerFocus}>
      <div className="flex flex-wrap items-center gap-2 pr-8 text-sm">
        {!only && (device
          ? <Select value={picked ?? 'auto'} onValueChange={value => { if (value) pick(value) }} items={[defaults, ...machines].map(({ value, label }) => ({ value, label }))}>
            <SelectTrigger size="sm" className="h-7 min-w-32 max-w-56 gap-1.5 rounded-full px-2.5" aria-label={t('device')}><MachineIcon machine={device} cloudBotId={cloudBotId} /><SelectValue className="min-w-0 truncate" /></SelectTrigger>
            <SelectContent align="start" alignItemWithTrigger={false} className="w-auto min-w-60">
              <SelectGroup><SelectItem value="auto"><MachineLabel machine={defaults} cloudBotId={cloudBotId} /></SelectItem></SelectGroup>
              <SelectGroup><SelectItem value={cloud.value}><MachineLabel machine={cloud} cloudBotId={cloudBotId} /></SelectItem></SelectGroup>
              {own.length > 0 && <SelectGroup><SelectLabel>{tDevices('thisMachine')}</SelectLabel>{own.map(item => <SelectItem key={item.value} value={item.value}><MachineLabel machine={item} cloudBotId={cloudBotId} /></SelectItem>)}</SelectGroup>}
            </SelectContent>
          </Select>
          : <span className="flex h-7 items-center gap-1.5 rounded-full bg-control px-2.5 text-muted-foreground"><Laptop aria-hidden="true" className="size-3.5" />{order ? t('noDevice') : t('loadingPlacement')}</span>)}
        {!only && botChoices.length > 0 && <Select value={handler?.id ?? 'coordinator'} onValueChange={value => setBotPick(value && value !== 'coordinator' ? value : null)} items={[{ value: 'coordinator', label: 'Coordinator' }, ...botChoices.map(bot => ({ value: bot.id, label: bot.name }))]}>
          <SelectTrigger size="sm" className="h-7 min-w-28 max-w-48 gap-1.5 rounded-full px-2.5" aria-label={t('bot')}>{handler ? <BotAvatar id={handler.id} color={handler.color} shape={handler.shape} size="row" /> : <CoordinatorAvatar size="row" />}<SelectValue className="min-w-0 truncate" /></SelectTrigger>
          <SelectContent align="start" alignItemWithTrigger={false} className="w-auto min-w-48">
            <SelectGroup>
              <SelectItem value="coordinator"><CoordinatorAvatar size="row" /><span className="min-w-0 flex-1 truncate pr-3">Coordinator</span></SelectItem>
              {botChoices.map(bot => <SelectItem key={bot.id} value={bot.id}><BotAvatar id={bot.id} color={bot.color} shape={bot.shape} size="row" /><span className="min-w-0 flex-1 truncate pr-3">{bot.name}</span></SelectItem>)}
            </SelectGroup>
          </SelectContent>
        </Select>}
        {!only && <TaskProfilePicker workspaceId={workspaceId} value={profileId ?? null} onChange={id => setProfilePick(id && workspaceId ? { workspaceId, id } : null)} data={profiles.data} disabled={sending} />}
        {/* The chevron and the title wrap together, so the chevron never ends a line on its own. */}
        <span className="flex items-center gap-2 whitespace-nowrap"><ChevronRight aria-hidden="true" className="size-3.5 text-muted-foreground" />
        <DialogTitle className="text-sm font-medium">{t('title')}</DialogTitle></span>
        {project && <span className="flex h-7 max-w-40 items-center rounded-full bg-control px-2.5 text-xs text-muted-foreground"><span className="truncate">{project}</span></span>}
      </div>
      <DialogDescription className="sr-only">{t('description')}</DialogDescription>
      {chooseIntent}
      {!only && <TaskProfileNotice value={profileId ?? null} data={profiles.data} error={profiles.error} onRetry={() => { void profiles.mutate() }} />}
      <FieldGroup onDragOver={event => { if (Array.from(event.dataTransfer.types).includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = sending ? 'none' : 'copy' } }} onDrop={event => { if (event.dataTransfer.files.length) { event.preventDefault(); void attach(Array.from(event.dataTransfer.files)) } }} onPaste={event => { if (event.clipboardData.files.length) { event.preventDefault(); void attach(Array.from(event.clipboardData.files)) } }}>
        <Field>
          <ChatFileCards files={attachments.files} pending={attachments.pending} onRemove={attachments.remove} onRetry={attachments.retry} />
          <FieldLabel htmlFor="new-task-name" className="sr-only">{t('titleLabel')}</FieldLabel>
          <Input id="new-task-name" autoFocus value={title} maxLength={TITLE_MAX} disabled={sending} placeholder={t(only ? 'backlogTitlePlaceholder' : 'titlePlaceholder')} className="h-auto border-0 bg-transparent px-0 text-lg font-medium shadow-none focus-visible:ring-0" onChange={event => setTitle(event.target.value)} onKeyDown={event => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
            event.preventDefault()
            if (event.metaKey || event.ctrlKey) void submit(); else descriptionRef.current?.focus()
          }} />
          <FieldLabel htmlFor="new-issue-title" className="sr-only">{t('label')}</FieldLabel>
          <Textarea ref={descriptionRef} id="new-issue-title" value={attachments.text} maxLength={MAX_LENGTH} disabled={sending} placeholder={t('placeholder')} className="min-h-28 resize-none border-0 px-0 text-base shadow-none focus-visible:ring-0 bg-transparent" onChange={event => attachments.edit(event.target.value)} onKeyDown={event => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void submit() }
          }} />
        </Field>
      </FieldGroup>
      <FieldGroup className="sr-only w-px"><Field><FieldLabel htmlFor={fileId}>{tShell('attach')}</FieldLabel><Input ref={fileRef} id={fileId} type="file" accept={cloudBotId ? CHAT_FILE_ACCEPT : TEXT_ATTACHMENT_ACCEPT} multiple className="sr-only" tabIndex={-1} onChange={event => { void attach(Array.from(event.target.files ?? [])); event.target.value = '' }} /></Field></FieldGroup>
      {!only && !available && <p className="text-sm text-muted-foreground">{t('unavailable')}</p>}
      {!only && coordinatorUnavailable && <Alert variant="destructive"><AlertTitle>{tCoordinator('unavailable', { name: 'Coordinator' })}</AlertTitle></Alert>}
      <div className="flex items-center gap-2">
        <Button variant="outline" size="icon-sm" className="rounded-full" aria-label={tShell('attach')} disabled={sending} onClick={() => fileRef.current?.click()}><Paperclip data-icon="inline-start" /></Button>
        <Button size="sm" className="ml-auto bg-sidebar-primary text-sidebar-primary-foreground hover:bg-sidebar-primary/90" disabled={(!only && (!available || !profileAllowed || !!botPick && !handler)) || !(draft.trim() || title.trim()) || sending || attachments.locked} aria-keyshortcuts="Control+Enter Meta+Enter" onClick={() => { void submit() }}>{sending ? t('sending') : t(chooseIntent ? only ? 'createOnly' : 'createAndDispatch' : 'create')}</Button>
      </div>
      {keyDialogNode}
    </DialogContent>
  </Dialog>
}
