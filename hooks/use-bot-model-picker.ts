'use client'

import { useEffect, useRef, useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { chooseBotModel, getBotModelMenu, refreshBotModelMenuAction } from '@/app/actions/execution-settings'
import { HOSTED_CHOICE, withChosenModel, type BotModelMenu, type BotModelMenuGroup, type BotModelMenuOption } from '@/lib/bot-model-menu-view'

export type ModelPickerT = ReturnType<typeof useTranslations<'Coordinator.modelPicker'>>

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

/** A menu group's heading: Mikka, the subscription's plan, or the key it bills. */
export function modelGroupHeading(t: ModelPickerT, group: BotModelMenuGroup) {
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
export function modelGroupTag(t: ModelPickerT, group: BotModelMenuGroup) {
  switch (group.kind) {
    // The points it can spend in this chat's workspace, not the person's elsewhere (decision 2026-11-02-1450).
    case 'hosted': return group.hostedSource === 'cloud' ? t('cloudCredits') : group.hostedSource === 'self-hosted' ? t('ownProvider') : group.trialLeft !== undefined ? t('trialLeft', { count: group.trialLeft }) : group.points === undefined ? t('credits') : t('points', { points: group.points })
    case 'apiKey': return t('metered')
    case 'shared': return group.owner ? t('sharedKey', { name: group.owner }) : null
    default: return null
  }
}

export type ChipModel = Pick<BotModelMenuOption, 'id' | 'modelId' | 'provider'>

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

/**
 * Everything a bot's model chip does, for the model-picker slot to draw
 * (docs/ui-overlay.md, decision 2026-10-31-2330): the menu of what this person
 * can use here, the saved choice per bot, refresh on open, and the chip it
 * showed last while the menu loads. A run already going keeps its model.
 */
export function useBotModelPicker(botId: string | null) {
  const t = useTranslations('Coordinator.modelPicker')
  const menu = useSWR<BotModelMenu>(botModelMenuKey(botId), () => getBotModelMenu(botId))
  const [failed, setFailed] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshFailed, setRefreshFailed] = useState(false)
  const [open, setOpenState] = useState(false)
  const [last, setLast] = useState<ChipModel | null>(null)

  /** 刷新模型列表: the menu keeps what it shows until the new list arrives, and stays open. */
  async function refresh() {
    if (refreshing) return
    setRefreshing(true)
    setRefreshFailed(false)
    try {
      await menu.mutate(() => refreshBotModelMenuAction(botId), { populateCache: true, revalidate: false })
    } catch { setRefreshFailed(true) } finally { setRefreshing(false) }
  }

  useEffect(() => {
    const listener = (event: Event) => { if ((event as CustomEvent<string>).detail === (botId ?? 'coordinator')) { setOpenState(true); void refresh() } }
    window.addEventListener(OPEN_EVENT, listener)
    return () => window.removeEventListener(OPEN_EVENT, listener)
  })

  // The menu this bot showed last stays on screen while a read is under way, so the chip never drops out and comes
  // back. Another bot's menu is never held over: its chip waits for its own.
  const held = useRef<{ botId: string | null; menu: BotModelMenu } | null>(null)
  if (menu.data) held.current = { botId, menu: menu.data }
  const data = menu.data ?? (!menu.error && held.current?.botId === botId ? held.current.menu : undefined)
  const shown = data?.current
  useEffect(() => {
    const key = lastChipKey(botId)
    try {
      if (shown) window.localStorage.setItem(key, JSON.stringify({ id: shown.id, modelId: shown.modelId, provider: shown.provider }))
      else if (menu.error) window.localStorage.removeItem(key)
      else setLast(readChip(window.localStorage.getItem(key)))
    } catch { /* storage unavailable: the chip waits for the menu */ }
  }, [botId, shown, menu.error])

  async function choose(id: string) {
    const current = data?.current
    if (!current || (id === current.id && current.chosen)) return
    setFailed(false)
    try {
      // The chip and the check mark move at once; the server's answer then replaces the guess. A pick that is not
      // saved comes back as `{ error }`: failing here rolls the chip back and shows 未保存.
      const picked = menu.data ? withChosenModel(menu.data, id) : null
      await menu.mutate(async () => {
        const { error, ...saved } = await chooseBotModel(botId, id)
        if (error) throw new Error(error)
        return saved as BotModelMenu
      }, { ...(picked ? { optimisticData: picked } : {}), rollbackOnError: true, populateCache: true, revalidate: false })
    } catch { setFailed(true) }
  }

  /** What a person reads for an option: the hosted model's name, or the provider's id (callers format it). */
  const optionName = (option: ChipModel) => option.id === HOSTED_CHOICE ? t('hosted') : option.modelId || t('unknownModel')

  const current = data?.current
  const checking = current?.availability === 'checking'
  const chipLabel = current ? [optionName(current), current.fallback ? t('fallback') : null, checking ? t('checking') : null].filter(Boolean).join(' · ') : null

  return {
    t,
    /** The menu, once it has arrived; until then `last` is the chip's look only, not a control. */
    menu: data,
    /** Someone else's bot, or the menu failed: no chip at all. */
    error: !!menu.error,
    last: data || menu.error ? null : last,
    open,
    /** Opening the menu refreshes it. */
    setOpen(next: boolean) { setOpenState(next); if (next) void refresh() },
    choose,
    /** Choosing the item that is already current only saves when it was not chosen yet (it was the default). */
    chooseItem(id: string) { if (current && id === current.id && !current.chosen) void choose(id) },
    refresh,
    refreshing,
    refreshFailed,
    /** The last pick did not save; the chip rolled back. */
    failed,
    checking,
    unavailable: !!current && !current.available && !checking,
    chipLabel,
    optionName,
    heading: (group: BotModelMenuGroup) => modelGroupHeading(t, group),
    tag: (group: BotModelMenuGroup) => modelGroupTag(t, group),
  }
}

export type BotModelPickerState = ReturnType<typeof useBotModelPicker>
