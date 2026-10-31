'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { chooseBotModel, getBotModelMenu } from '@/app/actions/execution-settings'
import { Link } from '@/i18n/navigation'
import { settingsHref } from '@/lib/settings-sections'
import { InputGroupButton } from '@/components/ui/input-group'
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

function providerName(provider: string | undefined) {
  return provider === 'claude' ? 'Claude' : 'ChatGPT'
}

function heading(t: T, group: BotModelMenuGroup) {
  switch (group.kind) {
    case 'hosted': return 'Mikka'
    // The plan names it (Claude Max, ChatGPT Pro): everything but a share is the person's own (Figma 756:5189).
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

function OptionLabel({ t, option }: { t: T; option: Pick<BotModelMenuOption, 'id' | 'modelId' | 'provider'> }) {
  return option.id === HOSTED_CHOICE ? <HostedModelLabel name={t('hosted')} /> : <ModelLabel model={option.modelId || t('unknownModel')} source={option.provider} />
}

/**
 * The model chip in a bot's composer, the Coordinator's included (decision
 * 2026-10-31-2330, Figma 756:5189): the model the bot's next runs use, and a
 * menu of what this person can use here. The choice is saved per bot; a run
 * already going keeps its model.
 */
export function BotModelPicker({ botId }: { botId: string | null }) {
  const t = useTranslations('Coordinator.modelPicker')
  const menu = useSWR<BotModelMenu>(botModelMenuKey(botId), () => getBotModelMenu(botId), { revalidateOnFocus: true })
  const [failed, setFailed] = useState(false)
  // Someone else's bot, or no menu yet: the chip is left out rather than shown wrong.
  if (!menu.data) return null
  const { current, groups } = menu.data
  const value = current.available ? current.id : ''

  async function choose(id: string) {
    if (id === value) return
    setFailed(false)
    try {
      await menu.mutate(() => chooseBotModel(botId, id), {
        optimisticData: data => {
          const option = data!.groups.flatMap(group => group.options.map(item => ({ ...item, kind: group.kind }))).find(item => item.id === id)
          return option ? { ...data!, current: { ...option, chosen: true, available: true } } : data!
        },
        rollbackOnError: true, populateCache: true, revalidate: false,
      })
    } catch { setFailed(true) }
  }

  const name = current.id === HOSTED_CHOICE ? t('hosted') : current.modelId || t('unknownModel')
  return <DropdownMenu>
    <DropdownMenuTrigger render={<InputGroupButton type="button" variant="secondary" size="xs" data-testid="bot-model-chip" data-unavailable={!current.available || undefined}
      className={cn('max-w-56 rounded-full px-2 font-normal', current.available ? 'text-foreground' : 'text-muted-foreground')}
      aria-label={current.available ? t('label', { name }) : t('labelUnavailable', { name })} />}>
      <span className="flex min-w-0"><OptionLabel t={t} option={current} /></span>
      {!current.available && <span className="shrink-0 text-xs">{t('unavailable')}</span>}
      {failed && <span className="shrink-0 text-xs text-destructive">{t('notSaved')}</span>}
      <ChevronDown className="text-muted-foreground" />
    </DropdownMenuTrigger>
    <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-80">
      <DropdownMenuRadioGroup value={value} onValueChange={id => { void choose(String(id)) }}>
        {groups.map((group, index) => <DropdownMenuGroup key={`${group.kind}-${index}`} data-group={group.kind}>
          {/* Figma 756:5189: a rule under Mikka 默认 only; the person's own groups follow one another under their headings. */}
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
        <DropdownMenuItem className="text-xs text-muted-foreground" render={<Link href={settingsHref('models')} />}>
          {t('manage')}<ChevronRight />
        </DropdownMenuItem>
      </DropdownMenuGroup>
    </DropdownMenuContent>
  </DropdownMenu>
}
