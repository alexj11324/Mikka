'use client'

import type { LucideIcon, LucideProps } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Check, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

export function IssuePropertyMenu({ label, value, options, icon: Icon, disabled, pill = false, compact = false, iconOnly = false, displayValue, onChange }: {
  label: string
  value: string
  options: readonly { value: string; label: string; icon?: LucideIcon; iconProps?: Pick<LucideProps, 'viewBox' | 'strokeWidth'>; indicatorClassName?: string }[]
  icon: LucideIcon
  disabled?: boolean
  pill?: boolean
  compact?: boolean
  iconOnly?: boolean
  displayValue?: string
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
  const valueLabel = option ? optionLabel(option) : value
  const ValueIcon = option?.icon ?? Icon
  return <DropdownMenu>
    <DropdownMenuTrigger render={<Button type="button" variant={pill ? 'outline' : 'ghost'} size={iconOnly ? compact ? 'icon-compact' : 'icon-sm' : compact ? 'xs' : 'sm'} className={cn(pill && 'rounded-full', iconOnly && !pill && '-ml-1')} disabled={disabled} title={t('propertyValue', { label, value: valueLabel })} aria-label={t('propertyValue', { label, value: valueLabel })} />}>
      <ValueIcon {...option?.iconProps} data-icon="inline-start" className={cn({
        'text-muted-foreground': option?.indicatorClassName === 'text-muted-foreground',
        'text-warning-foreground': option?.indicatorClassName === 'text-warning-foreground',
        'text-success-foreground': option?.indicatorClassName === 'text-success-foreground',
        'text-info-foreground': option?.indicatorClassName === 'text-info-foreground',
      })} />{!iconOnly && (displayValue ?? valueLabel)}{!iconOnly && !pill && !compact && <ChevronDown data-icon="inline-end" />}
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="w-48">
      <DropdownMenuGroup>
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        {options.map(item => <DropdownMenuItem key={item.value} onClick={() => { if (item.value !== value) onChange(item.value) }}>
          {item.icon && <item.icon {...item.iconProps} className={cn({
            'text-muted-foreground': item.indicatorClassName === 'text-muted-foreground',
            'text-warning-foreground': item.indicatorClassName === 'text-warning-foreground',
            'text-success-foreground': item.indicatorClassName === 'text-success-foreground',
            'text-info-foreground': item.indicatorClassName === 'text-info-foreground',
          })} />}          <span className="flex-1">{optionLabel(item)}</span>{item.value === value && <Check aria-label={t('selected')} />}

        </DropdownMenuItem>)}
      </DropdownMenuGroup>
    </DropdownMenuContent>
  </DropdownMenu>
}
