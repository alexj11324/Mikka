'use client'

import { useState, type ReactNode } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { Check, ChevronDown, MoreHorizontal, Plus, RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { DeviceLabel, HarnessLabel, ModelLabel, harnessName } from '@/components/labels/entity-labels'
import { SettingsLoading, SettingsSaveError } from '@/components/settings/primitives'
import { LabelDot } from '@/components/workspace/issue-metadata-controls'
import {
  BOT_AGENTS_KEYS, addRule, executionSettingsView, listAccountModels, listPlaces, readExecutionSettings, redetect, removeRule, saveDefaultRule, updateRule,
  type LabelRule, type StoredExecutionSettings, type TaskDefaults,
} from '@/lib/execution-settings-client'
import type { ExecutionRule } from '@/lib/execution-rules'
import { harnessOptions, modelName, modelOptions, placeKind, redetectTargets, retarget, withCloudModels, type ExecutionChoice, type ExecutionPlace } from '@/lib/execution-settings-view'
import { cn } from '@/lib/utils'
import { findLabel, listWorkspaceLabels, matchLabels } from '@/lib/workspace-labels'
import { FieldError } from '@/components/ui/field'

type T = ReturnType<typeof useTranslations<'Settings.botAgents'>>

const KEYS = BOT_AGENTS_KEYS

/*
 * 设置 › Bot 与 Agents, laid out like Comma's 模型与 API: one card per
 * section, one setting per row, a filled select on the right. Every place,
 * harness and model is a concrete value the person can see (no 自动, #537).
 */
export function BotAgentsSettings() {
  const t = useTranslations('Settings.botAgents')
  const stored = useSWR(KEYS.settings, readExecutionSettings)
  const places = useSWR(KEYS.places, listPlaces, { refreshInterval: 15_000 })
  const accounts = useSWR(KEYS.accounts, listAccountModels)
  const [failed, setFailed] = useState<(() => Promise<void>) | null>(null)
  /** A choice the server refused stays on screen, marked 未保存, until a retry saves it. */
  const [unsaved, setUnsaved] = useState<{ defaults?: TaskDefaults }>({})

  async function save(change: () => Promise<void>) {
    setFailed(null)
    try { await change() } catch { setFailed(() => change) }
  }

  if (stored.error || places.error || accounts.error) return <FieldError>{t('loadFailed')}</FieldError>
  if (!stored.data || !places.data || !accounts.data) return <SettingsLoading label={t('loading')} rows={4} />

  const accountRows = accounts.data
  const placeList = withCloudModels(places.data, accountRows)
  const view = executionSettingsView(stored.data, placeList, accountRows)
  const defaults = unsaved.defaults ?? view.defaults
  const current = stored.data

  const changeDefaults = (next: TaskDefaults) => {
    setUnsaved(state => ({ ...state, defaults: next }))
    void save(async () => {
      await saveDefaultRule(next)
      setUnsaved(({ defaults: _saved, ...rest }) => rest)
      await stored.mutate()
    })
  }
  /** Rules save at once: the table moves first, and a refused save puts it back. */
  const mutateRules = (next: ExecutionRule[], request: () => Promise<void>) => save(async () => {
    await stored.mutate(async (): Promise<StoredExecutionSettings> => { await request(); return readExecutionSettings() },
      { optimisticData: { ...current, rules: next }, rollbackOnError: true, populateCache: true, revalidate: false })
  })
  const changeRule = (rule: LabelRule, label: string, value: ExecutionChoice) => mutateRules(
    current.rules.map(item => item.id === rule.id ? { ...item, label, ...value } : item),
    () => updateRule(rule.id, label, value),
  )
  const createRule = (label: string) => {
    // A new rule starts from the task defaults.
    const value: ExecutionChoice = { place: defaults.place, harness: defaults.harness, model: defaults.model }
    return mutateRules([...current.rules, { id: `pending-${current.rules.length}`, position: current.rules.length, label, ...value }], () => addRule(label, value))
  }
  const deleteRule = (rule: LabelRule) => mutateRules(current.rules.filter(item => item.id !== rule.id), () => removeRule(rule.id))
  const refreshDevices = async (ids: string[]) => {
    await redetect(ids)
    await places.mutate()
  }
  const defaultPickers = executionPickers({ t, row: t('default'), value: defaults, places: placeList, wide: true, onChange: value => changeDefaults({ ...defaults, ...value }), onRedetect: refreshDevices })

  return <div className="flex flex-col gap-8">
    {/* Each bot's model is picked in its own chat (decision 2026-10-31-2330); 设备离线时 and
        额度用完时 are account settings in 模型与额度 (decision 2026-10-31-2130). */}
    <Group id="bot-agents-defaults" title={t('defaults')} data-rule="default">
      <Line title={t('columns.place')}>{defaultPickers.place}</Line>
      <Line title={t('columns.harness')}>{defaultPickers.harness}</Line>
      <Line title={t('columns.model')}>{defaultPickers.model}</Line>
    </Group>

    <Group id="bot-agents-labels" title={t('labels')}>
      {view.rules.length > 0 && <div className="overflow-x-auto">
        <Table className="min-w-[40rem] table-fixed">
          <colgroup>
            <col className="w-36" />
            <col className="w-[27%]" />
            <col className="w-[25%]" />
            <col />
            <col className="w-11" />
          </colgroup>
          <TableHeader>
            <TableRow className="border-b hover:bg-transparent">
              {(['label', 'place', 'harness', 'model'] as const).map((column, index) => <TableHead key={column} className={cn('h-9 text-xs font-normal text-muted-foreground', index === 0 ? 'pl-4' : 'pl-0')}>{t(`columns.${column}`)}</TableHead>)}
              <TableHead className="h-9"><span className="sr-only">{t('columns.actions')}</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.rules.map(rule => <RuleRow key={rule.id} t={t} rule={rule} places={placeList} onChange={(label, value) => { void changeRule(rule, label, value) }} onDelete={() => { void deleteRule(rule) }} onRedetect={refreshDevices} />)}
          </TableBody>
        </Table>
      </div>}
      <div className="px-2 py-2">
        <LabelPicker t={t} mode="add" onSubmit={label => { void createRule(label) }} />
      </div>
    </Group>
    {failed && <SettingsSaveError message={t('notSaved')} retryLabel={t('retry')} onRetry={() => { void save(failed) }} />}
  </div>
}

