'use client'

import { useState, type ReactNode } from 'react'
import useSWR, { useSWRConfig } from 'swr'
import { useTranslations } from 'next-intl'
import { ChevronDown, MoreHorizontal, Plus, RotateCw } from 'lucide-react'
import { listBots, type BotView } from '@/app/actions/bots'
import { createExecutionRule, deleteExecutionRule, getBotModel, listBotModels, listExecutionPlaces, listExecutionRules, redetectDevice, setBotModel, updateExecutionRule } from '@/app/actions/execution-settings'
import { Badge } from '@/components/reui/badge'
import { Button } from '@/components/ui/button'
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { BotAvatar, CoordinatorAvatar } from '@/components/nav/bot-avatar'
import { AutoLabel, DeviceLabel, HarnessLabel, ModelLabel, ProviderMark, harnessName } from '@/components/labels/entity-labels'
import { SettingsLoading, SettingsSaveError } from '@/components/settings/primitives'
import type { ExecutionRule } from '@/lib/execution-rules'
import { groupBotModels, harnessOptions, modelOptions, modelProvider, placeKind, redetectTargets, retarget, selectedBotModel, type BotModelRow, type ExecutionPlace } from '@/lib/execution-settings-view'
import { cn } from '@/lib/utils'

type RuleValue = { label: string; place: string; harness: string; model: string }
/** The server validates the harness; the screen only offers ones it accepts. */
const ruleInput = (value: RuleValue) => value as Parameters<typeof updateExecutionRule>[1]
type T = ReturnType<typeof useTranslations<'Settings.botAgents'>>

const KEYS = { rules: 'execution-rules', places: 'execution-places', bots: 'bot-agents-bots', botModels: 'bot-models' } as const
const DEFAULT_ID = 'default'

/*
 * 设置 › Bot 与 Agents (Figma 设置 v4, WS-34…WS-37). Both sections share one
 * column grid so the model column lines up: label | place | harness | model | ⋯.
 * Bots always run on Mikka, so their row spans the place and harness columns.
 */
function Columns() {
  return <colgroup>
    <col className="w-28" />
    <col className="w-52" />
    <col className="w-36" />
    <col />
    <col className="w-10" />
  </colgroup>
}

const ROW = 'hover:bg-transparent has-aria-expanded:bg-transparent'
const CELL = 'py-3 pl-0'

