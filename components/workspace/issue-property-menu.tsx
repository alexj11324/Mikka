'use client'

import type { LucideIcon } from 'lucide-react'
import { Check, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

export function IssuePropertyMenu({ label, value, options, icon: Icon, disabled, pill = false, onChange }: {
  label: string
  value: string
  options: readonly { value: string; label: string; icon?: LucideIcon; indicatorClassName?: string }[]
  icon: LucideIcon
  disabled?: boolean
  pill?: boolean
  onChange: (value: string) => void
}) {
  const option = options.find(item => item.value === value)
  const ValueIcon = option?.icon ?? Icon
  return <DropdownMenu>
    <DropdownMenuTrigger render={<Button type="button" variant={pill ? 'outline' : 'ghost'} size="sm" className={pill ? 'rounded-full' : undefined} disabled={disabled} aria-label={`${label}：${option?.label ?? value}`} />}>
      <ValueIcon data-icon="inline-start" className={option?.indicatorClassName} />{option?.label ?? value}{!pill && <ChevronDown data-icon="inline-end" />}
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="w-48">
      <DropdownMenuGroup>
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        {options.map(item => <DropdownMenuItem key={item.value} onClick={() => { if (item.value !== value) onChange(item.value) }}>
          {item.icon && <item.icon className={item.indicatorClassName} />}<span className="flex-1">{item.label}</span>{item.value === value && <Check aria-label="已选中" />}
        </DropdownMenuItem>)}
      </DropdownMenuGroup>
    </DropdownMenuContent>
  </DropdownMenu>
}
