'use client'

import { useViewState } from '@/lib/hooks/view-state'
import { useTranslations } from 'next-intl'
import { ChevronRight } from 'lucide-react'
import { threadStepCounts, type ThreadStep } from '@/lib/issue-run-conversation'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'

/**
 * 「已运行 2 条命令 · 调用了 1 个工具 ›」: the run's tool calls folded into one line that says what happened, as iOS does (#1770);
 * 「执行了 3 步」 when there is nothing to split. No Agent name or mark: the conversation's header says which Agent it is,
 * and an Agent switch has its own divider (Alex 2026-11-09). Opening it lists each call by its internal name (R-40).
 */
export function ThreadSteps({ steps, stateKey = 'steps' }: { steps: readonly ThreadStep[]; stateKey?: string }) {
  const t = useTranslations('IssueThreads')
  const [open, setOpen] = useViewState(`${stateKey}:open`, false)
  const { commands, tools } = threadStepCounts(steps)
  const label = steps.length === 0 ? t('steps', { count: 0 })
    : [commands ? t('stepsCommands', { count: commands }) : null, tools ? t('stepsTools', { count: tools }) : null].filter(Boolean).join(' · ')
  return <Collapsible open={open} onOpenChange={setOpen} className="flex min-w-0 flex-col items-start gap-1">
    <CollapsibleTrigger render={<Button type="button" variant="ghost" size="xs" className="group/steps -ml-2 text-muted-foreground" />}>
      {label}
      <ChevronRight aria-hidden="true" data-icon="inline-end" className="transition-transform group-data-[panel-open]/steps:rotate-90 rtl:rotate-180 rtl:group-data-[panel-open]/steps:rotate-90 motion-reduce:transition-none" />
    </CollapsibleTrigger>
    <CollapsibleContent className="w-full">
      <ol className="ml-1.5 flex flex-col gap-1 border-l border-rule py-0.5 pl-3 text-xs">
        {steps.map(step => <li key={step.id} className="flex min-w-0 items-baseline gap-2">
          <span className={cn('shrink-0 font-mono', step.failed ? 'text-destructive-foreground' : 'text-foreground')}>{step.name}</span>
          {step.detail && <span className="min-w-0 truncate font-mono text-muted-foreground" title={step.detail}>{step.detail}</span>}
        </li>)}
      </ol>
    </CollapsibleContent>
  </Collapsible>
}
