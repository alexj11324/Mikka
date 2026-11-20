'use client'

import { useRef, useState } from 'react'
import { useTranslations } from '@/lib/intl/i18n-client'
import useSWR, { useSWRConfig } from 'swr'
import { toast } from 'sonner'
import { listDevices } from '@/app/actions/agents'
import { listBots } from '@/app/actions/bots'
import { issueCreationAvailable } from '@/app/actions/coordinator'
import { TASK_TITLE_MAX } from '@/lib/task-title-input'
import { useCoordinatorSubmit } from './use-coordinator-submit'
import type { TaskAgent } from '@/lib/task-create-command'
import { harnessName } from '@/components/labels/entity-labels'
import { TEXT_ATTACHMENT_ACCEPT, textAttachment } from '@/lib/text-attachment'
import { Alert, AlertTitle } from '@/components/ui/alert'
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
import { SetupChecklist } from './setup-checklist'
import { NewTask } from '@ui-slot/new-task'
import type { NewTaskMachine } from '@/components/slots/new-task-contract'
import { DEFAULT_MACHINE_SIZE, machineHourlyUsd } from '@/lib/cloud-computer/machine-pricing'
import { usePaywall } from '@/components/billing/paywall'

/** Hourly price of the default Cloudflare task machine, as shown beside it (decision 2026-11-15-1900). */
const DEFAULT_MACHINE_PRICE = machineHourlyUsd(DEFAULT_MACHINE_SIZE).toFixed(2)

const MAX_LENGTH = 8000

type Machine = PickerMachine & { label: string; status?: string }

/** A machine's icon with its state dot (`machineDot`), and the state in words for screen readers. */
function MachineIcon({ machine, cloudBotId }: { machine: Machine; cloudBotId: string | undefined }) {
  const t = useTranslations('Shell.newTaskDialog')
  const tStatus = useTranslations('Computer.status')
  const e2b = useTranslations('Settings.secrets.e2b')
  const { data: state } = useComputer(machine.cloud && machine.value!=='cloudflare' && machine.usable ? cloudBotId : null)
  const dot = machineDot(machine, state)
  if (machine.value==='cloudflare') return <DeviceIcon kind="cloud" state="online" label={t('sponsoredCloud', { price: DEFAULT_MACHINE_PRICE })} />
  if (machine.cloud) return <DeviceIcon kind="cloud" state={dot} label={!machine.usable ? `E2B API Key ${e2b('missing')}` : state ? tStatus(state.machine === 'error' ? 'failed' : state.machine) : t('cloud')} />
  return <DeviceIcon kind="personal" state={dot} label={machine.status ?? (machine.usable ? t('online') : t('offline'))} />
}

/** The existing task Start work dispatches. */
export type StartWorkTask = { id: string; identifier: string | null; title: string }

/**
 * Start work on a task that already exists (decision 2026-11-19-2110): 新建任务 only registers a task, and its work
 * starts here, from the task. The person picks the Bot to hand it to (the Coordinator by default), the Agent, the
 * machine and an Agent 配置, and may add a note; the request goes into that Bot's chat as an ordinary message naming
 * this task, and the Bot dispatches its thread (dispatch_run on the task's id). Nothing new is created. The window is
 * the new-task slot's dispatch form (`startWork` names the task), so a layer draws its pickers as before.
 */
