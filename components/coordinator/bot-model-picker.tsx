'use client'

import { useEffect, useState } from 'react'
import { useEnabledModels } from '@/lib/enabled-models'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react'
import { chooseBotModel, getBotModelMenu, refreshBotModelMenuAction } from '@/app/actions/execution-settings'
import { Link } from '@/i18n/navigation'
import { settingsHref } from '@/lib/settings-sections'
import { Button } from '@/components/ui/button'
import { InputGroupButton } from '@/components/ui/input-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { HostedModelLabel, ModelLabel, ProviderMark } from '@/components/labels/entity-labels'
import { groupByModelFamily, modelDisplayName, modelVendor, type ModelVendor } from '@/lib/model-display-name'
import { HOSTED_CHOICE, parseApiKeyOption, type BotModelMenu, type BotModelMenuGroup, type BotModelMenuOption } from '@/lib/bot-model-menu-view'
import { cn } from '@/lib/utils'

type T = ReturnType<typeof useTranslations<'Coordinator.modelPicker'>>

/** The SWR key of a chat's model menu. */
export const botModelMenuKey = (botId: string | null) => ['bot-model-menu', botId ?? 'coordinator'] as const

const OPEN_EVENT = 'mikka:open-model-picker'

/** Opens a chat's model picker from elsewhere in the chat, e.g. 改回 on a quota switch line. */
export function openModelPicker(botId: string | null) {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: botId ?? 'coordinator' }))
}

function providerName(provider: string | undefined) {
  return provider === 'claude' ? 'Claude' : 'ChatGPT'
}

function heading(t: T, group: BotModelMenuGroup) {
  const credential = group.credentialLabel ? ` · ${group.credentialLabel}` : ''
  switch (group.kind) {
    case 'hosted': return 'Mikka'
    // The plan names it (Claude Max, ChatGPT Pro): everything but a share is the person's own (decision 2026-10-31-2330).
    case 'subscription': return `${group.plan ? `${providerName(group.provider)} ${group.plan}` : providerName(group.provider)}${credential}`
    case 'apiKey': return `${t('apiKey')}${credential}`
    case 'shared': return `${t('shared')}${credential}`
  }
}

/** What sits at the right of an item: who pays for it. A subscription item has none. */
function tag(t: T, group: BotModelMenuGroup) {
  switch (group.kind) {
    // The points it can spend in this chat's workspace, not the person's elsewhere (decision 2026-11-02-1450).
    case 'hosted': return group.trialLeft !== undefined ? t('trialLeft', { count: group.trialLeft }) : group.points === undefined ? t('credits') : t('points', { points: group.points })
    case 'apiKey': return t('metered')
    case 'shared': return group.owner ? t('sharedKey', { name: group.owner }) : null
    default: return null
  }
}

type ChipModel = Pick<BotModelMenuOption, 'id' | 'modelId' | 'provider'>

/** Where this browser keeps the model a chat's chip showed last; someone else's bot or a failed menu clears it. */
const lastChipKey = (botId: string | null) => `mikka:model-chip:${botId ?? 'coordinator'}`

function readChip(value: string | null): ChipModel | null {
  try {
    const chip: unknown = value ? JSON.parse(value) : null
    if (!chip || typeof chip !== 'object') return null
    const { id, modelId, provider } = chip as Record<string, unknown>
    return typeof id === 'string' && typeof modelId === 'string' && typeof provider === 'string' ? { id, modelId, provider } : null
  } catch { return null }
}

function OptionLabel({ t, option }: { t: T; option: ChipModel }) {
  return option.id === HOSTED_CHOICE ? <HostedModelLabel name={t('hosted')} /> : <ModelLabel model={option.modelId || t('unknownModel')} source={option.provider} />
}

/**
 * The model chip in a bot's composer, the Coordinator's included (decision
 * 2026-10-31-2330): the model the bot's next runs use, and a
 * menu of what this person can use here. The choice is saved per bot; a run
 * already going keeps its model.
 */
