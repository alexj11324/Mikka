'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import useSWR, { useSWRConfig } from 'swr'
import { useLocale, useTranslations } from '@/lib/intl/i18n-client'
import { toast } from 'sonner'
import { ArrowLeft, Play } from '@/components/icons'
import { listDevices } from '@/app/actions/agents'
import { getWorkspaceBotDefaults, listBotsForWorkspace } from '@/app/actions/bots'
import { automationLinearLabels, automationLinearTeams, automationSlackChannels, deleteAutomation, createAutomation, pauseAutomation, resumeAutomation, runAutomationNow, takeOverAutomation, updateAutomation } from '@/app/actions/automations'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { FieldSet } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { InlineLoadError } from '@/components/load-error'
import { SettingRow, SettingsSection } from '@/components/settings/primitives'
import { useAgentProfiles } from '@/components/settings/factory-profiles-data'
import { useTaskProfileChoices } from '@/components/coordinator/task-profile-picker'
import { openTask } from '@/components/workspace/workspace-navigation'
import { invalidateAutomationList, useAutomation } from '@/hooks/use-automations'
import { cancelAutomationRun } from '@/app/actions/automations'
import { useActionError } from '@/lib/use-action-error'
import { newTaskBotChoices } from '@/lib/new-task-bot'
import { TASK_TITLE_MAX } from '@/lib/task-title-input'
import { runTask, type AutomationRun, type AutomationView } from '@/lib/schedules/automation-view'
import { definitionFrom, draftFrom, emptyDraft, foldNeeded, type AutomationDraft, type IntervalUnit, type ScheduleKind } from './automation-draft'
import { useWorkspaceBotNames } from './automations-page'
import { GitHubTriggers } from './github-triggers'
import { WebhookBatches } from './webhook-batches'
import { WebhookTrigger } from './webhook-trigger'
import { templateDraft, type AutomationTemplate } from './automation-templates'
import { LinearTriggers } from './linear-triggers'
import { SlackTriggers } from './slack-triggers'
import { AutomationUsagePanel } from './automation-usage'
import { useNextRunLabel, useTimingSummary } from './automation-summary'
import { harnessName } from '@/components/labels/entity-labels'

const zones = (() => { try { return Intl.supportedValuesOf('timeZone') } catch { return ['UTC'] } })()
const localZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' } }
const runVariant = { pending: 'outline', running: 'secondary', succeeded: 'secondary', failed: 'destructive', skipped: 'outline', cancelled: 'outline' } as const

/**
 * One automation, as Capy's automation editor lays it out (layout and interaction only): name, 启用 and 创建者; then
 * 设置, 满足任一条件就运行, 要它做什么, 限制 and 历史 as sections; 暂停 / 恢复 and 删除 at the end. A new one
 * (`id` 'new') is created on 创建 and opens as itself. Saves go through the automation actions and the page reads again
 * only when the live channel says the schedule changed.
 */