export function BotAgentsSettings() {
  const t = useTranslations('Settings.botAgents')
  const rules = useSWR(KEYS.rules, listExecutionRules)
  const places = useSWR(KEYS.places, async () => (await listExecutionPlaces()) as ExecutionPlace[], { refreshInterval: 15_000 })
  const bots = useSWR(KEYS.bots, listBots)
  const botModels = useSWR(KEYS.botModels, async () => (await listBotModels()) as BotModelRow[])
  const [failed, setFailed] = useState<(() => Promise<void>) | null>(null)

  /** Every change saves at once: the screen moves first, and a refused save puts it back. */
  async function save(change: () => Promise<void>) {
    setFailed(null)
    try { await change() } catch { setFailed(() => change) }
  }

  if (rules.error || places.error || bots.error || botModels.error) return <p role="alert" className="text-sm text-destructive">{t('loadFailed')}</p>
  if (!rules.data || !places.data || !bots.data || !botModels.data) return <SettingsLoading label={t('loading')} rows={4} />

  const placeList = places.data
  const modelRows = botModels.data
  const ruleList = rules.data
  const mutateRules = (next: ExecutionRule[], request: () => Promise<ExecutionRule[]>) => save(async () => {
    await rules.mutate(request, { optimisticData: next, rollbackOnError: true, populateCache: true, revalidate: false })
  })
  const updateRule = (rule: ExecutionRule, value: RuleValue) => mutateRules(
    ruleList.map(item => item.id === rule.id ? { ...item, ...value } : item),
    async () => updateExecutionRule(rule.id, ruleInput(value)),
  )
  const addRule = (label: string) => {
    const value = { label, place: 'auto', harness: 'auto', model: 'auto' }
    const editable = ruleList.filter(item => item.id !== DEFAULT_ID)
    return mutateRules(
      [...editable, { id: `pending-${editable.length}`, position: editable.length, ...value }, ...ruleList.filter(item => item.id === DEFAULT_ID)],
      async () => createExecutionRule(ruleInput(value)),
    )
  }
  const deleteRule = (rule: ExecutionRule) => mutateRules(ruleList.filter(item => item.id !== rule.id), async () => deleteExecutionRule(rule.id))
  const redetect = async (ids: string[]) => {
    await Promise.all(ids.map(id => redetectDevice(id)))
    await places.mutate()
  }

  return <div className="flex flex-col gap-10">
    <section aria-labelledby="bot-agents-bots" className="flex flex-col gap-2">
      <h2 id="bot-agents-bots" className="text-sm font-medium text-muted-foreground">{t('bots')}</h2>
      <Table className="table-fixed border-t">
        <Columns />
        <TableBody className="divide-y">
          <BotRow t={t} botId={null} name={null} rows={modelRows} onSave={save} onRefresh={async () => { await botModels.mutate() }} />
          {bots.data.map(bot => <BotRow key={bot.id} t={t} botId={bot.id} name={bot} rows={modelRows} onSave={save} onRefresh={async () => { await botModels.mutate() }} />)}
        </TableBody>
      </Table>
    </section>

    <section aria-labelledby="bot-agents-agents" className="flex flex-col gap-2">
      <header className="flex items-center justify-between gap-3">
        <h2 id="bot-agents-agents" className="text-sm font-medium text-muted-foreground">{t('agents')}</h2>
        <LabelPicker t={t} mode="add" onSubmit={label => { void addRule(label) }} />
      </header>
      <Table className="table-fixed">
        <Columns />
        <TableHeader>
          <TableRow className={cn(ROW, 'border-b')}>
            <TableHead className="h-8 pl-0 text-xs font-normal text-muted-foreground">{t('columns.label')}</TableHead>
            <TableHead className="h-8 pl-0 text-xs font-normal text-muted-foreground">{t('columns.place')}</TableHead>
            <TableHead className="h-8 pl-0 text-xs font-normal text-muted-foreground">{t('columns.harness')}</TableHead>
            <TableHead className="h-8 pl-0 text-xs font-normal text-muted-foreground">{t('columns.model')}</TableHead>
            <TableHead className="h-8 pl-0"><span className="sr-only">{t('columns.actions')}</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className="divide-y">
          {ruleList.map(rule => rule.id === DEFAULT_ID
            ? <DefaultRow key={rule.id} t={t} />
            : <RuleRow key={rule.id} t={t} rule={rule} places={placeList} onChange={value => { void updateRule(rule, value) }} onDelete={() => { void deleteRule(rule) }} onRedetect={redetect} />)}
        </TableBody>
      </Table>
    </section>
    {failed && <SettingsSaveError message={t('notSaved')} retryLabel={t('retry')} onRetry={() => { void save(failed) }} />}
  </div>
}

/** The fixed fallback: every column 自动. It cannot be changed or deleted, so it has no controls. */
function DefaultRow({ t }: { t: T }) {
  return <TableRow className={ROW} data-rule="default">
    <TableCell className={cn(CELL, 'text-muted-foreground')}>{t('default')}</TableCell>
    <TableCell className={CELL}><AutoLabel /></TableCell>
    <TableCell className={CELL}><AutoLabel /></TableCell>
    <TableCell className={CELL}><AutoLabel /></TableCell>
    <TableCell className={CELL} />
  </TableRow>
}

