'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import useSWR, { useSWRConfig } from 'swr'
import { toast } from 'sonner'
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
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { DeviceIcon } from '@/components/devices/device-icon'
import { useComputer } from '@/hooks/use-computer'
import { machineDot, type PickerMachine } from '@/lib/machine-picker'
import { defaultTaskMachine, pickedTaskDestination, taskMachineUsable } from '@/lib/new-task-placement'
import { settingsRead } from '@/lib/settings-read'
import type { getModelOrder } from '@/app/actions/model-order'
import { E2BKeyDialog, useOwnE2BKey } from '@/components/settings/e2b-key-dialog'
import { usePresence } from '@/lib/use-presence'
import { BotAvatar, CoordinatorAvatar } from '@/components/nav/bot-avatar'
import { newTaskBotChoices } from '@/lib/new-task-bot'
import { useChatFiles } from '@/components/chat/use-chat-files'
import { ChatFileCards } from '@/components/chat/chat-file-cards'
import { CHAT_FILE_ACCEPT } from '@mikka/protocol/chat-attachments'
import { taskProfileSelectable, useAgentProfiles } from '@/components/settings/factory-profiles-data'
import { TaskProfileNotice, useTaskProfileChoices } from './task-profile-picker'
import { NewTask } from '@ui-slot/new-task'
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

/**
 * 新建任务 the Comma way: say what needs doing in a sentence, on which machine and
 * for which bot, and that bot (the Coordinator by default) turns it into the task (title, status, assignee…). The
 * request goes into the Coordinator conversation, where its reply shows up. A UI layer's new-task slot draws the
 * window instead (docs/ui-overlay.md); the data, state and sending stay here.
 */
export function NewTaskDialog({ open, onOpenChange, onSent, project, workspaceId, teamId, onCreated, initialIntent = 'create_and_dispatch', initialBotId, initialText = '' }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSent?: () => void
  onCreated?: (taskId: string) => void
  initialIntent?: 'create_only' | 'create_and_dispatch'
  initialBotId?: string
  /** Project page the request came from. */
  project?: string | null
  workspaceId?: string
  teamId?: string
  /** Keys typed before the dialog finished opening. */
  initialText?: string
}) {
  const t = useTranslations('Shell.newTaskDialog')
  const tShell = useTranslations('Shell')
  const tDevices = useTranslations('Devices')
  const locationT = useTranslations('Settings.modelOrder')
  const { submit: submitMessage, failureMessage } = useCoordinatorSubmit()
  const { mutate } = useSWRConfig()
  const actionError = useActionError()
  const [intent, setIntent] = useState(initialIntent)
  const only = Boolean(onCreated && workspaceId && !project && intent === 'create_only')
  const dispatching = open && !only
  const intentField = useRef<HTMLDivElement>(null)
  const pending = useRef(false)
  const createRequests = useRef(new Map<string, string>())
  const [draft, setDraft] = useState('')
  // 标题 (optional): written by the person, the task gets exactly it; empty, the Bot writes one.
  const [title, setTitle] = useState('')
  const [sending, setSending] = useState(false)
  const [picked, setPicked] = useState<string | null>(null)
  const profiles = useAgentProfiles(workspaceId, dispatching, picked ? picked === 'cloud' ? { location: 'cloud' } : { location: 'local', deviceId: picked } : undefined)
  const [profilePick, setProfilePick] = useState<{ workspaceId: string; id: string } | null>(null)
  const profileId = profilePick?.workspaceId === workspaceId ? profilePick?.id : undefined
  const profileAllowed = !profileId || (!profiles.error && taskProfileSelectable(profileId, profiles.data))
  const [coordinatorUnavailable, setCoordinatorUnavailable] = useState(false)
  const tCoordinator = useTranslations('Coordinator')
  const { data: available = true } = useSWR(dispatching ? 'issue-creation-available' : null, () => issueCreationAvailable())
  const composed = useRef<{ key: string; message: string; taskTitle?: string; taskDestination?: TaskDestination } | null>(null)

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
        const fingerprint = JSON.stringify([workspaceId, teamId, name, text])
        const requestId = createRequests.current.get(fingerprint) ?? crypto.randomUUID()
        createRequests.current.set(fingerprint, requestId)
        const { createTaskOnly } = await import('@/app/actions/issues')
        const result = await createTaskOnly({ version: 1, intent: 'create_only', workspaceId, requestId, ...(teamId ? { teamId } : {}),
          ...backlogTaskDraft(name, text) })
        if (result.error || !('taskId' in result)) { toast.error(actionError(result.error)); return }
        createRequests.current.delete(fingerprint)
        setDraft('')
        setTitle('')
        onOpenChange(false)
        onCreated?.(result.taskId)
        return
      }
      const key = JSON.stringify([workspaceId, teamId, text, name, picked, project ?? null, handler?.id ?? null, profileId ?? null])
      if (composed.current?.key !== key) {
        const destination = pickedTaskDestination(picked)
        const context = [destination && device && t('contextDevice', { device: device.label }), project && t('contextProject', { project })].filter(Boolean).join(t('contextSeparator'))
        composed.current = { key, message: context ? t('promptWithContext', { context, text }) : t('prompt', { text }),
          ...(name ? { taskTitle: name } : {}),
          ...(destination ? { taskDestination: destination } : {}) }
      }
      const outcome = await submitMessage(composed.current.message, { taskDestination: composed.current.taskDestination, botId: handler?.id ?? null, profileId, taskTitle: composed.current.taskTitle, expectedWorkspaceId: workspaceId, ...(workspaceId && !project ? { taskCommand: { version: 1, intent: 'create_and_dispatch', description: text, ...(teamId ? { teamId } : {}) } } : {}) })
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
  const chooseIntent = onCreated && workspaceId && !project ? <FieldGroup>
    <Field ref={intentField}>
      <FieldLabel htmlFor="new-task-intent">{t('intent')}</FieldLabel>
      <Select value={intent} onValueChange={value => { if (value === 'create_only' || value === 'create_and_dispatch') setIntent(value) }}
        disabled={sending || attachments.locked || attachments.files.length > 0} items={[
          { value: 'create_only', label: t('createOnly') }, { value: 'create_and_dispatch', label: t('createAndDispatch') },
        ]}>
        <SelectTrigger id="new-task-intent" size="sm"><SelectValue /></SelectTrigger>
        <SelectContent portalContainer={intentField}><SelectGroup><SelectItem value="create_only">{t('createOnly')}</SelectItem>
          <SelectItem value="create_and_dispatch">{t('createAndDispatch')}</SelectItem></SelectGroup></SelectContent>
      </Select>
    </Field>
  </FieldGroup> : null
  if (!NewTask) throw new Error('Required product UI export missing: new-task.NewTask')
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
