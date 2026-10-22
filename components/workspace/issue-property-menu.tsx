'use client'

import type { LucideIcon, LucideProps } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Check } from 'lucide-react'
import { BadgeButton } from '@/components/reui/badge'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { statusDots, statusTones, type StatusTone } from '@/lib/status-appearance'

export function IssuePropertyMenu({ label, value, options, disabled, onChange }: {
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
  return <DropdownMenu>
    <DropdownMenuTrigger render={<BadgeButton disabled={disabled} variant="outline" size="xl" className={cn('cursor-pointer px-2 py-0.5 hover:brightness-95', statusTones[option?.tone ?? 'neutral'])} aria-label={t('propertyValue', { label, value: option?.label ?? value })} />}>
      {option?.label ?? value}
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="w-48">
      <DropdownMenuGroup>
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        {options.map(item => <DropdownMenuItem key={item.value} onClick={() => { if (item.value !== value) onChange(item.value) }}>
          <span aria-hidden="true" className={cn('size-2.5 shrink-0 rounded-full', statusDots[item.tone ?? 'neutral'])} />
          <span className="flex-1">{item.label}</span>
          {item.value === value && <Check aria-label={t('selected')} />}
        </DropdownMenuItem>)}
      </DropdownMenuGroup>
    </DropdownMenuContent>
  </DropdownMenu>
}