export function BotModelPicker({ botId, running = false }: { botId: string | null; running?: boolean }) {
  const t = useTranslations('Coordinator.modelPicker')
  const menu = useSWR<BotModelMenu>(botModelMenuKey(botId), () => getBotModelMenu(botId))
  const [failed, setFailed] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshFailed, setRefreshFailed] = useState(false)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const listener = (event: Event) => { if ((event as CustomEvent<string>).detail === (botId ?? 'coordinator')) { setOpen(true); void refresh() } }
    window.addEventListener(OPEN_EVENT, listener)
    return () => window.removeEventListener(OPEN_EVENT, listener)
  })
  const [last, setLast] = useState<ChipModel | null>(null)
  const shown = menu.data?.current
  useEffect(() => {
    const key = lastChipKey(botId)
    try {
      if (shown) window.localStorage.setItem(key, JSON.stringify({ id: shown.id, modelId: shown.modelId, provider: shown.provider }))
      else if (menu.error) window.localStorage.removeItem(key)
      else setLast(readChip(window.localStorage.getItem(key)))
    } catch { /* storage unavailable: the chip waits for the menu */ }
  }, [botId, shown, menu.error])
  // Someone else's bot gets no chip; while the menu loads, the chip keeps the model it showed last time (state completeness).
  // It is the chip's look only, not a control, until the menu it opens has arrived.
  if (!menu.data) return last && !menu.error ? <span role="status" aria-busy="true" data-testid="bot-model-chip-pending" data-next-message={running || undefined} aria-label={t('label', { name: last.id === HOSTED_CHOICE ? t('hosted') : last.modelId ? modelDisplayName(last.modelId).name : t('unknownModel') })}
    className="inline-flex h-6 max-w-56 shrink-0 items-center gap-1 rounded-full bg-control px-2 text-sm whitespace-nowrap text-foreground [&_svg]:shrink-0 [&>svg]:size-3.5">
    <span className="flex min-w-0"><OptionLabel t={t} option={last} /></span>
    <ChevronDown className="text-muted-foreground" />
  </span> : null
  const { current, groups } = menu.data
  const value = current.id

  async function choose(id: string) {
    if (id === value && current.chosen) return
    setFailed(false)
    try {
      // A pick that is not saved comes back as `{ error }`: failing here rolls the chip back and shows 未保存.
      await menu.mutate(async () => {
        const { error, ...saved } = await chooseBotModel(botId, id)
        if (error) throw new Error(error)
        return saved as BotModelMenu
      }, {
        rollbackOnError: true, populateCache: true, revalidate: false,
      })
    } catch { setFailed(true) }
  }

  /** 刷新模型列表: the menu keeps what it shows until the new list arrives, and stays open. */
  async function refresh() {
    if (refreshing) return
    setRefreshing(true)
    setRefreshFailed(false)
    try {
      await menu.mutate(() => refreshBotModelMenuAction(botId), { populateCache: true, revalidate: false })
    } catch { setRefreshFailed(true) } finally { setRefreshing(false) }
  }

  const name = current.id === HOSTED_CHOICE ? t('hosted') : current.modelId ? modelDisplayName(current.modelId).name : t('unknownModel')
  const checking = current.availability === 'checking'
  const unavailable = !current.available && !checking
  const label = [name,
    current.fallback ? t('fallback') : null, checking ? t('checking') : null].filter(Boolean).join(' · ')
  return <DropdownMenu open={open} onOpenChange={next => { setOpen(next); if (next) void refresh() }}>
    <DropdownMenuTrigger render={<InputGroupButton type="button" variant="secondary" size="xs" data-testid="bot-model-chip" data-unavailable={unavailable || undefined} data-next-message={running || undefined}
      className={cn('max-w-56 rounded-full px-2 font-normal', unavailable ? 'text-muted-foreground' : 'text-foreground')}
      title={label} aria-label={unavailable ? t('labelUnavailable', { name: label }) : t('label', { name: label })} />}>
      <span className="flex min-w-0"><OptionLabel t={t} option={current} /></span>
      {failed && <span className="shrink-0 text-xs text-destructive-foreground">{t('notSaved')}</span>}
      <ChevronDown className="text-muted-foreground" />
    </DropdownMenuTrigger>
    <DropdownMenuContent side="top" align="start" className="w-[26rem] p-0">
      <VendorMenu t={t} groups={groups} value={value} onChoose={id => { void choose(id) }} />
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        {refreshFailed && <DropdownMenuItem closeOnClick={false} className="text-xs text-destructive-foreground" onClick={() => { void refresh() }}>{t('refreshFailed')}</DropdownMenuItem>}
        <div className="flex items-center gap-1">
          <DropdownMenuItem className="flex-1 text-xs text-muted-foreground" render={<Link href={settingsHref('models')} />}>
            {t('manage')}<ChevronRight />
          </DropdownMenuItem>
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label={t('refresh')} aria-busy={refreshing || undefined} data-testid="bot-model-refresh" onClick={() => { void refresh() }} />}>
              <RefreshCw className={cn(refreshing && 'animate-spin motion-reduce:animate-none')} />
            </TooltipTrigger>
            <TooltipContent side="top">{t('refresh')}</TooltipContent>
          </Tooltip>
        </div>
      </DropdownMenuGroup>
    </DropdownMenuContent>
  </DropdownMenu>
}

