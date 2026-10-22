'use client'

import type { LucideIcon, LucideProps } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Check, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { statusDots, type StatusTone } from '@/lib/status-appearance'

export function IssuePropertyMenu({ label, value, options, icon: Icon, disabled, pill = false, compact = false, iconOnly = false, displayValue, onChange }: {
  label: string
  value: string
  options: readonly { value: string; label: string; icon?: LucideIcon; iconProps?: Pick<LucideProps, 'viewBox' | 'strokeWidth'>; indicatorClassName?: string; tone?: StatusTone }[]
  icon: LucideIcon
  disabled?: boolean
  pill?: boolean
  compact?: boolean
  iconOnly?: boolean
  displayValue?: string
  onChange: (value: string) => void
}) {
  const t = useTranslations('Common')
  const option = options.find(item => item.value === value)
  const ValueIcon = option?.icon ?? Icon
  return <DropdownMenu>
    <DropdownMenuTrigger render={<Button type="button" variant={pill ? 'outline' : 'ghost'} size={iconOnly ? compact ? 'icon-compact' : 'icon-sm' : compact ? 'xs' : 'sm'} tone={option?.tone} className={cn(pill && !option?.tone && 'rounded-full', iconOnly && !pill && '-ml-1')} disabled={disabled} title={t('propertyValue', { label, value: option?.label ?? value })} aria-label={t('propertyValue', { label, value: option?.label ?? value })} />}>
      <ValueIcon {...option?.iconProps} data-icon="inline-start" className={cn(!option?.tone && {
        'text-muted-foreground': option?.indicatorClassName === 'text-muted-foreground',
        'text-warning-foreground': option?.indicatorClassName === 'text-warning-foreground',
        'text-success-foreground': option?.indicatorClassName === 'text-success-foreground',
        'text-info-foreground': option?.indicatorClassName === 'text-info-foreground',
      })} />{!iconOnly && (displayValue ?? option?.label ?? value)}{!iconOnly && !pill && !compact && <ChevronDown data-icon="inline-end" />}
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="w-48">
      <DropdownMenuGroup>
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        {options.map(item => <DropdownMenuItem key={item.value} onClick={() => { if (item.value !== value) onChange(item.value) }}>
          {item.tone ? <span aria-hidden="true" className={cn('size-2.5 shrink-0 rounded-full', statusDots[item.tone])} /> : item.icon && <item.icon {...item.iconProps} className={cn({
            'text-muted-foreground': item.indicatorClassName === 'text-muted-foreground',
            'text-warning-foreground': item.indicatorClassName === 'text-warning-foreground',
            'text-success-foreground': item.indicatorClassName === 'text-success-foreground',
            'text-info-foreground': item.indicatorClassName === 'text-info-foreground',
          })} />}<span className="flex-1">{item.label}</span>{item.value === value && <Check aria-label={t('selected')} />}
        </DropdownMenuItem>)}
      </DropdownMenuGroup>
    </DropdownMenuContent>
  </DropdownMenu>
}
