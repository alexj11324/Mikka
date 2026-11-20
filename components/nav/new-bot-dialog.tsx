'use client'
import { isBotListKey } from '@/lib/live/list-read'

import { useEffect, useState } from 'react'
import useSWR, { useSWRConfig } from 'swr'
import { toast } from 'sonner'
import { useTranslations } from '@/lib/intl/i18n-client'
import { createBot, getWorkspaceBotDefaults, listBotEnvironments, setBotEffort, type BotView } from '@/app/actions/bots'
import { listDevices } from '@/app/actions/agents'
import { MODEL_ROUTING_EFFORTS } from '@/lib/model-routing'
import type { TaskDestination } from '@/lib/task-destination'
import { chooseBotModel, getBotModelMenu } from '@/app/actions/execution-settings'
import { botModelMenuKey, modelGroupHeading, modelGroupTag, modelPriceTag } from '@/hooks/use-bot-model-picker'
import type { BotModelMenu } from '@/lib/bot-model-menu-view'
import { modelDisplayName } from '@/lib/model-display-name'
import { useActionError } from '@/lib/use-action-error'
import { DEFAULT_BOT_COLOR, DEFAULT_BOT_SHAPE, type BotColor, type BotShape } from './bot-avatar'
import { NO_EFFORT, NO_REPOSITORY, type NewBotChoice, type NewBotDetail } from '@/components/slots/new-bot-contract'
import { NewBot } from '@ui-slot/new-bot'

const NAME_LENGTH = 60

/**
 * 新建 Bot, with Capy's new Captain details beside the look: the model its runs use and the repository it works in.
 * The model menu is the one the Coordinator's chip reads (the same person, the same choices); a pick is saved on the
 * new Bot after it exists. The repository starts at the workspace's default and is checked again by createBot.
 */
