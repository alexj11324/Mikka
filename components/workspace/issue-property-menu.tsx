'use client'

import type { ReactNode } from 'react'
import type { LucideIcon, LucideProps } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Check } from 'lucide-react'
import { BadgeButton } from '@/components/reui/badge'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { ROW_VALUE } from './issue-property-row'
import { statusDots, statusIconTints, statusTones, type StatusTone } from '@/lib/status-appearance'

export function IssuePropertyMenu({ label, value, options, icon: FallbackIcon, disabled, iconOnly = false, variant = 'badge', displayValue, renderIcon, onChange }: {
  label: string
  value: string
  options: readonly { value: string; label: string; icon?: LucideIcon; iconProps?: Pick<LucideProps, 'viewBox' | 'strokeWidth'>; indicatorClassName?: string; tone?: StatusTone }[]
  icon: LucideIcon
  disabled?: boolean
  pill?: boolean
  compact?: boolean
  iconOnly?: boolean
  /** row: an icon and the value on a ghost button, for the detail page's properties column. */
  variant?: 'badge' | 'row'
  displayValue?: string
  /** iconOnly: draws the value's mark instead of its lucide icon (the board card's priority bars). */
  renderIcon?: (value: string) => ReactNode
  onChange: (value: string) => void
}) {
  const t = useTranslations('Common')
  const i18nText = useTranslations()
  const option = options.find(item => item.value === value)
  const optionLabel = (item: typeof options[number]) => {
    const statusKey = `Issue.status.${item.value}`
    if (i18nText.has(statusKey as never)) return i18nText(statusKey as never)
    const priorityKey = `Issue.priority.${item.value}`
    if (i18nText.has(priorityKey as never)) return i18nText(priorityKey as never)
    return item.label
  }
  const valueLabel = displayValue ?? (option ? optionLabel(option) : value)
  const ValueIcon = option?.icon ?? FallbackIcon
  const tintTone = optionTint(option)
  return <DropdownMenu>
    {/* iconOnly: just the value's own icon (board cards), the name stays in the menu and the tooltip. */}
    {iconOnly ? <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" disabled={disabled} className="size-5 rounded-sm text-muted-foreground" title={valueLabel} aria-label={t('propertyValue', { label, value: valueLabel })} />}>
      {renderIcon ? renderIcon(value) : <ValueIcon data-icon="inline-start" className={cn('size-3.5 shrink-0', statusIconTints[tintTone])} {...option?.iconProps} />}
    </DropdownMenuTrigger> : variant === 'row' ? <DropdownMenuTrigger render={<Button variant="ghost" size="sm" disabled={disabled} className={ROW_VALUE} aria-label={t('propertyValue', { label, value: valueLabel })} />}>
      <ValueIcon data-icon="inline-start" className={cn('shrink-0', statusIconTints[tintTone])} {...option?.iconProps} />
      <span className="truncate">{valueLabel}</span>
    </DropdownMenuTrigger> : <DropdownMenuTrigger render={<BadgeButton disabled={disabled} variant="outline" size="xl" className={cn('cursor-pointer px-2 py-0.5 hover:brightness-95', statusTones[tintTone])} aria-label={t('propertyValue', { label, value: valueLabel })} />}>
      {valueLabel}
    </DropdownMenuTrigger>}
    <DropdownMenuContent align="start" className="w-48">
      <DropdownMenuGroup>
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        {options.map(item => <DropdownMenuItem key={item.value} onClick={() => { if (item.value !== value) onChange(item.value) }}>
          <OptionMark item={item} renderIcon={renderIcon} />
          <span className="flex-1">{optionLabel(item)}</span>
          {item.value === value && <Check aria-label={t('selected')} />}
        </DropdownMenuItem>)}
      </DropdownMenuGroup>
    </DropdownMenuContent>
  </DropdownMenu>
}

type MenuOption = { value: string; icon?: LucideIcon; iconProps?: Pick<LucideProps, 'viewBox' | 'strokeWidth'>; indicatorClassName?: string; tone?: StatusTone }

/** Statuses carry their color; priorities stay grey, as their bars already say how urgent (R-34). */
function optionTint(option: MenuOption | undefined): StatusTone {
  return option?.indicatorClassName ? option.tone ?? 'neutral' : 'neutral'
}

/** A menu row's mark is the same one the trigger, board card and properties draw: the status icon or the priority bars; a dot only for values without an icon (label colours). */
function OptionMark({ item, renderIcon }: { item: MenuOption; renderIcon?: (value: string) => ReactNode }) {
  if (renderIcon) return <span aria-hidden="true" className="flex shrink-0">{renderIcon(item.value)}</span>
  if (item.icon) { const Icon = item.icon; return <Icon aria-hidden="true" className={cn('shrink-0', statusIconTints[optionTint(item)])} {...item.iconProps} /> }
  return <span aria-hidden="true" className={cn('size-2.5 shrink-0 rounded-full', statusDots[item.tone ?? 'neutral'])} />
}