/** A section: a small grey heading and one card of rows. */
function Group({ id, title, children, ...props }: { id: string; title: string; children: ReactNode; 'data-rule'?: string }) {
  return <section aria-labelledby={id} className="flex flex-col gap-2">
    <h2 id={id} className="px-1 text-xs text-muted-foreground">{title}</h2>
    <div data-settings-card className="flex flex-col divide-y divide-border overflow-hidden rounded-2xl border bg-card" {...props}>{children}</div>
  </section>
}

/** One setting per row: its name on the left, a select on the right. */
function Line({ title, leading, children, ...props }: { title: ReactNode; leading?: ReactNode; children: ReactNode; 'data-bot'?: string }) {
  return <div className="flex flex-col gap-2.5 px-4 py-3.5 sm:min-h-16 sm:flex-row sm:items-center sm:gap-4" {...props}>
    <span className="flex min-w-0 flex-1 items-center gap-3">
      {leading}
      <span className="truncate text-sm">{title}</span>
    </span>
    <span className="flex w-full shrink-0 sm:w-60">{children}</span>
  </div>
}

/**
 * The place, harness and model pickers for one rule. The defaults show them a
 * row each; a label rule shows them as table cells.
 */
function executionPickers({ t, row, value, places, wide, disabled, onChange, onRedetect }: {
  t: T
  row: string
  value: ExecutionChoice
  places: ExecutionPlace[]
  wide?: boolean
  disabled?: boolean
  onChange: (value: ExecutionChoice) => void
  onRedetect: (ids: string[]) => Promise<void>
}) {
  const devices = places.filter(place => placeKind(place) !== 'cloud')
  const device = places.find(item => item.id === value.place)
  const placeName = value.place === 'cloud' ? t('cloud') : device?.name ?? t('removedDevice')
  const harnesses = harnessOptions(places, value.place)
  const harnessList = harnesses.includes(value.harness) ? harnesses : [...harnesses, value.harness]
  const models = modelOptions(places, value.place, value.harness)
  const modelList = models.some(option => option.value === value.model) ? models : [...models, { value: value.model, name: value.model }]
  const shownModel = modelName(places, value.place, value.harness, value.model)
  const cell = (column: string, name: string) => t('cell', { row, column, value: name })
  const refresh = () => onRedetect(redetectTargets(places, value.place))
  const move = (place: string) => onChange(retarget(places, { ...value, place }))

  return {
    place: <Picker t={t} wide={wide} disabled={disabled} ariaLabel={cell(t('columns.place'), placeName)} heading={t('columns.place')} onRefresh={() => onRedetect(redetectTargets(places, 'cloud'))}
      value={<DeviceLabel kind={value.place === 'cloud' ? 'cloud' : device ? placeKind(device) : 'unknown'} name={placeName} online={value.place === 'cloud' || Boolean(device?.online)} />}>
      {close => <CommandGroup>
        {devices.map(item => <CommandItem key={item.id} value={item.id} keywords={[item.name ?? item.id]} data-checked={value.place === item.id} onSelect={() => { close(); move(item.id) }}>
          <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
            <DeviceLabel kind={placeKind(item)} name={item.name ?? item.id} online={item.online} />
            {!item.online && <span className="shrink-0 text-xs text-muted-foreground">{t('offline')}</span>}
          </span>
        </CommandItem>)}
        <CommandItem value="cloud" keywords={[t('cloud')]} data-checked={value.place === 'cloud'} onSelect={() => { close(); move('cloud') }}><DeviceLabel kind="cloud" name={t('cloud')} online /></CommandItem>
      </CommandGroup>}
    </Picker>,
    harness: <Picker t={t} wide={wide} disabled={disabled} ariaLabel={cell(t('columns.harness'), harnessName(value.harness))} heading={t('columns.harness')} onRefresh={refresh} value={<HarnessLabel harness={value.harness} />}>
      {close => <CommandGroup>
        {harnessList.map(harness => <CommandItem key={harness} value={harness} keywords={[harnessName(harness)]} data-checked={value.harness === harness} onSelect={() => { close(); onChange(retarget(places, { ...value, harness })) }}><HarnessLabel harness={harness} /></CommandItem>)}
      </CommandGroup>}
    </Picker>,
    model: <Picker t={t} wide={wide} disabled={disabled} ariaLabel={cell(t('columns.model'), shownModel)} heading={t('columns.model')} onRefresh={refresh} search={t('searchModels')} value={<ModelLabel model={shownModel} source={value.harness} />}>
      {close => <CommandGroup>
        {modelList.map(option => <CommandItem key={option.value} value={option.value} keywords={[option.name]} data-checked={value.model === option.value} onSelect={() => { close(); onChange({ ...value, model: option.value }) }}><ModelLabel model={option.name} source={value.harness} /></CommandItem>)}
      </CommandGroup>}
    </Picker>,
  }
}

