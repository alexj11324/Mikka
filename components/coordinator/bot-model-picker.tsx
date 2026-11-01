'use client'

import { useEffect, useState } from 'react'
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
  DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { HostedModelLabel, ModelLabel } from '@/components/labels/entity-labels'
import { HOSTED_CHOICE, type BotModelMenu, type BotModelMenuGroup, type BotModelMenuOption } from '@/lib/bot-model-menu-view'
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
  switch (group.kind) {
    case 'hosted': return 'Mikka'
    // The plan names it (Claude Max, ChatGPT Pro): everything but a share is the person's own (decision 2026-10-31-2330).
    case 'subscription': return group.plan ? `${providerName(group.provider)} ${group.plan}` : providerName(group.provider)
    case 'apiKey': return t('apiKey')
    case 'shared': return t('shared')
  }
}

/** What sits at the right of an item: who pays for it. A subscription item has none. */
function tag(t: T, group: BotModelMenuGroup) {
  switch (group.kind) {
    case 'hosted': return t('credits')
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
export function BotModelPicker({ botId }: { botId: string | null }) {
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
  if (!menu.data) return last && !menu.error ? <span role="status" aria-busy="true" data-testid="bot-model-chip-pending" aria-label={t('label', { name: last.id === HOSTED_CHOICE ? t('hosted') : last.modelId || t('unknownModel') })}
    className="inline-flex h-6 max-w-56 shrink-0 items-center gap-1 rounded-full bg-control px-2 text-sm whitespace-nowrap text-foreground [&_svg]:shrink-0 [&>svg]:size-3.5">
    <span className="flex min-w-0"><OptionLabel t={t} option={last} /></span>
    <ChevronDown className="text-muted-foreground" />
  </span> : null
  const { current, groups } = menu.data
  const value = current.available ? current.id : ''

  async function choose(id: string) {
    if (id === value) return
    setFailed(false)
    try {
      // A pick that is not saved comes back as `{ error }`: failing here rolls the chip back and shows 未保存.
      await menu.mutate(async () => {
        const { error, ...saved } = await chooseBotModel(botId, id)
        if (error) throw new Error(error)
        return saved as BotModelMenu
      }, {
        optimisticData: data => {
          const option = data!.groups.flatMap(group => group.options.map(item => ({ ...item, kind: group.kind }))).find(item => item.id === id)
          return option ? { ...data!, current: { ...option, chosen: true, available: true } } : data!
        },
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

  const name = current.id === HOSTED_CHOICE ? t('hosted') : current.modelId || t('unknownModel')
  return <DropdownMenu open={open} onOpenChange={next => { setOpen(next); if (next) void refresh() }}>
    <DropdownMenuTrigger render={<InputGroupButton type="button" variant="secondary" size="xs" data-testid="bot-model-chip" data-unavailable={!current.available || undefined}
      className={cn('max-w-56 rounded-full px-2 font-normal', current.available ? 'text-foreground' : 'text-muted-foreground')}
      aria-label={current.available ? t('label', { name }) : t('labelUnavailable', { name })} />}>
      <span className="flex min-w-0"><OptionLabel t={t} option={current} /></span>
      {!current.available && <span className="shrink-0 text-xs">{t('unavailable')}</span>}
      {failed && <span className="shrink-0 text-xs text-destructive">{t('notSaved')}</span>}
      <ChevronDown className="text-muted-foreground" />
    </DropdownMenuTrigger>
    <DropdownMenuContent side="top" align="start" className="w-80">
      <DropdownMenuRadioGroup value={value} onValueChange={id => { void choose(String(id)) }}>
        {groups.map((group, index) => <DropdownMenuGroup key={`${group.kind}-${index}`} data-group={group.kind}>
          {/* A rule under Mikka 默认 only; the person's own groups follow one another under their headings. */}
          {index === 1 && <DropdownMenuSeparator />}
          <DropdownMenuLabel className="font-normal">{heading(t, group)}</DropdownMenuLabel>
          {group.options.map(option => <DropdownMenuRadioItem key={option.id} value={option.id} closeOnClick>
            <OptionLabel t={t} option={option} />
            {tag(t, group) && <span className="ml-auto shrink-0 pl-3 text-xs text-muted-foreground">{tag(t, group)}</span>}
          </DropdownMenuRadioItem>)}
        </DropdownMenuGroup>)}
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        {refreshFailed && <DropdownMenuItem closeOnClick={false} className="text-xs text-destructive" onClick={() => { void refresh() }}>{t('refreshFailed')}</DropdownMenuItem>}
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
