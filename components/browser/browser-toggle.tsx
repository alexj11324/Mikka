'use client'

import { Globe } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/** The top bar's globe (Figma 412:8066): icon only, opens and closes the app-wide browser column. */
export function BrowserToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const t = useTranslations('Browser')
  return <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t('label')} aria-pressed={open} onClick={onToggle}
    className={cn('hidden text-muted-foreground lg:inline-flex', open && 'bg-muted text-foreground')} />}><Globe data-icon="inline-start" /></TooltipTrigger><TooltipContent side="bottom">{t('label')}</TooltipContent></Tooltip>
}