function RuleRow({ t, rule, places, onChange, onDelete, onRedetect }: {
  t: T
  rule: LabelRule
  places: ExecutionPlace[]
  onChange: (label: string, value: ExecutionChoice) => void
  onDelete: () => void
  onRedetect: (ids: string[]) => Promise<void>
}) {
  const pending = rule.id.startsWith('pending-')
  const value: ExecutionChoice = { place: rule.place, harness: rule.harness, model: rule.model }
  const cells = executionPickers({ t, row: rule.label, value, places, disabled: pending, onChange: next => onChange(rule.label, next), onRedetect })
  const cell = 'py-2.5 pl-0 pr-2'
  return <TableRow className="hover:bg-transparent has-aria-expanded:bg-transparent" data-rule={rule.label}>
    <TableCell className={cn(cell, 'pl-4')}>
      <LabelPicker t={t} mode="edit" label={rule.label} disabled={pending} onSubmit={next => { if (next !== rule.label) onChange(next, value) }} />
    </TableCell>
    <TableCell className={cell}>{cells.place}</TableCell>
    <TableCell className={cell}>{cells.harness}</TableCell>
    <TableCell className={cell}>{cells.model}</TableCell>
    <TableCell className={cn(cell, 'pr-3 text-right')}>
      <DropdownMenu>
        <DropdownMenuTrigger disabled={pending} render={<Button variant="ghost" size="icon-sm" aria-label={t('rowMenu', { label: rule.label })} />}><MoreHorizontal /></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuGroup>
            <DropdownMenuItem variant="destructive" onClick={onDelete}>{t('delete')}</DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </TableCell>
  </TableRow>
}

/**
 * Bordered like the select field (Comma's 模型与 API), not R-31's grey fill:
 * as wide as its slot, icon and value on the left, chevron on the right.
 */
const TRIGGER = 'h-9 w-full min-w-0 justify-between gap-2 bg-control px-3 font-normal hover:bg-control-hover aria-expanded:bg-control-hover'

