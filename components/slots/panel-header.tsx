'use client'

// The default panel-header slot (docs/ui-overlay.md): the header row of a bot's 概览 and of a group's panel as the
// community layer draws them. 概览: its actions, ⤢ and ✕ at the end, no title. A group: 详情 as a pill, then ✕.
import { useTranslations } from 'next-intl'
import { Maximize2, Minimize2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { PanelHeaderProps } from './panel-header-contract'

/**
 * The right column's default width from the width of the area right of the left sidebar, for a layer that sizes it;
 * null keeps the column's own default (usePanelInitialWidth, hooks/use-panel-width.ts). Optional export.
 */
export const PANEL_INITIAL_WIDTH: ((mainWidth: number) => number) | null = null

export function PanelHeader({ variant, title, actions, widen, onClose }: PanelHeaderProps) {
  const t = useTranslations('Shell.panel')
  const close = <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" className={cn(variant === 'group' && 'ml-auto')} aria-label={t('close')} onClick={onClose} />}><X data-icon="inline-start" /></TooltipTrigger><TooltipContent>{t('close')}</TooltipContent></Tooltip>
  if (variant === 'group') return <div className="flex h-11 shrink-0 items-center gap-1 px-3">
    <p className="flex h-7 items-center rounded-full bg-muted px-2.5 text-sm">{title}</p>
    {close}
  </div>
  return <div className="flex h-11 shrink-0 items-center gap-1 px-3">
    <div className="ml-auto flex items-center">
      {actions.map(({ id, label, icon: Icon, onSelect, pressed }) => <Tooltip key={id}><TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={label} aria-pressed={pressed} onClick={onSelect} />}><Icon data-icon="inline-start" /></TooltipTrigger><TooltipContent>{label}</TooltipContent></Tooltip>)}
      {widen && <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={widen.wide ? t('narrow') : t('widen')} aria-pressed={widen.wide} onClick={widen.onToggle} />}>{widen.wide ? <Minimize2 data-icon="inline-start" /> : <Maximize2 data-icon="inline-start" />}</TooltipTrigger><TooltipContent>{widen.wide ? t('narrow') : t('widen')}</TooltipContent></Tooltip>}
      {close}
    </div>
  </div>
}