function RuleRow({ t, rule, places, onChange, onDelete, onRedetect }: {
  t: T
  rule: ExecutionRule
  places: ExecutionPlace[]
  onChange: (value: RuleValue) => void
  onDelete: () => void
  onRedetect: (ids: string[]) => Promise<void>
}) {
  const label = rule.label ?? ''
  const value: RuleValue = { label, place: rule.place, harness: rule.harness, model: rule.model }
  const pending = rule.id.startsWith('pending-')
  const devices = places.filter(place => placeKind(place) !== 'cloud')
  const placeName = (id: string) => id === 'cloud' ? t('cloud') : places.find(place => place.id === id)?.name ?? t('removedDevice')
  const placeLabel = (id: string) => {
    if (id === 'auto') return <AutoLabel />
    const place = places.find(item => item.id === id)
    return <DeviceLabel kind={id === 'cloud' ? 'cloud' : place ? placeKind(place) : 'unknown'} name={placeName(id)} online={id === 'cloud' || Boolean(place?.online)} />
  }
  const harnesses = harnessOptions(places, rule.place)
  const harnessList = rule.harness === 'auto' || harnesses.some(item => item === rule.harness) ? harnesses : [...harnesses, rule.harness]
  const models = modelOptions(places, rule.place, rule.harness)
  const modelList = rule.model === 'auto' || models.includes(rule.model) ? models : [...models, rule.model]
  const cell = (column: string, name: string) => t('cell', { row: label, column, value: name })
  const refresh = () => onRedetect(redetectTargets(places, rule.place))

  return <TableRow className={ROW} data-rule={label}>
    <TableCell className={CELL}>
      <LabelPicker t={t} mode="edit" label={label} disabled={pending} onSubmit={next => { if (next !== label) onChange({ ...value, label: next }) }} />
    </TableCell>
    <TableCell className={CELL}>
      <CellPicker t={t} ariaLabel={cell(t('columns.place'), rule.place === 'auto' ? t('auto') : placeName(rule.place))} heading={t('columns.place')} onRefresh={() => onRedetect(redetectTargets(places, 'auto'))} disabled={pending} value={placeLabel(rule.place)}>
        {close => <CommandGroup>
          <CommandItem value="auto" keywords={[t('auto')]} data-checked={rule.place === 'auto'} onSelect={() => { close(); onChange(retarget(places, { ...value, place: 'auto' })) }}><AutoLabel /></CommandItem>
          {devices.map(device => <CommandItem key={device.id} value={device.id} keywords={[device.name ?? device.id]} data-checked={rule.place === device.id} onSelect={() => { close(); onChange(retarget(places, { ...value, place: device.id })) }}>
            <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
              <DeviceLabel kind={placeKind(device)} name={device.name ?? device.id} online={device.online} />
              {!device.online && <span className="shrink-0 text-xs text-muted-foreground">{t('offline')}</span>}
            </span>
          </CommandItem>)}
          <CommandItem value="cloud" keywords={[t('cloud')]} data-checked={rule.place === 'cloud'} onSelect={() => { close(); onChange(retarget(places, { ...value, place: 'cloud' })) }}><DeviceLabel kind="cloud" name={t('cloud')} online /></CommandItem>
        </CommandGroup>}
      </CellPicker>
    </TableCell>
    <TableCell className={CELL}>
      <CellPicker t={t} ariaLabel={cell(t('columns.harness'), rule.harness === 'auto' ? t('auto') : harnessName(rule.harness))} heading={t('columns.harness')} onRefresh={rule.place === 'cloud' ? undefined : refresh} disabled={pending} value={rule.harness === 'auto' ? <AutoLabel /> : <HarnessLabel harness={rule.harness} />}>
        {close => <CommandGroup>
          <CommandItem value="auto" keywords={[t('auto')]} data-checked={rule.harness === 'auto'} onSelect={() => { close(); onChange({ ...value, harness: 'auto', model: 'auto' }) }}><AutoLabel /></CommandItem>
          {harnessList.map(harness => <CommandItem key={harness} value={harness} keywords={[harnessName(harness)]} data-checked={rule.harness === harness} onSelect={() => {
            close()
            onChange({ ...value, harness, model: modelOptions(places, rule.place, harness).includes(rule.model) ? rule.model : 'auto' })
          }}><HarnessLabel harness={harness} /></CommandItem>)}
        </CommandGroup>}
      </CellPicker>
    </TableCell>
    <TableCell className={CELL}>
      <CellPicker t={t} ariaLabel={cell(t('columns.model'), rule.model === 'auto' ? t('auto') : rule.model)} heading={t('columns.model')} onRefresh={rule.place === 'cloud' ? undefined : refresh} search={t('searchModels')} disabled={pending} value={rule.model === 'auto' ? <AutoLabel /> : <ModelLabel model={rule.model} source={rule.harness} />}>
        {close => <CommandGroup>
          <CommandItem value="auto" keywords={[t('auto')]} data-checked={rule.model === 'auto'} onSelect={() => { close(); onChange({ ...value, model: 'auto' }) }}><AutoLabel /></CommandItem>
          {modelList.map(model => <CommandItem key={model} value={model} keywords={[model]} data-checked={rule.model === model} onSelect={() => { close(); onChange({ ...value, model }) }}><ModelLabel model={model} source={rule.harness} /></CommandItem>)}
        </CommandGroup>}
      </CellPicker>
    </TableCell>
    <TableCell className={cn(CELL, 'pr-0 text-right')}>
      <DropdownMenu>
        <DropdownMenuTrigger disabled={pending} render={<Button variant="ghost" size="icon-sm" aria-label={t('rowMenu', { label })} />}><MoreHorizontal /></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuGroup>
            <DropdownMenuItem variant="destructive" onClick={onDelete}>{t('delete')}</DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </TableCell>
  </TableRow>
}