/** A fallback: a fixed list of named choices. They are not devices, harnesses or models, so no icons. */
export function ChoicePicker<V extends string>({ ariaLabel, value, names, onChange }: { ariaLabel: string; value: V; names: Record<V, string>; onChange: (value: V) => void }) {
  const [open, setOpen] = useState(false)
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger render={<Button variant="ghost" aria-label={ariaLabel} className={TRIGGER} />}>
      <span className="min-w-0 flex-1 truncate text-left">{names[value]}</span><ChevronDown data-icon="inline-end" className="text-muted-foreground" />
    </PopoverTrigger>
    <PopoverContent align="end" className="w-60 gap-0 p-0">
      <Command loop>
        <CommandList>
          <CommandGroup>
            {(Object.keys(names) as V[]).map(key => <CommandItem key={key} value={key} keywords={[names[key]]} data-checked={key === value} onSelect={() => { setOpen(false); if (key !== value) onChange(key) }}>{names[key]}</CommandItem>)}
          </CommandGroup>
        </CommandList>
      </Command>
    </PopoverContent>
  </Popover>
}

/** A bordered select opening a checkmark list. */
function Picker({ t, ariaLabel, value, heading, onRefresh, search, disabled, wide, children }: {
  t: T
  ariaLabel: string
  value: ReactNode
  heading?: string
  onRefresh?: () => Promise<void>
  search?: string
  disabled?: boolean
  /** On a setting row the list opens under the right edge; in a table cell, under the left. */
  wide?: boolean
  children: (close: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger disabled={disabled} render={<Button variant="ghost" aria-label={ariaLabel} className={TRIGGER} />}>
      <span className="flex min-w-0 flex-1 text-left">{value}</span><ChevronDown data-icon="inline-end" className="text-muted-foreground" />
    </PopoverTrigger>
    <PopoverContent align={wide ? 'end' : 'start'} className="w-64 gap-0 p-0">
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

const LABELS_KEY = 'workspace-labels'

/**
 * 添加规则 and the label cell: one field for the issue label the rule matches.
 * The cell is a bordered select like its neighbours; it lists the workspace's labels to pick from,
 * and its dot takes the label's colour (#539).
 */
function LabelPicker({ t, mode, label = '', disabled, onSubmit }: { t: T; mode: 'add' | 'edit'; label?: string; disabled?: boolean; onSubmit: (label: string) => void }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(label)
  const labels = useSWR(mode === 'edit' ? LABELS_KEY : null, listWorkspaceLabels).data ?? []
  const trimmed = draft.trim()
  const current = findLabel(labels, label)
  // The saved name lists everything; typing narrows it.
  const options = matchLabels(labels, draft === label ? '' : trimmed)
  const submit = (next: string) => { setOpen(false); onSubmit(next) }
  return <Popover open={open} onOpenChange={next => { setOpen(next); if (next) setDraft(label) }}>
    {mode === 'add'
      ? <PopoverTrigger render={<Button variant="ghost" size="sm" />}><Plus data-icon="inline-start" />{t('addRule')}</PopoverTrigger>
      : <PopoverTrigger disabled={disabled} render={<Button variant="ghost" aria-label={t('cell', { row: label, column: t('columns.label'), value: label })} className={TRIGGER} />}>
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          {current ? <LabelDot color={current.color} /> : <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current text-muted-foreground" />}
          <span className="truncate">{label}</span>
        </span>
        <ChevronDown data-icon="inline-end" className="text-muted-foreground" />
      </PopoverTrigger>}
    <PopoverContent align="start" className="w-64 p-1.5">
      <form onSubmit={event => { event.preventDefault(); if (trimmed) submit(trimmed) }}>
        <InputGroup>
          <InputGroupInput autoFocus value={draft} maxLength={200} placeholder={t('columns.label')} aria-label={t('columns.label')} onChange={event => setDraft(event.target.value)} />
          <InputGroupAddon align="inline-end">
            <InputGroupButton type="submit" variant="secondary" disabled={!trimmed}>{mode === 'add' ? t('add') : t('save')}</InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </form>
      {options.length > 0 && <div role="group" aria-label={t('columns.label')} className="mt-1 flex max-h-60 flex-col overflow-y-auto">
        {options.map(item => <Button key={item.name} type="button" variant="ghost" size="sm" aria-pressed={item.name === current?.name} className="justify-start font-normal" onClick={() => submit(item.name)}>
          <LabelDot color={item.color} /><span className="truncate">{item.name}</span>{item.name === current?.name && <Check data-icon="inline-end" className="ml-auto" />}
        </Button>)}
      </div>}
    </PopoverContent>
  </Popover>
}
