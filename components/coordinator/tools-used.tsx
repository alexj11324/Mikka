'use client'

import { useTranslations } from 'next-intl'
import { ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'

/**
 * The tools a reply used, under the reply: a count by default; the tools'
 * internal names only for whoever opens it (R-40, R-43).
 */
export function ToolsUsed({ tools }: { tools: string[] }) {
  const t = useTranslations('Coordinator')
  return <Collapsible className="flex min-w-0 flex-col items-start gap-1">
    <CollapsibleTrigger render={<Button type="button" variant="ghost" size="xs" className="group/tools -ml-2 text-muted-foreground" />}>
      {t('usedTools', { count: tools.length })}
      <ChevronRight aria-hidden="true" data-icon="inline-end" className="transition-transform group-data-[panel-open]/tools:rotate-90 motion-reduce:transition-none" />
    </CollapsibleTrigger>
    <CollapsibleContent><p className="font-mono font-normal break-all">{tools.join(', ')}</p></CollapsibleContent>
  </Collapsible>
}