/** A Bot's own model. Bots always run on Mikka, so the row has no place or harness. */
function BotRow({ t, botId, name, rows, onSave, onRefresh }: {
  t: T
  botId: string | null
  name: BotView | null
  rows: BotModelRow[]
  onSave: (change: () => Promise<void>) => Promise<void>
  onRefresh: () => Promise<void>
}) {
  const tCoordinator = useTranslations('Coordinator')
  const { mutate: mutateKey } = useSWRConfig()
  const choice = useSWR(['bot-model', botId ?? 'coordinator'], async () => (await getBotModel(botId)) ?? null)
  const title = name?.name ?? tCoordinator('label')
  const selected = selectedBotModel(rows, choice.data)
  const accounts = groupBotModels(rows)
  const choose = (bindingId: string | null) => onSave(async () => {
    await choice.mutate(async () => { await setBotModel(botId, bindingId); return (await getBotModel(botId)) ?? null }, { optimisticData: bindingId, rollbackOnError: true, revalidate: false })
    // Choosing another Bot's model copies its binding to this Bot; list the copy too.
    await mutateKey(KEYS.botModels)
  })
  return <TableRow className={ROW} data-bot={title}>
    <TableCell className={CELL} colSpan={3}>
      <span className="flex min-w-0 items-center gap-2.5">
        {name ? <BotAvatar color={name.color} shape={name.shape} size="row" label={name.name} /> : <CoordinatorAvatar size="row" />}
        <span className="truncate text-sm">{title}</span>
      </span>
    </TableCell>
    <TableCell className={CELL}>
      <CellPicker t={t} ariaLabel={t('cell', { row: title, column: t('columns.model'), value: selected?.modelId ?? t('auto') })} disabled={choice.data === undefined} value={selected ? <ModelLabel model={selected.modelId} source={selected.provider} /> : <AutoLabel />}>
        {close => <>
          <CommandGroup>
            <CommandItem value="auto" keywords={[t('auto')]} data-checked={!selected} onSelect={() => { close(); void choose(null) }}>
              <span className="flex min-w-0 flex-col gap-0.5">
                <AutoLabel />
                <span className="pl-5.5 text-xs text-muted-foreground">{t('autoBotHint')}</span>
              </span>
            </CommandItem>
          </CommandGroup>
          {accounts.map(account => <CommandGroup key={account.connectionId} className="border-t" heading={<PickerHeading t={t} title={<span className="flex items-center gap-1.5"><ProviderMark provider={modelProvider('', account.provider)} small />{account.provider === 'claude' ? t('claudeAccount') : t('openaiAccount')}</span>} onRefresh={onRefresh} />}>
            {account.models.map(model => <CommandItem key={model.key} value={model.key} keywords={[model.modelId]} data-checked={selected?.key === model.key} onSelect={() => { close(); void choose(model.bindingId) }}><ModelLabel model={model.modelId} source={account.provider} /></CommandItem>)}
          </CommandGroup>)}
        </>}
      </CellPicker>
    </TableCell>
    <TableCell className={CELL} />
  </TableRow>
}

