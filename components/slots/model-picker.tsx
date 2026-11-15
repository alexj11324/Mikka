'use client'

// The default model-picker slot (docs/ui-overlay.md): the model chip in a bot's composer, the Coordinator's included.
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react'
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
import { HOSTED_CHOICE } from '@/lib/bot-model-menu-view'
import { useBotModelPicker, type ChipModel, type ModelPickerT } from '@/hooks/use-bot-model-picker'
import type { BotModelPickerProps } from '@/components/slots/model-picker-contract'
import { cn } from '@/lib/utils'

function OptionLabel({ t, option }: { t: ModelPickerT; option: ChipModel }) {
  return option.id === HOSTED_CHOICE ? <HostedModelLabel name={t('hosted')} /> : <ModelLabel model={option.modelId || t('unknownModel')} source={option.provider} />
}

/**
 * The model chip in a bot's composer, the Coordinator's included (decision
 * 2026-10-31-2330): the model the bot's next runs use, and a
 * menu of what this person can use here. The choice is saved per bot; a run
 * already going keeps its model.
 */
export function BotModelPicker({ botId, running = false, thread }: BotModelPickerProps) {
  const picker = useBotModelPicker(botId, thread)
  const { t, last } = picker
  // Someone else's bot gets no chip; while the menu loads, the chip keeps the model it showed last time (state completeness).
  // It is the chip's look only, not a control, until the menu it opens has arrived.
  if (!picker.menu) return last ? <span role="status" aria-busy="true" data-testid="bot-model-chip-pending" data-next-message={running || undefined} aria-label={t('label', { name: picker.optionName(last) })}
    className="inline-flex h-6 max-w-56 shrink-0 items-center gap-1 rounded-full bg-control px-2 text-sm whitespace-nowrap text-foreground [&_svg]:shrink-0 [&>svg]:size-3.5">
    <span className="flex min-w-0"><OptionLabel t={t} option={last} /></span>
    <ChevronDown className="text-muted-foreground" />
  </span> : null
  const { current, groups } = picker.menu
  const label = picker.chipLabel ?? ''
  return <DropdownMenu open={picker.open} onOpenChange={picker.setOpen}>
    <DropdownMenuTrigger render={<InputGroupButton type="button" variant="secondary" size="xs" data-testid="bot-model-chip" data-unavailable={picker.unavailable || undefined} data-next-message={running || undefined}
      className={cn('max-w-56 rounded-full px-2 font-normal', picker.unavailable ? 'text-muted-foreground' : 'text-foreground')}
      title={label} aria-label={picker.unavailable ? t('labelUnavailable', { name: label }) : t('label', { name: label })} />}>
      <span className="flex min-w-0"><OptionLabel t={t} option={current} /></span>
      {picker.failed && <span className="shrink-0 text-xs text-destructive-foreground">{t('notSaved')}</span>}
      <ChevronDown className="text-muted-foreground" />
    </DropdownMenuTrigger>
    <DropdownMenuContent side="top" align="start" className="w-80">
      <DropdownMenuRadioGroup value={current.id} onValueChange={id => { void picker.choose(String(id)) }}>
        {groups.map((group, index) => <DropdownMenuGroup key={`${group.kind}-${index}`} data-group={group.kind}>
          {/* A rule under Mikka 默认 only; the person's own groups follow one another under their headings. */}
          {index === 1 && <DropdownMenuSeparator />}
          <DropdownMenuLabel className="truncate font-normal" title={picker.heading(group)}>{picker.heading(group)}</DropdownMenuLabel>
          {group.options.map(option => <DropdownMenuRadioItem key={option.id} value={option.id} closeOnClick onClick={() => picker.chooseItem(option.id)}>
            <OptionLabel t={t} option={option} />
            {picker.tag(group) && <span className="ml-auto shrink-0 pl-3 text-xs text-muted-foreground">{picker.tag(group)}</span>}
          </DropdownMenuRadioItem>)}
        </DropdownMenuGroup>)}
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        {picker.refreshFailed && <DropdownMenuItem closeOnClick={false} className="text-xs text-destructive-foreground" onClick={() => { void picker.refresh() }}>{t('refreshFailed')}</DropdownMenuItem>}
        <div className="flex items-center gap-1">
          <DropdownMenuItem className="flex-1 text-xs text-muted-foreground" render={<Link href={settingsHref('models')} />}>
            {t('manage')}<ChevronRight />
          </DropdownMenuItem>
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label={t('refresh')} aria-busy={picker.refreshing || undefined} data-testid="bot-model-refresh" onClick={() => { void picker.refresh() }} />}>
              <RefreshCw className={cn(picker.refreshing && 'animate-spin motion-reduce:animate-none')} />
            </TooltipTrigger>
            <TooltipContent side="top">{t('refresh')}</TooltipContent>
          </Tooltip>
        </div>
      </DropdownMenuGroup>
    </DropdownMenuContent>
  </DropdownMenu>
}