export function NewBotDialog({ open, onOpenChange, onCreated, workspaceId }: { open: boolean; workspaceId?: string; onOpenChange: (open: boolean) => void; onCreated: (bot: BotView) => void }) {
  const actionError = useActionError()
  const t = useTranslations('Shell.newBot')
  const tModel = useTranslations('Coordinator.modelPicker')
  const { mutate } = useSWRConfig()
  const [name, setName] = useState('')
  const [color, setColor] = useState<BotColor>(DEFAULT_BOT_COLOR)
  const [shape, setShape] = useState<BotShape>(DEFAULT_BOT_SHAPE)
  // Undefined until the person picks: the Bot then takes what it would get anyway.
  const [model, setModel] = useState<string | undefined>()
  const [repository, setRepository] = useState<string | undefined>()
  const [environment, setEnvironment] = useState<string | undefined>()
  const [machine, setMachine] = useState<string | undefined>()
  const [effort, setEffort] = useState<string>(NO_EFFORT)
  const [access, setAccess] = useState<'private' | 'shared'>('private')
  const [saving, setSaving] = useState(false)
  useEffect(() => { if (!open) { setName(''); setColor(DEFAULT_BOT_COLOR); setShape(DEFAULT_BOT_SHAPE); setModel(undefined); setRepository(undefined); setEnvironment(undefined); setMachine(undefined); setEffort(NO_EFFORT); setAccess('private') } }, [open])

  // Read once when the window opens; nothing here refreshes on its own.
  const menu = useSWR<BotModelMenu | null>(open ? [...botModelMenuKey(null), workspaceId] : null, () => getBotModelMenu(null, workspaceId), { shouldRetryOnError: false, revalidateOnFocus: false })
  const defaults = useSWR(open ? ['new-bot-defaults', workspaceId] : null, async () => {
    const result = await getWorkspaceBotDefaults(workspaceId)
    if (result.error) throw new Error(result.error)
    return result
  }, { shouldRetryOnError: false, revalidateOnFocus: false })

  const environments = useSWR(open ? ['new-bot-environments', workspaceId] : null, async () => {
    const result = await listBotEnvironments(workspaceId)
    if (result.error) throw new Error(result.error)
    return result.environments
  }, { shouldRetryOnError: false, revalidateOnFocus: false })
  const { data: devices = [] } = useSWR(open ? 'devices' : null, listDevices, { shouldRetryOnError: false, revalidateOnFocus: false })

  const modelChoices: NewBotChoice[] = (menu.data?.groups ?? []).flatMap(group => {
    const source = modelGroupHeading(tModel, group)
    const tag = modelGroupTag(tModel, group) ?? undefined
    // Mikka 额度 offers its featured models here; the chat's picker searches the whole catalogue.
    return group.options.filter(option => group.kind !== 'hosted' || option.featured).map(option => ({
      value: option.id,
      label: option.name || (option.modelId ? modelDisplayName(option.modelId).name : tModel('unknownModel')),
      detail: modelPriceTag(option) ?? tag, group: source,
    }))
  })
  const modelValue = model ?? (menu.data?.current?.id || null)
  const modelDetail: NewBotDetail = {
    choices: modelChoices, value: modelValue,
    label: modelChoices.find(choice => choice.value === modelValue)?.label ?? (menu.error ? tModel('unavailable') : t('loading')),
    onChange: setModel, disabled: saving || modelChoices.length === 0,
  }

  const repositories = defaults.data?.repositories ?? []
  const repositoryValue = repository ?? (defaults.data ? defaults.data.defaultRepository ?? NO_REPOSITORY : null)
  const repositoryChoices: NewBotChoice[] = [{ value: NO_REPOSITORY, label: t('noRepository') }, ...repositories.map(item => ({ value: item, label: item }))]
  const repositoryDetail: NewBotDetail = {
    choices: repositoryChoices, value: repositoryValue,
    // A failed read leaves the choice to createBot (the workspace's default); the row says it could not load, never 不用仓库.
    label: repositoryValue === null ? (defaults.error ? tModel('unavailable') : t('loading')) : repositoryValue === NO_REPOSITORY ? t('noRepository') : repositoryValue,
    onChange: setRepository, disabled: saving || !defaults.data,
  }

  // Environment: undefined keeps the server's pick (the one listing the 仓库 choice, else the workspace default, the first here).
  const environmentChoices: NewBotChoice[] = (environments.data ?? []).map(item => ({ value: item.id, label: item.name, detail: item.repositoryKeys[0]?.replace(/^v2\/github\.com\//, '') }))
  const environmentValue = environment ?? environmentChoices[0]?.value ?? null
  const environmentDetail: NewBotDetail = {
    choices: environmentChoices, value: environmentValue,
    label: environmentChoices.find(choice => choice.value === environmentValue)?.label ?? (environments.error ? tModel('unavailable') : environments.data ? t('noEnvironment') : t('loading')),
    onChange: setEnvironment, disabled: saving || environmentChoices.length === 0,
  }
  // Machine: where the tasks it dispatches run. Unpicked, the person's own 运行位置 decides.
  const machineChoices: NewBotChoice[] = [
    { value: 'cloud', label: t('machineCloud') },
    { value: 'cloudflare', label: t('machineCloudflare') },
    ...devices.filter(item => item.enabled).map(item => ({ value: item.id, label: item.name, group: t('otherDevices') })),
  ]
  const machineDetail: NewBotDetail = {
    choices: machineChoices, value: machine ?? null,
    label: machineChoices.find(choice => choice.value === machine)?.label ?? t('machine'),
    onChange: setMachine, disabled: saving,
  }
  const effortChoices: NewBotChoice[] = [{ value: NO_EFFORT, label: t('effortDefault') }, ...MODEL_ROUTING_EFFORTS.map(value => ({ value, label: value }))]
  const effortDetail: NewBotDetail = {
    choices: effortChoices, value: effort, label: effortChoices.find(choice => choice.value === effort)?.label ?? t('effortDefault'),
    onChange: setEffort, disabled: saving,
  }
  const accessChoices: NewBotChoice[] = [{ value: 'private', label: t('accessPrivate') }, { value: 'shared', label: t('accessShared') }]
  const accessDetail: NewBotDetail = {
    choices: accessChoices, value: access, label: accessChoices.find(choice => choice.value === access)!.label,
    onChange: value => setAccess(value === 'shared' ? 'shared' : 'private'), disabled: saving,
  }
  const crewTarget: TaskDestination | undefined = machine === undefined ? undefined
    : machine === 'cloud' ? { kind: 'cloud' } : machine === 'cloudflare' ? { kind: 'cloud', provider: 'cloudflare' } : { kind: 'device', deviceId: machine }

  async function submit() {
    const trimmed = name.trim()
    if (!trimmed || saving) return
    setSaving(true)
    try {
      const bot = await createBot({ name: trimmed, color, shape, ...(repository === undefined ? {} : { repository: repository === NO_REPOSITORY ? null : repository }),
        ...(environment === undefined ? {} : { environmentId: environment }), ...(crewTarget ? { crewTarget } : {}), ...(access === 'shared' ? { visibility: access } : {}) }, workspaceId)
      if (effort !== NO_EFFORT) {
        const saved = await setBotEffort(bot.id, effort, workspaceId).catch(() => ({ error: 'notSaved' }))
        if (saved.error) toast.error(tModel('notSaved'))
      }
      // The menu is the Coordinator's: its row shows the Coordinator's model. A new Bot has no saved choice and would
      // follow the default instead, so save what the row shows whenever it is a pick (the person's, or the Coordinator's
      // own choice); an unchosen default is what the new Bot resolves to anyway.
      const shown = model ?? (menu.data?.current?.chosen ? menu.data.current.id : undefined)
      if (shown !== undefined) {
        // The Bot exists either way; a model that did not save stays the default and says so.
        const saved = await chooseBotModel(bot.id, shown).catch(() => ({ error: 'notSaved' }))
        if (saved.error) toast.error(tModel('notSaved'))
      }
      await mutate(isBotListKey)
      onCreated(bot)
    } catch (error) {
      // Server actions keep the failure code as the message (botDuplicateName…).
      toast.error(actionError(error instanceof Error ? error.message : null))
    } finally {
      setSaving(false)
    }
  }

  return open ? <NewBot onClose={() => onOpenChange(false)} name={name} onName={setName} maxLength={NAME_LENGTH} color={color} shape={shape}
    onColor={setColor} onShape={setShape} model={modelDetail} repository={repositoryDetail}
    environment={environmentDetail} machine={machineDetail} effort={effortDetail} access={accessDetail} saving={saving} onSubmit={() => { void submit() }} /> : null
}