/** A ghost trigger (text and chevron, hover fill only) opening a checkmark list. */
function CellPicker({ t, ariaLabel, value, heading, onRefresh, search, disabled, children }: {
  t: T
  ariaLabel: string
  value: ReactNode
  heading?: string
  onRefresh?: () => Promise<void>
  search?: string
  disabled?: boolean
  children: (close: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger disabled={disabled} render={<Button variant="ghost" size="sm" aria-label={ariaLabel} className="-ml-2.5 max-w-full justify-start font-normal" />}>
      {value}<ChevronDown data-icon="inline-end" className="text-muted-foreground" />
    </PopoverTrigger>
    <PopoverContent align="start" className="w-64 gap-0 p-0">
      <Command loop>
        {heading && <PickerHeading t={t} title={heading} onRefresh={onRefresh} />}
        {search && <CommandInput placeholder={search} aria-label={search} />}
        <CommandList>{children(() => setOpen(false))}</CommandList>
      </Command>
    </PopoverContent>
  </Popover>
}

/** A list heading with its 重新检测: an icon-only button that spins while it works. */
function PickerHeading({ t, title, onRefresh }: { t: T; title: ReactNode; onRefresh?: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  async function refresh() {
    if (busy || !onRefresh) return
    setBusy(true)
    try { await onRefresh() } catch { /* The list keeps what it had; the next poll tries again. */ } finally { setBusy(false) }
  }
  return <span className="flex items-center justify-between gap-2 px-2 pt-1.5 pb-0.5 text-xs font-normal text-muted-foreground">
    <span className="min-w-0 truncate">{title}</span>
    {onRefresh && <Button variant="ghost" size="icon-xs" aria-label={t('redetect')} aria-busy={busy} onClick={() => { void refresh() }}><RotateCw className={cn(busy && 'animate-spin')} /></Button>}
  </span>
}


/** 添加规则 and the label cell: one field for the issue label the rule matches. */
function LabelPicker({ t, mode, label = '', disabled, onSubmit }: { t: T; mode: 'add' | 'edit'; label?: string; disabled?: boolean; onSubmit: (label: string) => void }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(label)
  const trimmed = draft.trim()
  return <Popover open={open} onOpenChange={next => { setOpen(next); if (next) setDraft(label) }}>
    {mode === 'add'
      ? <PopoverTrigger render={<Button variant="ghost" size="sm" />}><Plus data-icon="inline-start" />{t('addRule')}</PopoverTrigger>
      : <PopoverTrigger disabled={disabled} render={<Button variant="ghost" size="sm" aria-label={t('cell', { row: label, column: t('columns.label'), value: label })} className="-ml-2.5 max-w-full justify-start" />}>
        <Badge variant="secondary" size="lg" className="max-w-full font-medium"><span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current text-muted-foreground" /><span className="truncate">{label}</span></Badge>
      </PopoverTrigger>}
    <PopoverContent align={mode === 'add' ? 'end' : 'start'} className="w-64 p-1.5">
      <form onSubmit={event => { event.preventDefault(); if (!trimmed) return; setOpen(false); onSubmit(trimmed) }}>
        <InputGroup>
          <InputGroupInput autoFocus value={draft} maxLength={200} placeholder={t('columns.label')} aria-label={t('columns.label')} onChange={event => setDraft(event.target.value)} />
          <InputGroupAddon align="inline-end">
            <InputGroupButton type="submit" variant="secondary" disabled={!trimmed}>{mode === 'add' ? t('add') : t('save')}</InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </form>
    </PopoverContent>
  </Popover>
}