export function StartWorkDialog({ open, onOpenChange, onSent, task, workspaceId, initialBotId }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The request was accepted; the page may open the Bot's chat. */
  onSent?: (botId: string | null) => void
  task: StartWorkTask
  workspaceId?: string
  /** The task's assigned Bot, picked first. */
  initialBotId?: string
}) {
  const t = useTranslations('Shell.newTaskDialog')
  const tShell = useTranslations('Shell')
  const tDevices = useTranslations('Devices')
  const locationT = useTranslations('Settings.modelOrder')
  const { submit: submitMessage, failureMessage } = useCoordinatorSubmit()
  const { mutate } = useSWRConfig()
  const pending = useRef(false)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [picked, setPicked] = useState<string | null>(null)
  // 交给哪个 Agent: the person picks one; nothing is preselected and the thread keeps it for life (decision 2026-11-17-1800).
  const [agent, setAgent] = useState<TaskAgent | null>(null)
  const profiles = useAgentProfiles(workspaceId, open, picked ? (picked === 'cloud' || picked === 'cloudflare') ? { location: 'cloud' } : { location: 'local', deviceId: picked } : undefined)
  const [profilePick, setProfilePick] = useState<{ workspaceId: string; id: string } | null>(null)
  const profileId = profilePick?.workspaceId === workspaceId ? profilePick?.id : undefined
  const profileAllowed = !profileId || (!profiles.error && taskProfileSelectable(profileId, profiles.data))
  const [coordinatorUnavailable, setCoordinatorUnavailable] = useState(false)
  const tCoordinator = useTranslations('Coordinator')
  const { data: available = true } = useSWR(open ? 'issue-creation-available' : null, () => issueCreationAvailable())

  const { data: devices = [] } = useSWR(open ? 'devices' : null, listDevices)
  const { data: placement } = useSWR(open ? ['settings:model-order', 'current'] : null, () => settingsRead<Awaited<ReturnType<typeof getModelOrder>>>('model-order'))
  const order = placement && !placement.error ? placement : undefined
  const { data: bots = [] } = useSWR(open ? 'bots' : null, listBots)
  // 交给: the Bot that starts the work. The Coordinator by default; a picked Bot gets the request in its own chat.
  const [botPick, setBotPick] = useState<string | null>(initialBotId ?? null)
  const botChoices = newTaskBotChoices(bots)
  const handler = botChoices.find(bot => bot.id === botPick) ?? null
  const paywall = usePaywall(botPick)
  // The work runs on Mikka Cloud on the computer of the Bot it goes to.
  const cloudBotId = handler?.id ?? (bots.find(bot => bot.coordinator) ?? bots[0])?.id
  const attachments = useChatFiles(draft, setDraft, cloudBotId ? { kind: 'bot', id: cloudBotId } : undefined, sending, tShell)
  // The menu's availability comes from the same dispatch planner as Settings. The default inherits
  // 运行位置 (会先用: the cloud, a server or a computer); only a destination the person explicitly picks becomes a fixed task destination.
  const e2bKey = useOwnE2BKey(open)
  const cloud: Machine = { value: 'cloud', label: t('cloud'), cloud: true, usable: e2bKey.configured !== false }
  const quotaUnchecked = order?.entries.some(entry => entry.block?.reason === 'checking')
  const own: Machine[] = devices.map(item => ({ value: item.id, label: item.name, usable: taskMachineUsable(item, order?.readyDeviceIds ?? []),
    status: !item.enabled ? t('notParticipating') : !item.online ? item.lastSeenAt ? t('offline') : tDevices('neverOnline') : !order ? t('loadingPlacement') : !order.readyDeviceIds.includes(item.id) ? quotaUnchecked ? t('quotaUnchecked') : t('modelUnavailable') : t('online') }))
  const sponsored: Machine[] = order?.sponsoredTasksAvailable ? [{value:'cloudflare',label:t('sponsoredCloud', { price: DEFAULT_MACHINE_PRICE }),cloud:true,usable:true}] : []
  const machines: Machine[] = [cloud, ...sponsored, ...own]
  const inherited = defaultTaskMachine(machines, order)
  const defaults: Machine = { value: 'auto', label: order ? `${t('workspaceDefault')} · ${inherited?.label ?? locationT(order.location)}` : t('workspaceDefault'),
    cloud: inherited?.cloud === true, usable: inherited?.usable ?? false, status: inherited?.status ?? (inherited?.usable ? t('online') : order ? quotaUnchecked ? t('quotaUnchecked') : t('modelUnavailable') : t('loadingPlacement')) }
  const device = machines.find(item => item.value === picked) ?? defaults
  // Picking Mikka Cloud without a key opens 填入 E2B Key; once saved, the work goes to the cloud.
  const [addingKey, setAddingKey] = useState(false)
  const keyDialog = usePresence(addingKey)
  function pick(value: string) {
    if (value === 'auto') { setPicked(null); return }
    if (value === cloud.value && !cloud.usable) { setAddingKey(true); return }
    setPicked(value)
  }

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

  const ready = available && profileAllowed && !!agent && (!botPick || !!handler) && !attachments.locked
  async function submit() {
    if (!ready || pending.current) return
    // Work on Mikka 额度 (its chat's model, or a Cloudflare machine) with nothing to pay opens 选择套餐 instead (decision 2026-11-15-1900).
    // Claim the submit before the paywall's balance read, so a second click cannot slip in while it runs.
    pending.current = true
    if (await paywall.blocked({ model: true, machine: picked === 'cloudflare' })) { pending.current = false; return }
    setSending(true)
    setCoordinatorUnavailable(false)
    try {
      const destination = pickedTaskDestination(picked)
      const context = [agent && t('contextAgent', { agent: harnessName(agent) }), destination && device && t('contextDevice', { device: device.label })].filter(Boolean).join(t('contextSeparator'))
      const note = draft.trim()
      const words = { task: task.identifier ?? task.id, title: task.title, id: task.id, context, note }
      const outcome = await submitMessage(note ? t('startWorkPromptWithNote', words) : t('startWorkPrompt', words), {
        taskDestination: destination, botId: handler?.id ?? null, profileId, expectedWorkspaceId: workspaceId })
      if (outcome.kind === 'rejected' && outcome.error === 'coordinatorUnavailable') { setCoordinatorUnavailable(true); return }
      if (outcome.kind !== 'accepted') { const message = failureMessage(outcome); if (message) toast.error(message); return }
      setDraft('')
      void mutate('coordinator-chat')
      toast.success(t('startWorkSent', { bot: handler?.name ?? 'Coordinator' }))
      onOpenChange(false)
      onSent?.(handler?.id ?? null)
    } catch {
      toast.error(t('failed'))
    } finally {
      pending.current = false
      setSending(false)
    }
  }

  const profileChoices = useTaskProfileChoices({ workspaceId, value: profileId ?? null, data: profiles.data })
  const keyDialogNode = keyDialog.value && <E2BKeyDialog open={keyDialog.open} onOpenChangeComplete={keyDialog.onOpenChangeComplete} configured={false} onClose={changed => { setAddingKey(false); if (changed) { void e2bKey.mutate(); setPicked(cloud.value) } }} />
  const TaskWindow = open ? NewTask : null
  if (open && !TaskWindow) throw new Error('Required product UI export missing: new-task.NewTask')
  const machineNote = (machine: Machine) => machine.cloud && !machine.usable ? t('addE2BKey') : !machine.cloud && !machine.usable ? machine.status : undefined
  const slotMachine = (machine: Machine, group: NewTaskMachine['group']): NewTaskMachine => ({ value: machine.value, label: machine.label, icon: <MachineIcon machine={machine} cloudBotId={cloudBotId} />, usable: machine.usable, note: machineNote(machine), group })
  const notices = <>
    <TaskProfileNotice value={profileId ?? null} data={profiles.data} error={profiles.error} onRetry={() => { void profiles.mutate() }} />
    {!available && <p className="text-sm text-muted-foreground">{t('unavailable')}</p>}
    {coordinatorUnavailable && <Alert variant="destructive"><AlertTitle>{tCoordinator('unavailable', { name: 'Coordinator' })}</AlertTitle></Alert>}
    <SetupChecklist workspaceId={workspaceId} />
  </>
  return <>
    {paywall.dialog}
    {TaskWindow && <TaskWindow onClose={() => onOpenChange(false)} startWork={{ identifier: task.identifier, title: task.title }}
      title={task.title} onTitle={() => {}} titleMax={TASK_TITLE_MAX} text={attachments.text} onText={attachments.edit} maxLength={MAX_LENGTH}
      files={attachments.files.length || attachments.pending.length ? <ChatFileCards files={attachments.files} pending={attachments.pending} onRemove={attachments.remove} onRetry={attachments.retry} /> : null}
      onAttach={files => { void attach(files) }} accept={cloudBotId ? CHAT_FILE_ACCEPT : TEXT_ATTACHMENT_ACCEPT}
      machines={[slotMachine(defaults, 'default'), slotMachine(cloud, 'cloud'), ...sponsored.map(item => slotMachine(item, 'cloud')), ...own.map(item => slotMachine(item, 'own'))]} machine={picked ?? 'auto'} onMachine={pick}
      bots={botChoices.length > 0 ? [{ id: null, name: 'Coordinator', avatar: <CoordinatorAvatar size="row" /> }, ...botChoices.map(bot => ({ id: bot.id, name: bot.name, avatar: <BotAvatar id={bot.id} color={bot.color} shape={bot.shape} size="row" /> }))] : []}
      bot={handler?.id ?? null} onBot={setBotPick}
      agent={{ value: agent, choices: (['claude_code', 'codex'] as const).map(value => ({ value, label: harnessName(value) })), onChange: setAgent, disabled: sending }}
      profile={{ ...profileChoices, value: profileId ?? 'auto', onChange: id => setProfilePick(id !== 'auto' && workspaceId ? { workspaceId, id } : null), disabled: sending || !workspaceId }}
      intent="create_and_dispatch" more={{ checked: false, onChange: () => {} }} notices={notices} sending={sending} canSubmit={ready} onSubmit={() => { void submit() }} />}
    {keyDialogNode}
  </>
}