type Entry = { option: BotModelMenuOption; vendor: ModelVendor | 'mikka'; sources: string[] }
const VENDOR_ORDER: (ModelVendor | 'mikka')[] = ['anthropic', 'openai', 'google', 'deepseek', 'moonshot', 'alibaba', 'zhipu', 'mistral', 'meta', 'xai', 'other', 'mikka']
const VENDOR_NAMES: Record<ModelVendor | 'mikka', string> = { anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google', deepseek: 'DeepSeek', moonshot: 'Moonshot', alibaba: 'Qwen', zhipu: 'Zhipu', mistral: 'Mistral', meta: 'Meta', xai: 'xAI', other: '…', mikka: 'Mikka' }
const EFFORTS = ['auto', 'low', 'medium', 'high', 'xhigh'] as const

/** The source a menu option's model comes from, for 启用的模型 (design prototype: fixture and key ids carry it). */
function sourceOf(option: BotModelMenuOption, group: BotModelMenuGroup): { id: string; kind: 'subscription' | 'api_key' } | null {
  const key = parseApiKeyOption(option.id)
  if (key) return { id: key.keyId, kind: 'api_key' }
  const fixture = /^fixture:([0-9a-f-]{36}):/i.exec(option.id)
  if (fixture) return { id: fixture[1], kind: 'subscription' }
  return null
}

/**
 * Vendor first (design 2026-11-06, docs/design/enabled-models/full): vendors on the left, that vendor's
 * enabled models on the right, each saying which source a run takes; the chosen one opens 思考强度.
 * One model from several sources is listed once; the first source in the list order runs it.
 */
function VendorMenu({ t, groups, value, onChoose }: { t: T; groups: BotModelMenuGroup[]; value: string; onChoose: (id: string) => void }) {
  const store = useEnabledModels()
  const [effort, setEffort] = useState<typeof EFFORTS[number]>('medium')
  const catalogues = new Map<string, string[]>()
  for (const group of groups) for (const option of group.options) { const source = sourceOf(option, group); if (source) catalogues.set(source.id, [...(catalogues.get(source.id) ?? []), option.modelId]) }
  const entries = new Map<string, Entry>()
  for (const group of groups) for (const option of group.options) {
    const source = sourceOf(option, group)
    if (source && !store.isEnabled(source.id, source.kind, catalogues.get(source.id) ?? [], option.modelId)) continue
    const vendor = option.id === HOSTED_CHOICE ? 'mikka' : modelVendor(option.modelId)
    const key = option.id === HOSTED_CHOICE ? HOSTED_CHOICE : `${vendor}:${modelDisplayName(option.modelId).name}`
    const existing = entries.get(key)
    if (existing) existing.sources.push(heading(t, group))
    else entries.set(key, { option, vendor, sources: [heading(t, group)] })
  }
  const all = [...entries.values()]
  const vendors = VENDOR_ORDER.filter(vendor => all.some(entry => entry.vendor === vendor))
  const chosen = all.find(entry => entry.option.id === value)
  const [vendor, setVendor] = useState<ModelVendor | 'mikka'>(chosen?.vendor ?? vendors[0] ?? 'anthropic')
  const shown = groupByModelFamily(all.filter(entry => entry.vendor === vendor), entry => entry.option.modelId)
  return <div className="flex min-h-56" data-slot="vendor-model-menu">
    <div role="tablist" aria-label={t('vendors')} className="flex flex-col gap-1 border-r border-border p-1.5">
      {vendors.map(item => <Tooltip key={item}>
        <TooltipTrigger render={<Button type="button" role="tab" variant="ghost" size="icon-sm" aria-selected={item === vendor} aria-label={VENDOR_NAMES[item]}
          className={cn(item === vendor && 'bg-muted')} onClick={() => setVendor(item)} />}>
          {item === 'anthropic' ? <ProviderMark provider="claude" /> : item === 'openai' ? <ProviderMark provider="openai" /> : item === 'mikka' ? <HostedModelLabel name="" />
            : <span aria-hidden="true" className="flex size-4 items-center justify-center rounded-sm bg-muted-foreground/20 text-xs font-semibold">{VENDOR_NAMES[item].charAt(0)}</span>}
        </TooltipTrigger>
        <TooltipContent side="left">{VENDOR_NAMES[item]}</TooltipContent>
      </Tooltip>)}
    </div>
    <DropdownMenuGroup className="flex min-w-0 flex-1 flex-col p-1">
    <DropdownMenuLabel className="font-normal">{VENDOR_NAMES[vendor]}</DropdownMenuLabel>
    <DropdownMenuRadioGroup value={value} onValueChange={id => onChoose(String(id))} className="flex flex-col">
      {shown.map(entry => {
        const selected = entry.option.id === value
        const route = entry.sources.length > 1 ? t('routeMore', { source: entry.sources[0], other: entry.sources.slice(1).join('、') }) : t('route', { source: entry.sources[0] })
        return <div key={entry.option.id} className="flex items-center gap-1">
          <DropdownMenuRadioItem value={entry.option.id} closeOnClick className="min-w-0 flex-1 items-start py-1.5">
            <span className="flex min-w-0 flex-col">
              {entry.option.id === HOSTED_CHOICE ? <span>{t('hosted')}</span> : <span className="truncate" title={entry.option.modelId}>{modelDisplayName(entry.option.modelId).name}</span>}
              <span className="truncate text-xs text-muted-foreground">{route}</span>
            </span>
          </DropdownMenuRadioItem>
          {selected && entry.option.id !== HOSTED_CHOICE && <DropdownMenuSub>
            <DropdownMenuSubTrigger className="shrink-0 gap-1 text-xs text-muted-foreground" aria-label={t('effort')}>{t(`efforts.${effort}`)}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuGroup>
                <DropdownMenuLabel className="font-normal">{t('effort')}</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={effort} onValueChange={next => setEffort(next as typeof EFFORTS[number])}>
                  {EFFORTS.map(level => <DropdownMenuRadioItem key={level} value={level}>{t(`efforts.${level}`)}</DropdownMenuRadioItem>)}
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>}
        </div>
      })}
    </DropdownMenuRadioGroup>
    </DropdownMenuGroup>
  </div>
}