export function AutomationEditor({ workspaceId, userId, id, template, onOpen, onBack }: { workspaceId: string | null; userId: string; id: string | 'new'; template?: AutomationTemplate; onOpen: (id: string) => void; onBack: () => void }) {
  const t = useTranslations('Automations.editor')
  const locale = useLocale()
  const tAll = useTranslations('Automations')
  const tCommon = useTranslations('Common')
  const actionError = useActionError()
  const tErrors = useTranslations('Errors')
  const errorText = (code: string) => tErrors.has(code as never) ? tErrors(code as never) : code
  const creating = id === 'new'
  const { mutate: mutateCache } = useSWRConfig()
  const { automation, history } = useAutomation(workspaceId, creating ? null : id)
  const current = automation.data ?? null
  const tTemplates = useTranslations('Automations.templates')
  const [draft, setDraft] = useState<AutomationDraft | null>(() => !creating ? null
    : template ? templateDraft(template, emptyDraft(localZone()), { title: tTemplates(`${template}.title`), prompt: tTemplates(`${template}.prompt`) }) : emptyDraft(localZone()))
  const [baseline, setBaseline] = useState<{ version: number; draft: AutomationDraft } | null>(null)
  const dirty = Boolean(baseline && draft && JSON.stringify(draft) !== JSON.stringify(baseline.draft))
  // Keep editing the version the person actually opened until they save or choose the latest one.
  function loadDefinition(schedule: AutomationView) {
    const next = draftFrom(schedule.definition)
    setBaseline({ version: schedule.version, draft: next })
    setDraft(next)
  }
  useEffect(() => {
    if (current && !dirty && current.version !== baseline?.version) loadDefinition(current)
  }, [current, dirty, baseline?.version])
  const stale = Boolean(current && baseline && dirty && current.version !== baseline.version)
  const requestId = useRef(crypto.randomUUID())
  const pendingRun = useRef<{ scope: string; requestId: string } | null>(null)
  const [busy, setBusy] = useState<null | 'save' | 'toggle' | 'run' | 'delete' | 'takeOver'>(null)
  const [cancellingRun, setCancellingRun] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmTakeOver, setConfirmTakeOver] = useState(false)
  const set = (patch: Partial<AutomationDraft>) => setDraft(value => value ? { ...value, ...patch } : value)

  const { data: bots = [] } = useSWR(workspaceId ? ['bots', 'workspace', workspaceId] as const : null,
    ([, , shown]) => listBotsForWorkspace(shown), { revalidateOnFocus: false })
  const { data: devices = [], error: devicesError } = useSWR('devices', listDevices, { revalidateOnFocus: false })
  const workspaceBots = useWorkspaceBotNames(workspaceId)
  // The workspace's installed repositories, the ones a GitHub trigger may name (any member may read them).
  const { data: repositories = [] } = useSWR(workspaceId ? ['automation-repositories', workspaceId] as const : null, async ([, shown]) => {
    const result = await getWorkspaceBotDefaults(shown)
    return 'error' in result && result.error ? [] : (result as { repositories: string[] }).repositories
  }, { revalidateOnFocus: false })
  // Linear triggers' teams, read only once the person adds a Linear event or the automation has one.
  const [linearWanted, setLinearWanted] = useState(false)
  const linearTeams = useSWR(linearWanted || Boolean(draft?.linear.length) ? ['automation-linear-teams', userId] : null, async () => {
    const result = await automationLinearTeams()
    if ('error' in result && result.error) throw new Error(result.error)
    return result as { connected: boolean; teams: { id: string; key: string; name: string }[] }
  }, { revalidateOnFocus: false })
  const [labelsWanted, setLabelsWanted] = useState(false)
  const linearLabels = useSWR(labelsWanted && workspaceId && linearTeams.data?.connected ? ['automation-linear-labels', userId, workspaceId] as const : null, async ([, , shown]) => {
    const result = await automationLinearLabels(shown)
    if (result.error) throw new Error(result.error)
    return result.labels
  }, { revalidateOnFocus: false, shouldRetryOnError: false })
  // Slack triggers' channels, read only once the person adds a Slack event or the automation has one.
  const [slackWanted, setSlackWanted] = useState(false)
  const slackChannels = useSWR(workspaceId && (slackWanted || Boolean(draft?.slack.length) || Boolean(draft?.notify)) ? ['automation-slack-channels', workspaceId] as const : null, async ([, shown]) => {
    const result = await automationSlackChannels(shown)
    if ('error' in result && result.error) throw new Error(result.error)
    return result as { installed: boolean; channels: { id: string; name: string; private: boolean }[] }
  }, { revalidateOnFocus: false })
  const profiles = useAgentProfiles(workspaceId ?? undefined, true)
  const profileChoices = useTaskProfileChoices({ workspaceId: workspaceId ?? undefined, value: draft && draft.profileId !== 'auto' ? draft.profileId : null, data: profiles.data })
  const check = useMemo(() => draft ? definitionFrom(draft) : null, [draft])
  const needsFold = draft ? foldNeeded(draft) : false
  // The stored next run only describes the trigger as saved; an edited one says when it runs, not when it next will.
  const unchanged = useMemo(() => Boolean(current && check && JSON.stringify(definitionFrom(draftFrom(current.definition))) === JSON.stringify(check)), [current, check])
  const summary = useTimingSummary()
  const nextRun = useNextRunLabel()

  if (!creating && automation.error && !current) return <EditorFrame onBack={onBack} backLabel={t('back')}><InlineLoadError message={tAll('loadError')} retryLabel={tCommon('retry')} onRetry={() => { void automation.mutate() }} /></EditorFrame>
  if (!creating && automation.data === null) return <EditorFrame onBack={onBack} backLabel={t('back')}><p role="status" className="text-sm text-muted-foreground">{t('notFound')}</p></EditorFrame>
  if (!draft) return <EditorFrame onBack={onBack} backLabel={t('back')}><div role="status" aria-label={tAll('loading')} className="flex flex-col gap-3">{[0, 1, 2].map(index => <Skeleton key={index} className="h-24 w-full rounded-2xl" />)}</div></EditorFrame>

  const canManage = creating || current?.owner_id === userId || current?.can_take_over === true

  async function readAfterChange(schedule: AutomationView) {
    // The writer returns the schedule. A different creator's name and the reader's role come from the authorized view.
    if (schedule.owner_id !== userId) await automation.mutate()
    else await automation.mutate(schedule, { revalidate: false })
  }

  async function save() {
    if ((!creating && (!current || !baseline)) || !canManage || !workspaceId || !check || !('definition' in check) || busy || stale) return
    setBusy('save')
    try {
      const result = creating
        ? await createAutomation({ requestId: requestId.current, definition: check.definition }, workspaceId)
        : await updateAutomation({ scheduleId: current!.id, version: baseline!.version, definition: check.definition }, workspaceId ?? undefined)
      if ('error' in result && result.error) {
        toast.error(actionError(result.error))
        if (result.error === 'scheduleVersionConflict') await automation.mutate()
        return
      }
      const saved = (result as { schedule: AutomationView }).schedule
      toast.success(t('saved'))
      await invalidateAutomationList(mutateCache, workspaceId, false)
      if (creating) onOpen(saved.id)
      else { loadDefinition(saved); await readAfterChange(saved) }
    } finally { setBusy(null) }
  }
  async function toggle(on: boolean) {
    if (!current || !workspaceId || busy || (on && !canManage)) return
    setBusy('toggle')
    try {
      const result = await (on ? resumeAutomation : pauseAutomation)({ scheduleId: current.id, version: current.version }, workspaceId ?? undefined)
      if ('error' in result && result.error) { toast.error(actionError(result.error)); return }
      await readAfterChange((result as { schedule: AutomationView }).schedule)
      await invalidateAutomationList(mutateCache, workspaceId, false)
    } finally { setBusy(null) }
  }
  async function runNow() {
    if (!current || !canManage || busy) return
    setBusy('run')
    try {
      const scope = JSON.stringify([userId, workspaceId, current.id, current.version])
      if (pendingRun.current?.scope !== scope) pendingRun.current = { scope, requestId: crypto.randomUUID() }
      let result: Awaited<ReturnType<typeof runAutomationNow>>
      try {
        result = await runAutomationNow({ scheduleId: current.id, version: current.version, requestId: pendingRun.current.requestId }, workspaceId ?? undefined)
      } catch {
        // The server may already have recorded this run. Retry that same request until it answers.
        toast.error(t('runUnconfirmed'))
        return
      }
      pendingRun.current = null
      if ('error' in result && result.error) { toast.error(actionError(result.error)); return }
      toast.success(t('started'))
      await history.mutate()
    } finally { setBusy(null) }
  }
  async function cancelRun(runId: string) {
    if (!current || cancellingRun) return
    setCancellingRun(runId)
    try {
      const result = await cancelAutomationRun({ scheduleId: current.id, version: current.version, runId }, workspaceId ?? undefined)
      if ('error' in result && result.error) toast.error(actionError(result.error))
      await history.mutate()
    } catch { toast.error(actionError('generic')) }
    finally { setCancellingRun(null) }
  }
  async function takeOver() {
    if (!current || busy) return
    setBusy('takeOver')
    try {
      const result = await takeOverAutomation({ scheduleId: current.id, version: current.version }, workspaceId ?? undefined)
      if ('error' in result && result.error) { toast.error(actionError(result.error)); return }
      setConfirmTakeOver(false)
      toast.success(t('tookOver'))
      await automation.mutate({ ...(result as { schedule: AutomationView }).schedule, owner_name: null, can_take_over: false }, { revalidate: false })
    } finally { setBusy(null) }
  }
  async function remove() {
    if (!current || !workspaceId || busy) return
    setBusy('delete')
    try {
      const result = await deleteAutomation({ scheduleId: current.id, version: current.version }, workspaceId)
      if ('error' in result && result.error) { toast.error(actionError(result.error)); return }
      await Promise.all([invalidateAutomationList(mutateCache, workspaceId, false), invalidateAutomationList(mutateCache, workspaceId, true)])
      setConfirmDelete(false)
      onBack()
    } finally { setBusy(null) }
  }

  const ownBots = newTaskBotChoices(bots)
  const otherBot = draft.botId && !ownBots.some(bot => bot.id === draft.botId) ? workspaceBots.get(draft.botId) : null
  const localDevices = devices.filter(device => device.enabled || device.id === draft.machine)
  const active = current?.status === 'active'
  const canToggle = current?.status !== 'completed' && (active || canManage)
  const canSave = canManage && !stale && Boolean(workspaceId && check && 'definition' in check) && !busy
  const creator = !current || current.owner_id === userId ? t('you') : current.owner_name ?? ''
  const field = (label: string, control: React.ReactNode) => <SettingRow title={label}><div className="flex flex-wrap items-center justify-end gap-2">{control}</div></SettingRow>

  return <EditorFrame onBack={onBack} backLabel={t('back')}>
    <header className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <Input aria-label={t('name')} value={draft.title} readOnly={!canManage} maxLength={200} placeholder={t('namePlaceholder')} onChange={event => set({ title: event.target.value })}
          className="h-auto min-w-0 flex-1 border-0 bg-transparent px-0 text-xl font-semibold shadow-none focus-visible:ring-0 md:text-xl dark:bg-transparent" />
        {!creating && <div className="flex shrink-0 items-center gap-2 pt-1.5">
          <Label htmlFor="automation-enabled">{t('enabled')}</Label>
          <Switch id="automation-enabled" checked={active} disabled={busy !== null || !canToggle} onCheckedChange={on => { void toggle(on) }} />
        </div>}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <span>{t('creator')} · {creator}</span>
        {current?.can_take_over && <Button size="xs" variant="outline" disabled={busy !== null} onClick={() => setConfirmTakeOver(true)}>{t('takeOver')}</Button>}
        {current && <Badge variant={current.status === 'active' ? 'secondary' : 'outline'}>{tAll(`status.${current.status}`)}</Badge>}
        {current?.status === 'paused' && current.disabled_reason && <span role="status" className="text-destructive-foreground">{t('autoPaused', { reason: errorText(current.disabled_reason) })}</span>}
      </div>
    </header>

    {/* Every control below is disabled for a non-owner, so the reason is said once, here, rather than
        left to a grey field that never explains itself. */}
    {!canManage && <p role="status" className="px-6 pt-1 text-sm text-muted-foreground">{t('viewOnly')}</p>}

    <FieldSet disabled={!canManage} className="contents">
    {!draft.otherTask && <SettingsSection id="automation-settings" title={t('settings')}>
      {field(t('bot'), <NativeSelect aria-label={t('bot')} value={draft.botId ?? ''} onChange={event => set({ botId: event.target.value || null })}>
        <NativeSelectOption value="">{tAll('coordinator')}</NativeSelectOption>
        {ownBots.map(bot => <NativeSelectOption key={bot.id} value={bot.id}>{bot.name}</NativeSelectOption>)}
        {otherBot && <NativeSelectOption value={otherBot.id}>{otherBot.name}</NativeSelectOption>}
      </NativeSelect>)}
      {field(t('machine'), <NativeSelect aria-label={t('machine')} value={draft.machine} onChange={event => set({ machine: event.target.value })}>
        <NativeSelectOption value="auto">{t('machineDefault')}</NativeSelectOption>
        <NativeSelectOption value="cloud">{t('machineCloud')}</NativeSelectOption>
        {draft.machine === 'cloudflare' && <NativeSelectOption value="cloudflare">{t('machineCloud')}</NativeSelectOption>}
        {localDevices.map(device => <NativeSelectOption key={device.id} value={device.id}>{device.name}</NativeSelectOption>)}
        {/* A failed read leaves the list empty; without this the only machine
            choices are the two defaults, with nothing saying why the person's
            own devices are missing. */}
        {devicesError && <NativeSelectOption value="" disabled>{t('devicesError')}</NativeSelectOption>}
      </NativeSelect>)}
      {field(t('agent'), <NativeSelect aria-label={t('agent')} value={draft.agent ?? ''} onChange={event => set({ agent: event.target.value === 'claude_code' || event.target.value === 'codex' ? event.target.value : null })}>
        <NativeSelectOption value="" disabled>{t('agentNone')}</NativeSelectOption>
        <NativeSelectOption value="claude_code">{harnessName('claude_code')}</NativeSelectOption>
        <NativeSelectOption value="codex">{harnessName('codex')}</NativeSelectOption>
      </NativeSelect>)}
      {field(t('profile'), <NativeSelect aria-label={t('profile')} value={draft.profileId} disabled={!workspaceId} onChange={event => set({ profileId: event.target.value })}>
        {profileChoices.choices.map(choice => <NativeSelectOption key={choice.value} value={choice.value} disabled={'disabled' in choice && choice.disabled}>{choice.label}</NativeSelectOption>)}
      </NativeSelect>)}
      {field(t('eachRun'), <NativeSelect aria-label={t('eachRun')} value={draft.eachRun} onChange={event => set({ eachRun: event.target.value === 'same_task' ? 'same_task' : 'new_task' })}>
        <NativeSelectOption value="new_task">{t('eachRunNew')}</NativeSelectOption>
        <NativeSelectOption value="same_task">{t('eachRunSame')}</NativeSelectOption>
      </NativeSelect>)}
      {field(t('notify'), slackWanted || draft.notify
        ? <NativeSelect aria-label={t('notify')} value={draft.notify?.channel ?? ''} disabled={!slackChannels.data && !draft.notify}
          onChange={event => set({ notify: event.target.value ? { channel: event.target.value, locale: locale === 'en' ? 'en' : 'zh-CN' } : null })}>
          <NativeSelectOption value="">{t('notifyOff')}</NativeSelectOption>
          {draft.notify && !slackChannels.data?.channels.some(channel => channel.id === draft.notify!.channel) && <NativeSelectOption value={draft.notify.channel}>{draft.notify.channel}</NativeSelectOption>}
          {(slackChannels.data?.channels ?? []).map(channel => <NativeSelectOption key={channel.id} value={channel.id}>#{channel.name}</NativeSelectOption>)}
        </NativeSelect>
        : <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => setSlackWanted(true)}>{t('notifyChoose')}</Button>)}
      {field(t('timezone'), <NativeSelect aria-label={t('timezone')} value={draft.timezone} onChange={event => set({ timezone: event.target.value, fold: null })}>
        {(zones.includes(draft.timezone) ? zones : [draft.timezone, ...zones]).map(zone => <NativeSelectOption key={zone} value={zone}>{zone}</NativeSelectOption>)}
      </NativeSelect>)}
    </SettingsSection>}

    <SettingsSection id="automation-triggers" title={t('triggers')}>
      <SettingRow title={t('schedule')}>
        <Switch aria-label={t('schedule')} checked={draft.scheduleOn} onCheckedChange={on => set({ scheduleOn: on })} />
      </SettingRow>
      {draft.scheduleOn && <div className="flex flex-col gap-3 px-5 pt-1 pb-4">
        <ToggleGroup aria-label={t('schedule')} size="sm" variant="segment" spacing={0.5} value={[draft.scheduleKind]}
          onValueChange={values => { const next = values[0] as ScheduleKind | undefined; if (next) set({ scheduleKind: next }) }}>
          {(['once', 'interval', 'daily', 'cron'] as const).map(kind => <ToggleGroupItem key={kind} value={kind}>{t(`scheduleKind.${kind}`)}</ToggleGroupItem>)}
        </ToggleGroup>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {draft.scheduleKind === 'once' && <Input type="datetime-local" aria-label={t('at')} className="w-auto" value={draft.onceAt} onChange={event => set({ onceAt: event.target.value })} />}
          {draft.scheduleKind === 'interval' && <>
            <span className="text-muted-foreground">{t('start')}</span>
            <Input type="datetime-local" aria-label={t('start')} className="w-auto" value={draft.intervalStart} onChange={event => set({ intervalStart: event.target.value })} />
            <span className="text-muted-foreground">{t('every')}</span>
            <Input type="number" min={1} aria-label={t('every')} className="w-20" value={draft.intervalValue} onChange={event => set({ intervalValue: Number(event.target.value) })} />
            <NativeSelect aria-label={t('every')} value={draft.intervalUnit} onChange={event => set({ intervalUnit: event.target.value as IntervalUnit })}>
              {(['minutes', 'hours', 'days'] as const).map(unit => <NativeSelectOption key={unit} value={unit}>{t(`unit.${unit}`)}</NativeSelectOption>)}
            </NativeSelect>
          </>}
          {draft.scheduleKind === 'daily' && <Input type="time" aria-label={t('at')} className="w-auto" value={draft.dailyTime} onChange={event => set({ dailyTime: event.target.value, fold: null })} />}
          {draft.scheduleKind === 'cron' && <Input aria-label={t('expression')} className="w-48 font-mono" value={draft.cron} maxLength={100} onChange={event => set({ cron: event.target.value })} />}
        </div>
        {check && 'definition' in check && <p className="text-sm text-muted-foreground">
          {summary(check.definition)}{current?.status === 'active' && current.next_at && unchanged && <> · {tAll('nextRun', { time: nextRun(current.next_at, current.definition.timezone) })}</>}
        </p>}
        {needsFold && <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>{t('fold', { time: draft.dailyTime })}</span>
          <ToggleGroup aria-label={t('fold')} size="sm" variant="segment" spacing={0.5} value={draft.fold ? [draft.fold] : []}
            onValueChange={values => { const next = values[0]; if (next === 'earlier' || next === 'later') set({ fold: next }) }}>
            <ToggleGroupItem value="earlier">{t('foldEarlier')}</ToggleGroupItem>
            <ToggleGroupItem value="later">{t('foldLater')}</ToggleGroupItem>
          </ToggleGroup>
        </div>}
      </div>}
      {!draft.otherTask && <>
        <SettingRow title={t('github.title')} />
        <GitHubTriggers workspaceId={workspaceId} userId={userId} value={draft.github} repositories={repositories} disabled={busy !== null} onChange={github => set({ github })} />
        <SettingRow title={t('linear.title')}>
          {!linearWanted && !draft.linear.length && <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => setLinearWanted(true)}>{t('linear.show')}</Button>}
        </SettingRow>
        {(linearWanted || draft.linear.length > 0) && <>
          {linearTeams.error && <div className="px-5 pb-2"><InlineLoadError message={t('linear.teamsError')} retryLabel={tCommon('retry')} onRetry={() => { void linearTeams.mutate() }} /></div>}
          {linearLabels.error && <div className="px-5 pb-2"><InlineLoadError message={t('linear.labelsError')} retryLabel={tCommon('retry')} onRetry={() => { void linearLabels.mutate() }} /></div>}
          <LinearTriggers labels={linearLabels.data ?? []} onEditLabels={() => setLabelsWanted(true)} value={draft.linear} teams={linearTeams.data?.teams ?? []} connected={linearTeams.data?.connected ?? true} disabled={busy !== null || (!linearTeams.data && !linearTeams.error)} onChange={linear => set({ linear })} />
        </>}
        <SettingRow title={t('slack.title')}>
          {!slackWanted && !draft.slack.length && <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => setSlackWanted(true)}>{t('slack.show')}</Button>}
        </SettingRow>
        {(slackWanted || draft.slack.length > 0) && <>
          {slackChannels.error && <div className="px-5 pb-2"><InlineLoadError message={t('slack.channelsError')} retryLabel={tCommon('retry')} onRetry={() => { void slackChannels.mutate() }} /></div>}
          <SlackTriggers workspaceId={workspaceId} userId={userId} value={draft.slack} channels={slackChannels.data?.channels ?? []} installed={slackChannels.data?.installed ?? true} disabled={busy !== null || (!slackChannels.data && !slackChannels.error)} onChange={slack => set({ slack })} />
        </>}
        <WebhookTrigger value={draft.webhook} onChange={webhook => set({ webhook })} automation={current ?? null} disabled={busy !== null}
          onSaved={readAfterChange} />
      </>}
      <SettingRow title={t('manual')}>
        {!creating && <Button size="sm" variant="secondary" disabled={!active || busy !== null} onClick={() => { void runNow() }}><Play data-icon="inline-start" />{t('runNow')}</Button>}
      </SettingRow>
    </SettingsSection>

    <SettingsSection id="automation-task" title={t('task')}>
      {draft.otherTask ? <SettingRow title={tAll(`kind.${draft.otherTask.kind}`)} description={'text' in draft.otherTask ? draft.otherTask.text : 'prompt' in draft.otherTask ? draft.otherTask.prompt : undefined} />
        : <div className="flex flex-col gap-3 p-4">
          <Textarea aria-label={t('prompt')} value={draft.prompt} maxLength={8000} rows={4} placeholder={t('promptPlaceholder')} onChange={event => set({ prompt: event.target.value })} />
          <Input aria-label={t('taskTitle')} value={draft.taskTitle} maxLength={TASK_TITLE_MAX} placeholder={t('taskTitlePlaceholder')} onChange={event => set({ taskTitle: event.target.value })} />
        </div>}
    </SettingsSection>

    <SettingsSection id="automation-limits" title={t('limits')}>
      {field(t('misfire'), <NativeSelect aria-label={t('misfire')} value={draft.misfire} onChange={event => set({ misfire: event.target.value as AutomationDraft['misfire'] })}>
        <NativeSelectOption value="skip">{t('misfireSkip')}</NativeSelectOption>
        <NativeSelectOption value="catch_up_once">{t('misfireCatchUp')}</NativeSelectOption>
      </NativeSelect>)}
      {field(t('lateness'), <><Input type="number" min={1} max={10080} aria-label={t('lateness')} className="w-24" value={draft.lateness} onChange={event => set({ lateness: Number(event.target.value) })} /><span className="text-muted-foreground">{t('minutes')}</span></>)}
      {field(t('concurrent'), <NativeSelect aria-label={t('concurrent')} value={String(draft.concurrent)} onChange={event => set({ concurrent: Number(event.target.value) })}>
        {[1, 2, 3, 4, 5].map(count => <NativeSelectOption key={count} value={String(count)}>{count}</NativeSelectOption>)}
      </NativeSelect>)}
      {field(t('perDay'), <NativeSelect aria-label={t('perDay')} value={String(draft.perDay)} onChange={event => set({ perDay: Number(event.target.value) })}>
        <NativeSelectOption value="0">{t('unlimited')}</NativeSelectOption>
        {[...new Set([1, 2, 3, 5, 10, 20, 50, 100, draft.perDay])].filter(count => count > 0).sort((a, b) => a - b).map(count => <NativeSelectOption key={count} value={String(count)}>{count}</NativeSelectOption>)}
      </NativeSelect>)}
    </SettingsSection>

    </FieldSet>

    {!creating && current && <AutomationUsagePanel workspaceId={workspaceId} id={current.id} />}

    {workspaceId && current && (current.definition.webhook || current.webhook_key_set) && (current.owner_id === userId || current.can_take_over) &&
      <WebhookBatches key={current.id} workspaceId={workspaceId} automation={current} />}

    {!creating && <SettingsSection id="automation-history" title={t('history')}>
      {history.error && !history.data ? <div className="p-4"><InlineLoadError message={tAll('loadError')} retryLabel={tCommon('retry')} onRetry={() => { void history.mutate() }} /></div>
        : !history.data ? <div className="p-4"><Skeleton className="h-10 w-full" /></div>
          : !history.data.occurrences.length ? <p className="px-5 py-4 text-sm text-muted-foreground">{t('historyEmpty')}</p>
            : history.data.occurrences.map(run => <RunRow key={run.id} run={run} timezone={current?.definition.timezone ?? draft.timezone}
              onCancel={current && run.can_cancel ? () => { void cancelRun(run.id) } : undefined}
              cancelling={cancellingRun !== null} />)}
    </SettingsSection>}

    {stale && current && <InlineLoadError message={actionError('scheduleVersionConflict')} retryLabel={t('loadSavedVersion')}
      onRetry={() => loadDefinition(current)} />}
    <footer className="flex flex-wrap items-center justify-between gap-2 pb-8">
      <div className="flex items-center gap-2">
        {current && current.status !== 'completed' && <Button variant="outline" disabled={busy !== null || !canToggle} onClick={() => { void toggle(!active) }}>{active ? t('pause') : t('resume')}</Button>}
        {current && <Button variant="ghost" className="text-destructive-foreground" disabled={busy !== null} onClick={() => setConfirmDelete(true)}>{t('delete')}</Button>}
      </div>
      <div className="flex items-center gap-3">
        {check && 'missing' in check && <span role="status" className="text-sm text-muted-foreground">{t(`missing.${check.missing}`)}</span>}
        <Button disabled={!canSave} onClick={() => { void save() }}>{busy === 'save' ? t('saving') : creating ? t('create') : t('save')}</Button>
      </div>
    </footer>

    <AlertDialog open={confirmDelete} onOpenChange={open => { if (!busy) setConfirmDelete(open) }}>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>{t('deleteTitle')}</AlertDialogTitle><AlertDialogDescription>{t('deleteBody')}</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel disabled={busy === 'delete'}>{t('cancel')}</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={busy === 'delete'} onClick={() => { void remove() }}>{t('delete')}</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    <AlertDialog open={confirmTakeOver} onOpenChange={open => { if (!busy) setConfirmTakeOver(open) }}>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>{t('takeOverTitle')}</AlertDialogTitle><AlertDialogDescription>{t('takeOverBody', { name: creator })}</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel disabled={busy === 'takeOver'}>{t('cancel')}</AlertDialogCancel><AlertDialogAction variant="default" disabled={busy === 'takeOver'} onClick={() => { void takeOver() }}>{t('takeOver')}</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </EditorFrame>
}

