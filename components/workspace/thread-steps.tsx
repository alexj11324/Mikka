'use client'

import { useTranslations } from 'next-intl'
import { ChevronRight } from 'lucide-react'
import type { ThreadStep } from '@/lib/issue-run-conversation'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { HarnessMark } from '@/components/labels/entity-labels'
import { cn } from '@/lib/utils'
import { harnessLabel } from './issue-threads'

/**
 * 「Handed to Claude Code · N steps」: the harness's tool calls folded into one line;
 * opening it lists each call by its internal name, as the Coordinator's ToolsUsed does (R-40).
 */
export function ThreadSteps({ harness, steps }: { harness: string; steps: readonly ThreadStep[] }) {
  const t = useTranslations('IssueThreads')
  return <Collapsible className="flex min-w-0 flex-col items-start gap-1">
    <CollapsibleTrigger render={<Button type="button" variant="ghost" size="xs" className="group/steps -ml-2 text-muted-foreground" />}>
      <ChevronRight aria-hidden="true" data-icon="inline-start" className="transition-transform group-data-[panel-open]/steps:rotate-90 motion-reduce:transition-none" />
      <span aria-hidden="true" className="inline-flex"><HarnessMark harness={harness} /></span>
      {t('steps', { harness: harnessLabel(harness), count: steps.length })}
    </CollapsibleTrigger>
    <CollapsibleContent className="w-full">
      <ol className="ml-1.5 flex flex-col gap-1 border-l border-rule py-0.5 pl-3 text-xs">
        {steps.map(step => <li key={step.id} className="flex min-w-0 items-baseline gap-2">
          <span className={cn('shrink-0 font-mono', step.failed ? 'text-destructive' : 'text-foreground')}>{step.name}</span>
          {step.detail && <span className="min-w-0 truncate font-mono text-muted-foreground" title={step.detail}>{step.detail}</span>}
        </li>)}
      </ol>
    </CollapsibleContent>
  </Collapsible>
}
