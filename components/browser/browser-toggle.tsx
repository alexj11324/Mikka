'use client'

import { useEffect, useState } from 'react'
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

/** Whether the window is wide enough for the browser column (Tailwind `lg`); below that there is no toggle and no column. */
export function useBrowserFits() {
  const [fits, setFits] = useState(false)
  useEffect(() => {
    const query = window.matchMedia('(min-width: 1024px)')
    const update = () => setFits(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return fits
}