function EditorFrame({ children, onBack, backLabel }: { children: React.ReactNode; onBack: () => void; backLabel: string }) {
  return <section aria-label={backLabel} className="flex min-h-0 flex-1 flex-col overflow-auto">
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
      <div><Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft data-icon="inline-start" />{backLabel}</Button></div>
      {children}
    </div>
  </section>
}

/** One run: when, how it ended (and why when it did not), and the task it made as a chip that opens it. */
function RunRow({ run, timezone, onCancel, cancelling }: { run: AutomationRun; timezone: string; onCancel?: () => void; cancelling: boolean }) {
  const t = useTranslations('Automations')
  const tEvent = useTranslations('Automations.githubEvent')
  const tLinear = useTranslations('Automations.linearEvent')
  const tSlack = useTranslations('Automations.slackEvent')
  const tErrors = useTranslations('Errors')
  // On the automation's own clock, like its summary, next run and usage days.
  const when = useNextRunLabel()
  const task = runTask(run)
  const at = run.started_at ?? run.due_at
  const reason = run.error ? (t.has(`runErrors.${run.error}` as never) ? t(`runErrors.${run.error}` as never) : tErrors.has(run.error as never) ? tErrors(run.error as never) : run.error) : null
  // control-size-exempt: a run's own line — time, badge and one small cancel; not a toolbar of controls.
  return <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 text-sm">
    <time className="tabular-nums text-muted-foreground" dateTime={new Date(at).toISOString()}>{when(at, timezone)}</time>
    <Badge variant={runVariant[run.status]}>{t(`run.${run.status}`)}</Badge>
    {onCancel && <Button size="sm" variant="outline" disabled={cancelling} onClick={onCancel}>{t('cancelRun')}</Button>}
    {run.trigger && 'event' in run.trigger && run.trigger.event.source === 'linear' && <span className="min-w-0 text-muted-foreground">{t('run.from', { event: tLinear.has(run.trigger.event.event as never) ? tLinear(run.trigger.event.event as never) : run.trigger.event.event,
      what: run.trigger.event.identifier ?? run.trigger.event.title ?? '' })}</span>}
    {run.trigger && 'event' in run.trigger && run.trigger.event.source === 'slack' && <span className="min-w-0 text-muted-foreground">{t('run.from', { event: tSlack.has(run.trigger.event.event as never) ? tSlack(run.trigger.event.event as never) : run.trigger.event.event,
      what: run.trigger.event.reaction ? `${run.trigger.event.channel} :${run.trigger.event.reaction}:` : run.trigger.event.channel })}</span>}
    {run.trigger && 'event' in run.trigger && run.trigger.event.source !== 'linear' && run.trigger.event.source !== 'slack' && <span className="min-w-0 text-muted-foreground">{t('run.from', { event: tEvent.has(run.trigger.event.event as never) ? tEvent(run.trigger.event.event as never) : run.trigger.event.event,
      what: run.trigger.event.number !== null ? `${run.trigger.event.repository.replace(/^v2\/github\.com\//, '')}#${run.trigger.event.number}` : run.trigger.event.repository.replace(/^v2\/github\.com\//, '') })}</span>}
    {run.trigger && 'webhook' in run.trigger && <span className="min-w-0 text-muted-foreground">{t('run.fromWebhook', { count: run.trigger.webhook.requests.length })}</span>}
    {task && <Button size="xs" variant="secondary" title={task.title} onClick={() => openTask(task.id)}><bdi>{task.identifier ?? task.title}</bdi></Button>}
    {reason && <span className="min-w-0 text-muted-foreground">{reason}</span>}
  </div>
}
